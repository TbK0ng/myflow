/**
 * Background-task registry — the on-disk layer behind the four `myflow_bg_*`
 * tools (`myflow_bg_start` / `myflow_bg_output` / `myflow_bg_list` /
 * `myflow_bg_stop`, added in later batches).
 *
 * A *background task* is a command that outlives the session that started it,
 * so its bookkeeping cannot live in memory. Everything is one file per task
 * under `.myflow/.runtime/background/` (the `.runtime` tree is gitignored, the
 * same place `sessions/` and `subagent-logs/` already use):
 *
 *   <taskId>.json   registry entry — written only by the tools (ADR-4)
 *   <taskId>.log    command output — written by `bg_runner.mjs` via the kernel
 *   <taskId>.exit   how the command ended — written by `bg_runner.mjs`
 *   cursors/<contextKey>__<taskId>.json   per-session read cursor (ADR-5)
 *
 * One file per task rather than one shared `tasks.json`: concurrent sessions
 * never write the same file, so there is no lost-update race and no lock. The
 * cost is that `listEntries` reads a directory and parses each file, which is
 * cheap at this scale.
 *
 * This module is deliberately **pure I/O**: no Pi imports, no tool
 * registration, and a *fixed* status precedence (see `resolveStatus`). The
 * tools build on it; it never reaches back into `./index.ts`, which keeps it
 * importable under `node --test` and free of a registration cycle (the same
 * dependency-injection shape `ask.ts` and `approval.ts` use).
 *
 * Known limits, stated honestly (`design.md` §8):
 *   - There is an orphan window: if the tool crashes after spawning the wrapper
 *     but before `writeEntry`, the process runs with no registry entry and
 *     `listEntries` cannot see it. No transactional compensation is attempted.
 *   - A stop that force-kills the wrapper leaves `status: "stopped"` with no
 *     exit code; `exit_code` is therefore nullable everywhere.
 *   - Liveness is `process.kill(pid, 0)`, which can mistake a reused PID for the
 *     original task. Two things outrank it: a present `.exit` record, and an
 *     entry already recorded as `exited`/`stopped` (a finished verdict is
 *     sticky, so a reused pid can neither resurrect a task nor make a stop
 *     kill an unrelated process). The residual risk is narrower: a task whose
 *     pid was reused *before any reader ever observed it* still reads as
 *     running, because nothing on disk records that it died.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { findProjectRoot } from "./find-project-root.ts";

/** The registry directory, relative to a project root. */
export const BACKGROUND_DIR = join(".myflow", ".runtime", "background");

/** The per-session cursor sub-directory, a child of the registry directory. */
export const CURSORS_SUBDIR = "cursors";

/** Separator between a context key and a task id in a cursor file name. */
export const CURSOR_SEPARATOR = "__";

/** Finished tasks older than this are eligible for `prune`. */
export const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * The only four states a task may report. `unknown` is reserved for a registry
 * entry that cannot be trusted (and, in `list`, for a broken file); the tools
 * never resolve to it themselves.
 */
export type BackgroundTaskStatus = "running" | "exited" | "stopped" | "unknown";

/**
 * How the start was confirmed. `ui-confirm` means the user saw and approved the
 * exact command; `no-ui-explicit` means there was no UI and the caller passed
 * `unattended: true`. The second value is a recorded bypass, never a normal
 * path (`design.md` §4.1 / R8).
 */
export type ConfirmedBy = "ui-confirm" | "no-ui-explicit";

/** A registry entry, one per `<taskId>.json` (`design.md` §3.1). */
export interface BackgroundEntry {
  id: string;
  command: string;
  description?: string;
  cwd: string;
  pid: number;
  log: string;
  exit_file: string;
  status: BackgroundTaskStatus;
  exit_code: number | null;
  started_at: string;
  ended_at: string | null;
  started_by_context_key: string | null;
  confirmed_by: ConfirmedBy;
  /**
   * Why the OS could not create the process, when `spawn` failed
   * asynchronously. Set by the `'error'` listener in `myflow_bg_start`; absent
   * on a normal start. A task carrying it is already `exited` with no exit
   * code, which is how a failed start stays diagnosable instead of looking like
   * a bare self-healed exit.
   */
  spawn_error?: string;
  /** Extra fields are tolerated so a newer writer does not break an older reader. */
  [key: string]: unknown;
}

/** The parsed shape of a `<taskId>.exit` record written by `bg_runner.mjs`. */
export interface ExitRecord {
  exit_code: number | null;
  signal?: string | null;
  at?: string;
  error?: string;
  [key: string]: unknown;
}

/** The verdict `resolveStatus` returns. */
export interface ResolvedStatus {
  status: BackgroundTaskStatus;
  exit_code: number | null;
  /**
   * Why the command could not be started, or why it ended abnormally, taken
   * from the `.exit` record's `error` field. Omitted when there is no such
   * reason. This is what keeps a failed start (e.g. the OS refusing to create
   * the process) from looking identical to a normal exit with an unknown code.
   */
  failure?: string;
  /** The signal that terminated the command, from the `.exit` record. Omitted when absent. */
  signal?: string;
}

/** A registry file that could not be read as an entry. Reported, never thrown. */
export interface BackgroundWarning {
  file: string;
  reason: string;
}

/**
 * Seed for the id suffix.
 *
 * The low 16 bits of a per-process counter are the suffix, so two ids minted in
 * the same millisecond within one process are always distinct. The counter is
 * seeded from 2 random bytes so two *processes* minting an id in the same
 * millisecond are unlikely to collide. A pid would be the wrong tool here: the
 * OS reuses pids, and an id must stay unique for the life of the file.
 */
let idSequence = randomBytes(2).readUInt16BE(0);

/**
 * Mint a task id: `bg-<base36 millisecond timestamp>-<4 hex digits>`.
 *
 * `now` is injectable so tests can pin the timestamp; production callers pass
 * nothing. The id is never derived from a pid.
 */
export function newTaskId(now: number = Date.now()): string {
  const stamp = Math.floor(now).toString(36);
  const suffix = (idSequence++ & 0xffff).toString(16).padStart(4, "0");
  return `bg-${stamp}-${suffix}`;
}

/** The registry directory for a project root. */
export function backgroundDir(projectRoot: string): string {
  return join(projectRoot, BACKGROUND_DIR);
}

/** The cursor directory for a registry directory. Created on demand by `writeCursor`. */
export function cursorsDir(backgroundDirectory: string): string {
  return join(backgroundDirectory, CURSORS_SUBDIR);
}

/** `<dir>/<id>.json` — the registry entry path. */
export function entryPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/** `<dir>/<id>.log` — the output path. */
export function logPath(dir: string, id: string): string {
  return join(dir, `${id}.log`);
}

/** `<dir>/<id>.exit` — the conventional exit-record path. */
export function exitPath(dir: string, id: string): string {
  return join(dir, `${id}.exit`);
}

/**
 * Windows can refuse to replace a file that another process currently holds
 * open (`EPERM`/`EACCES`/`EBUSY`) even though the reader only asked for read
 * access. A concurrent `list`/`output` reading the registry is exactly that
 * case, so a rename that fails for one of these transient reasons is retried
 * briefly instead of being reported as a write failure. The wait is bounded by
 * `RENAME_RETRIES * RENAME_RETRY_MS` (1s), the same schedule `bg_runner.mjs`
 * uses for `<id>.exit`.
 */
const RENAME_RETRY_MS = 20;
const RENAME_RETRIES = 50;
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Bounded synchronous sleep; `Atomics.wait` is the portable way to block. */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Test seams for the atomic write. Production callers pass nothing and get the
 * real `rename` plus a real 20ms sleep; a test can inject a rename that fails
 * transiently (to cover the retry loop) or a no-op sleep (to avoid waiting).
 */
export interface AtomicWriteDeps {
  rename?: (from: string, to: string) => void;
  sleep?: (milliseconds: number) => void;
}

/**
 * Write a file atomically: fill a sibling `.tmp`, then rename it into place.
 * A concurrent reader therefore sees the previous contents or the complete new
 * contents, never a half-written file (the same discipline `bg_runner.mjs`
 * applies to `<id>.exit`).
 *
 * The rename is retried for the transient Windows sharing errors above; any
 * other error is thrown immediately, and the `.tmp` is cleaned up either way
 * (D3: a reader holding the registry file must not turn a write-back into a
 * hard failure).
 */
export function writeFileAtomic(path: string, data: string, deps: AtomicWriteDeps = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  const rename = deps.rename ?? renameSync;
  const sleep = deps.sleep ?? sleepSync;
  try {
    writeFileSync(tempPath, data, { encoding: "utf-8" });
    for (let attempt = 0; ; attempt += 1) {
      try {
        rename(tempPath, path);
        return;
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : undefined;
        if (attempt < RENAME_RETRIES && code !== undefined && TRANSIENT_RENAME_CODES.has(code)) {
          sleep(RENAME_RETRY_MS);
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      /* the original write/rename error is the one worth reporting */
    }
    throw error;
  }
}

function messageOf(error: unknown): string {
  return error && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);
}

/**
 * Parse one registry file's text. Returns null for anything that is not a
 * usable entry — invalid JSON, a truncated write, a JSON array, or an object
 * with no non-empty `id`. Null is what turns a bad file into a warning instead
 * of an exception.
 */
function parseEntry(text: string): BackgroundEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  return record as unknown as BackgroundEntry;
}

/** Write one registry entry. Returns the path it wrote. */
export function writeEntry(dir: string, entry: BackgroundEntry): string {
  const path = entryPath(dir, entry.id);
  writeFileAtomic(path, JSON.stringify(entry));
  return path;
}

/** Read one registry entry, or null when it is missing or unusable. */
export function readEntry(dir: string, id: string): BackgroundEntry | null {
  let text: string;
  try {
    text = readFileSync(entryPath(dir, id), "utf-8");
  } catch {
    return null;
  }
  return parseEntry(text);
}

/** Oldest first, so ids sharing a timestamp keep a stable order. */
function compareEntries(a: BackgroundEntry, b: BackgroundEntry): number {
  const aStarted = typeof a.started_at === "string" ? a.started_at : "";
  const bStarted = typeof b.started_at === "string" ? b.started_at : "";
  if (aStarted !== bStarted) return aStarted < bStarted ? -1 : 1;
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

/**
 * Read every registry entry in a directory.
 *
 * A file that does not parse, or parses to something without an id, is
 * **skipped and reported** in `warnings` rather than thrown: one truncated
 * write must not blind `list` to every other task (ADR-4). A missing directory
 * is simply empty.
 */
export function listEntries(dir: string): {
  entries: BackgroundEntry[];
  warnings: BackgroundWarning[];
} {
  const entries: BackgroundEntry[] = [];
  const warnings: BackgroundWarning[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { entries, warnings };
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch (error) {
      warnings.push({ file, reason: messageOf(error) });
      continue;
    }
    const entry = parseEntry(text);
    if (!entry) {
      warnings.push({ file, reason: "not a usable registry entry (invalid JSON or missing id)" });
      continue;
    }
    entries.push(entry);
  }
  entries.sort(compareEntries);
  return { entries, warnings };
}

/**
 * Whether a pid is alive.
 *
 * `process.kill(pid, 0)` performs the OS existence check without signalling.
 * Non-positive and non-integer pids are rejected up front: on every platform
 * `process.kill(0, 0)` targets the *process group* and succeeds, so without
 * that guard a missing pid would read as alive. `EPERM` means the process
 * exists but is owned by another user — alive.
 */
export function isAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/**
 * The project root implied by a registry directory. `<root>/.myflow/.runtime/
 * background` walks up three levels. Used only to resolve a *relative*
 * `exit_file` recorded by an older/newer writer.
 */
function projectRootOf(dir: string): string {
  return resolve(dir, "..", "..", "..");
}

/**
 * Locate a task's `.exit` file. Prefers the path recorded on the entry (which
 * `design.md` §3.1 stores relative to the project root) and falls back to the
 * conventional `<dir>/<id>.exit`.
 */
export function exitPathFor(dir: string, entry: BackgroundEntry): string {
  const recorded = typeof entry.exit_file === "string" ? entry.exit_file.trim() : "";
  if (!recorded) return exitPath(dir, entry.id);
  if (isAbsolute(recorded)) return recorded;
  return resolve(projectRootOf(dir), recorded);
}

/** Read and parse a task's `.exit` record, or null when absent/unreadable. */
export function readExitRecord(dir: string, entry: BackgroundEntry): ExitRecord | null {
  let text: string;
  try {
    text = readFileSync(exitPathFor(dir, entry), "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A half-written record is treated as "no record yet" and the caller falls
    // through to the pid check; `bg_runner.mjs` writes atomically so this is
    // only a defensive branch.
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as ExitRecord;
}

function normalizeExitCode(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Normalize a reason string (`error` / `signal` from a `.exit` record). A blank
 * value is dropped so a present-but-empty field does not render as an empty
 * `failure:` line.
 */
function normalizeReason(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Decide a task's state. The precedence is fixed and must not be reordered
 * (`design.md` §3.1, R9):
 *
 *   1. a present `.exit` record  => `exited`, with the recorded code;
 *   2. `entry.status === "stopped"` => `stopped` (a stop that raced the wrapper);
 *   3. `entry.status === "exited"`  => `exited` (a verdict already reached stays);
 *   4. the pid is alive          => `running`;
 *   5. otherwise                 => `exited` with `exit_code: null` (self-heal).
 *
 * Rules 1 and 3 both outrank rule 4, and for the same reason: a task that has
 * already been judged finished must never come back to life because the OS
 * reused its pid. Rule 3 is what makes a self-healed entry *sticky* — without
 * it, `list` would write `exited` and the next read would flip the entry back
 * to `running`, which would let `myflow_bg_stop` `taskkill` an unrelated
 * process that inherited the pid (D1). Rule 1 still wins over rule 3, so a
 * `.exit` record that arrives later overwrites a healed verdict's exit code.
 * Rule 5 self-heals an entry whose process vanished without a record.
 *
 * Pure: it reads the disk but never writes. Whether to persist the healed state
 * is the caller's decision.
 */
export function resolveStatus(dir: string, entry: BackgroundEntry): ResolvedStatus {
  const record = readExitRecord(dir, entry);
  if (record) {
    const resolved: ResolvedStatus = {
      status: "exited",
      exit_code: normalizeExitCode(record.exit_code),
    };
    const failure = normalizeReason(record.error);
    if (failure) resolved.failure = failure;
    const signal = normalizeReason(record.signal);
    if (signal) resolved.signal = signal;
    return resolved;
  }
  if (entry.status === "stopped") {
    return { status: "stopped", exit_code: normalizeExitCode(entry.exit_code) };
  }
  // A recorded `exited` is sticky: it is a verdict this harness already
  // reached (a self-heal write-back, or the `spawn_error` listener), so pid
  // liveness below must not resurrect it. See the precedence note above.
  if (entry.status === "exited") {
    return { status: "exited", exit_code: normalizeExitCode(entry.exit_code) };
  }
  if (isAlive(entry.pid)) {
    return { status: "running", exit_code: null };
  }
  return { status: "exited", exit_code: null };
}

/**
 * The cursor path for one (session, task) pair: a session's cursor is private
 * to that session, so a second session reading a task's output does not consume
 * bytes the first session has not seen (ADR-5 / PRD Q3).
 */
export function cursorPath(projectRoot: string, contextKey: string, taskId: string): string {
  return join(cursorsDir(backgroundDir(projectRoot)), `${contextKey}${CURSOR_SEPARATOR}${taskId}.json`);
}

/**
 * Read a read-cursor offset. A missing, empty, or corrupt cursor reads as 0,
 * which means "from the beginning" — the safe direction: it may re-read bytes,
 * but it can never silently skip them (`design.md` §3.3).
 */
export function readCursor(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return 0;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 0;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
  const offset = (parsed as Record<string, unknown>).offset;
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

/** Persist a read-cursor offset, creating the cursor directory if needed. */
export function writeCursor(path: string, offset: number): void {
  const normalized = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  writeFileAtomic(path, JSON.stringify({ offset: normalized }));
}

/** Whether a task has ended. A `.exit` record or an ended status both count. */
function isFinished(dir: string, entry: BackgroundEntry): boolean {
  if (existsSync(exitPathFor(dir, entry))) return true;
  return entry.status === "exited" || entry.status === "stopped";
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * When a task ended, in milliseconds: the entry's `ended_at`, falling back to
 * the `.exit` record's `at`. Null when neither dates the task, in which case
 * `prune` leaves it alone rather than guessing.
 */
function endedAtOf(dir: string, entry: BackgroundEntry): number | null {
  const fromEntry = parseTimestamp(entry.ended_at);
  if (fromEntry !== null) return fromEntry;
  return parseTimestamp(readExitRecord(dir, entry)?.at);
}

/** Delete an entry's `.json` / `.log` / `.exit` and every session's cursor for it. */
function removeEntryFiles(dir: string, entry: BackgroundEntry): void {
  const files = new Set([
    entryPath(dir, entry.id),
    logPath(dir, entry.id),
    exitPath(dir, entry.id),
    `${exitPath(dir, entry.id)}.tmp`,
    exitPathFor(dir, entry),
  ]);
  for (const path of files) {
    rmSync(path, { force: true });
  }

  const cursors = cursorsDir(dir);
  let names: string[];
  try {
    names = readdirSync(cursors);
  } catch {
    return;
  }
  const suffix = `${CURSOR_SEPARATOR}${entry.id}.json`;
  for (const name of names) {
    if (name.endsWith(suffix)) rmSync(join(cursors, name), { force: true });
  }
}

/**
 * Delete finished tasks that ended more than 24 hours before `now`, together
 * with their log, exit record, and cursors. Returns how many tasks were
 * removed.
 *
 * `now` is an explicit parameter (never read from the clock here) so the 24h
 * boundary is testable. A running task is never touched, and a finished task
 * with no usable end date is left in place: something we cannot date is not
 * something we should delete.
 */
export function prune(dir: string, now: number): number {
  const cutoff = now - PRUNE_AFTER_MS;
  const { entries } = listEntries(dir);
  let removed = 0;
  for (const entry of entries) {
    if (!isFinished(dir, entry)) continue;
    const endedAt = endedAtOf(dir, entry);
    if (endedAt === null || endedAt >= cutoff) continue;
    removeEntryFiles(dir, entry);
    removed += 1;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Tools
//
// The four `myflow_bg_*` tools are built on the registry above. Like
// `ask.ts` / `approval.ts` they are dependency-injected, never importing
// `./index.ts`, so `index.ts` can register them without a cycle and
// `node --test` can drive `execute` with a stub context.
// ---------------------------------------------------------------------------

/** The `myflow_bg_start` tool name. */
export const BG_START_TOOL_NAME = "myflow_bg_start";

/**
 * The wrapper script, relative to the project root (`design.md` §2). The tool
 * spawns `process.execPath` on this path; the wrapper is what outlives the
 * session and records the exit code. It is injectable so a test can point at
 * the real script while running in a throwaway project root.
 */
export const BG_RUNNER_REL = join(".myflow", "scripts", "bg_runner.mjs");

/** The subset of Pi's `ExtensionContext` the start tool touches. */
export interface BgStartContext {
  cwd: string;
  mode?: string;
  hasUI?: boolean;
  ui?: {
    confirm?: (title: string, message: string) => Promise<boolean>;
  };
}

/** The `myflow_bg_start` parameters (`design.md` §4.1). */
export interface BgStartParams {
  command?: string;
  description?: string;
  unattended?: boolean;
}

/** The structured payload returned by `myflow_bg_start`. */
export interface BgStartResult {
  started: boolean;
  id?: string;
  pid?: number | null;
  log?: string;
  confirmed_by?: ConfirmedBy;
  /** Present when nothing was started: why (and how to proceed). */
  via?: "cancelled" | "no-ui" | "error";
  instruction?: string;
}

/**
 * Capabilities injected by the caller.
 *
 * `spawnProcess` and `runnerPath` are injection points for tests: the first
 * lets a test assert "we refused, and therefore nothing was spawned", the
 * second lets the tool launch the real wrapper from a temp project root. The
 * production caller passes neither.
 */
export interface BgToolRegistration {
  /** Derive the parent session's myflow context key, if any. */
  deriveContextKey?: (ctx: unknown) => string | null;
  /** Whether this process is a dispatched sub-agent. */
  isSubAgent?: boolean;
  /** Override the wrapper path recorded on the entry (tests). */
  runnerPath?: string;
  /** Override `node:child_process.spawn` (tests). */
  spawnProcess?: typeof spawn;
  /**
   * Called with the new task id **after** its registry entry is written.
   *
   * The session keeps this hook so `session_shutdown` can report the tasks it
   * started without scanning the whole project registry (which would pay
   * readdir+parse on every session start). It is a notification, not a
   * decision point: it runs after the entry is on disk, its return value is
   * ignored, and a throwing callback is swallowed — by then the process is
   * already running and no callback may turn a successful start into a
   * failure. Defaults to no-op.
   */
  onStarted?: (id: string) => void;
}

function textResult(details: Record<string, unknown>, text: string, isError = false) {
  return {
    content: [{ type: "text", text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(message: string, details: Record<string, unknown> = {}) {
  return textResult({ started: false, ...details, error: message }, message, true);
}

/**
 * The first line of the sub-agent guard shared by all four `myflow_bg_*`
 * tools, or null when the caller may proceed.
 *
 * The caller is already a sub-agent when `isSubAgent` is true. Background tasks
 * are worse than an ordinary write to place in a child: they register in the
 * shared, project-wide registry and keep running after the child exits, so a
 * sub-agent would leave processes nobody asked for and nobody can attribute.
 * `index.ts` also blocks these tools in its `tool_call` hook (the second line,
 * wired in F7), exactly as it does for `myflow_ask_user`; this check keeps the
 * tool safe even if it is ever registered without that hook. It answers before
 * any dialog, spawn, or file write, so a refusal has no side effects.
 */
export function bgSubAgentRefusal(registration: BgToolRegistration): ReturnType<typeof textResult> | null {
  if (registration.isSubAgent !== true) return null;
  return errorResult(
    "Only the main session may manage background tasks. Background tasks register in the " +
      "shared project registry and outlive this process, so a sub-agent must not create or " +
      "control them. Report the recommendation to the main session instead.",
    { via: "error" },
  );
}

/**
 * The no-UI contract text for `myflow_bg_start`. It is an instruction, not an
 * error: the command cannot be shown to anyone for confirmation, and a
 * background command cannot be interrupted with Ctrl-C, so the safe default is
 * to refuse and explain how to opt in explicitly (`design.md` §4.1 / R8).
 */
export function bgNoUiInstruction(mode: string): string {
  return [
    `No interactive UI is available in this session (ctx.hasUI=false, mode=${mode}), so the`,
    "command cannot be shown to the user for confirmation. A background command cannot be",
    "interrupted with Ctrl-C and outlives the session, so it is refused by default.",
    "To start it anyway, call this tool again with `unattended: true`. That is recorded as",
    '`confirmed_by: "no-ui-explicit"`, and the result will state that the user did not confirm it.',
  ].join("\n");
}

/** The JSON-schema parameter object for `myflow_bg_start`. */
const BG_START_PARAMETERS = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description:
        "The command to run in the background. Must be non-empty. It is executed by a POSIX shell " +
        "(`bash -lc`) — the shell is resolved as MYFLOW_BG_SHELL, then ~/.pi/agent/settings.json's " +
        "shellPath, then the Git for Windows bash, then `bash` on PATH; when no POSIX shell " +
        "resolves (or it resolves to cmd.exe) the task is refused and nothing runs. It is spawned " +
        "directly with argv, NOT through Node's shell option, so quotes are parsed by bash semantics.",
    },
    description: {
      type: "string",
      description: "Optional short label for the task, shown by myflow_bg_list.",
    },
    unattended: {
      type: "boolean",
      description:
        "Only for sessions with no interactive UI. When true, the command is started without " +
        "the user's confirmation and recorded as confirmed_by: no-ui-explicit. Defaults to false.",
    },
  },
  required: ["command"],
} as const;

/**
 * The human-readable start result. It always echoes `confirmed_by` so a
 * `no-ui-explicit` start is visibly flagged in the transcript, not just in the
 * registry file (R8).
 */
function startHumanText(
  id: string,
  pid: number | null,
  log: string,
  confirmedBy: ConfirmedBy,
): string {
  const lines = [
    `Started background task ${id} (pid ${pid ?? "unknown"}).`,
    `Output goes to: ${log}`,
    `confirmed_by: ${confirmedBy}`,
  ];
  if (confirmedBy === "no-ui-explicit") {
    lines.push(
      "WARNING: the user did NOT confirm this command. There was no interactive UI and " +
        "`unattended: true` was passed explicitly.",
    );
  } else {
    lines.push("The user confirmed this exact command in a dialog.");
  }
  return lines.join("\n");
}

/**
 * Build the `myflow_bg_start` tool. Exported so tests can drive `execute` with
 * a stub context instead of a live Pi session; the registration function is the
 * production entry point (wired in F7).
 *
 * The start sequence is fixed (`design.md` §2, R1):
 *
 *   1. confirm the command with the user (or refuse for lack of a UI),
 *   2. spawn the detached wrapper and `unref()` it,
 *   3. write the registry entry,
 *   4. return.
 *
 * Nothing between those steps awaits a child-process event: the tool returns as
 * soon as the entry is on disk. The wrapper — not this tool — waits for the
 * command and records its exit code.
 */
export function createBgStartTool(registration: BgToolRegistration = {}): Record<string, unknown> {
  return {
    name: BG_START_TOOL_NAME,
    label: "Myflow Background Start",
    description: [
      "Start a command in the background and return immediately with a task id.",
      "A background task outlives the session; read it with myflow_bg_output, list it with myflow_bg_list, and stop it with myflow_bg_stop.",
      "The command runs under a POSIX shell (`bash -lc`): the shell is resolved as MYFLOW_BG_SHELL, then ~/.pi/agent/settings.json's shellPath, then the Git for Windows bash, then `bash` on PATH. There is no cmd.exe fallback: when no POSIX shell resolves the task is refused and nothing runs.",
      "It is spawned directly with argv rather than through Node's shell option, so the command's quotes are parsed by bash semantics.",
      "Requires the user's confirmation; without an interactive UI it refuses unless `unattended: true` is passed, which is recorded as unconfirmed.",
    ].join(" "),
    promptSnippet: "Start a long-running command in the background",
    parameters: BG_START_PARAMETERS,

    async execute(
      _toolCallId: string,
      params: BgStartParams,
      _signal: AbortSignal | undefined,
      _onUpdate: ((partial: unknown) => void) | undefined,
      ctx: BgStartContext,
    ) {
      // First line of the sub-agent guard; the tool_call hook is the second.
      const refusal = bgSubAgentRefusal(registration);
      if (refusal) return refusal;

      // Validate before touching the UI: an empty command must not pop a dialog.
      const command = typeof params?.command === "string" ? params.command.trim() : "";
      if (!command) {
        return errorResult("`command` must be a non-empty string.", { via: "error" });
      }
      const description =
        typeof params?.description === "string" ? params.description.trim() : "";

      const root = findProjectRoot(ctx?.cwd ?? process.cwd()) ?? ctx?.cwd ?? process.cwd();
      const dir = backgroundDir(root);
      const contextKey = registration.deriveContextKey?.(ctx) ?? null;
      const unattended = params?.unattended === true;
      const confirm = ctx?.ui?.confirm;

      // Step 1: the confirmation gate (R7). With a UI the user sees the exact
      // command; without one the only way through is an explicit opt-in, which
      // is recorded rather than treated as consent (R8).
      let confirmedBy: ConfirmedBy;
      if (ctx?.hasUI === true && typeof confirm === "function") {
        const agreed = await confirm.call(ctx.ui, "以后台运行这个命令？", command);
        if (agreed !== true) {
          return textResult(
            { started: false, via: "cancelled" },
            "The user did not approve running this command in the background. Nothing was started.",
          );
        }
        confirmedBy = "ui-confirm";
      } else {
        if (!unattended) {
          const instruction = bgNoUiInstruction(ctx?.mode ?? "unknown");
          return textResult({ started: false, via: "no-ui", instruction }, instruction);
        }
        confirmedBy = "no-ui-explicit";
      }

      const id = newTaskId();
      const log = logPath(dir, id);
      const exit = exitPath(dir, id);
      const runner = registration.runnerPath ?? join(root, BG_RUNNER_REL);
      const spawnProcess = registration.spawnProcess ?? spawn;

      // Step 2: spawn the detached wrapper. `unref()` drops it from this
      // process's event loop immediately; this tool deliberately registers no
      // `exit`/`close` listener, so it cannot accidentally wait on the child.
      let pid: number | null;
      try {
        const child = spawnProcess(
          process.execPath,
          [runner, "--id", id, "--log", log, "--exit", exit, "--", command],
          { detached: true, stdio: "ignore", cwd: root },
        );
        child.unref();
        pid = typeof child.pid === "number" ? child.pid : null;

        // This listener is NOT waiting on the child. It registers no `exit` or
        // `close` handler, awaits nothing, and never delays the return: the
        // tool still comes back the moment the entry is on disk (R1).
        //
        // It is mandatory for a different reason. `spawn` reports a failure to
        // *create* the process — ENOENT, EAGAIN, ENOMEM (e.g. Windows
        // ERROR_NO_SYSTEM_RESOURCES), and the rest — asynchronously, through the
        // `'error'` event. An `'error'` event with no listener is re-thrown by
        // EventEmitter as an uncaught exception, which can take down the whole
        // Pi process. Without this listener a failed start is not just
        // undiagnosable; it is a crash.
        child.on("error", (error: unknown) => {
          try {
            const current = readEntry(dir, id);
            if (!current) return;
            const failed: BackgroundEntry = {
              ...current,
              status: "exited",
              ended_at: new Date().toISOString(),
              spawn_error: messageOf(error),
            };
            writeEntry(dir, failed);
          } catch {
            // The listener runs outside the tool's control flow: a registry
            // write that fails here must never become an uncaught exception.
          }
        });
      } catch (error) {
        return errorResult(`Could not start the background runner: ${messageOf(error)}`, {
          via: "error",
        });
      }

      // Step 3: record the task. `log` and `exit_file` are stored relative to
      // the project root, the shape `design.md` §3.1 documents and
      // `exitPathFor` resolves.
      const entry: BackgroundEntry = {
        id,
        command,
        ...(description ? { description } : {}),
        cwd: root,
        pid: pid ?? 0,
        log: join(BACKGROUND_DIR, `${id}.log`),
        exit_file: join(BACKGROUND_DIR, `${id}.exit`),
        status: "running",
        exit_code: null,
        started_at: new Date().toISOString(),
        ended_at: null,
        started_by_context_key: contextKey,
        confirmed_by: confirmedBy,
      };
      try {
        writeEntry(dir, entry);
      } catch (error) {
        return errorResult(
          `The background runner started (pid ${pid ?? "unknown"}) but its registry entry could ` +
            `not be written: ${messageOf(error)}. The process is now untracked; stop it manually if needed.`,
          { started: true, id, pid, log, confirmed_by: confirmedBy, via: "error" },
        );
      }

      // Step 3b: tell the caller (the session's own bookkeeping). This is a
      // notification after the fact — the entry is on disk and the process is
      // already running — so a throwing callback is swallowed rather than
      // turning a successful start into an error.
      if (registration.onStarted) {
        try {
          registration.onStarted(id);
        } catch {
          /* a bookkeeping callback must not change the tool's outcome */
        }
      }

      // Step 4: return. No child-process event is awaited anywhere above.
      return textResult(
        { started: true, id, pid, log, confirmed_by: confirmedBy },
        startHumanText(id, pid, log, confirmedBy),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// `myflow_bg_output`
//
// Reads a task's output either as an increment from *this session's* cursor
// (`mode: "delta"`, the default) or as its last N lines (`mode: "tail"`). The
// cursor is what makes two sessions independent: each has its own, so neither
// consumes bytes the other has not seen (ADR-5 / PRD Q3). `tail` and `peek`
// never move a cursor; only `delta` without `peek` advances one.
//
// A bounded wait (`wait_ms`) replaces a separate `sleep` tool (ADR-3): it
// returns early as soon as there are new bytes to read or the task has ended,
// so the model cannot sleep past a finished task. The tool reads before it
// waits only to observe `statSync(size)`; it never reads the whole log just to
// decide whether there is more (large logs must not be slurped).
// ---------------------------------------------------------------------------

/** The `myflow_bg_output` tool name. */
export const BG_OUTPUT_TOOL_NAME = "myflow_bg_output";

/** `max_bytes` bounds, clamped rather than rejected (`design.md` §4.2). */
export const DEFAULT_MAX_BYTES = 32768;
export const MAX_MAX_BYTES = 65536;
export const MIN_MAX_BYTES = 1;

/** `lines` bounds, only consulted for `tail`; clamped rather than rejected. */
export const DEFAULT_TAIL_LINES = 200;
export const MAX_TAIL_LINES = 2000;
export const MIN_TAIL_LINES = 1;

/** `wait_ms` bounds; clamped rather than rejected, so a wait is always bounded. */
export const DEFAULT_WAIT_MS = 0;
export const MAX_WAIT_MS = 30000;
export const MIN_WAIT_MS = 0;

/** Poll interval for `wait_ms`; `design.md` §4.2 requires ≤ 200ms. */
export const WAIT_POLL_MS = 100;

/**
 * Cursor namespace used when the injected deriver returns no context key. Two
 * keyless sessions then share one cursor, which can over-consume; that is the
 * only honest fallback, and every real caller injects a deriver.
 */
export const FALLBACK_CONTEXT_KEY = "no-context";

/** How the output is framed: an increment from the cursor, or the last lines. */
export type BgOutputMode = "delta" | "tail";

/** The subset of Pi's `ExtensionContext` the output tool touches. */
export interface BgOutputContext {
  cwd: string;
}

/** The `myflow_bg_output` parameters (`design.md` §4.2). */
export interface BgOutputParams {
  task_id?: string;
  mode?: string;
  peek?: boolean;
  max_bytes?: number;
  lines?: number;
  wait_ms?: number;
}

/** The structured payload returned by `myflow_bg_output`. */
export interface BgOutputResult {
  task_id?: string;
  mode?: BgOutputMode;
  status: BackgroundTaskStatus;
  exit_code: number | null;
  bytes: number;
  next_offset: number;
  truncated: boolean;
  text: string;
  /**
   * Present and true only when the log was shorter than the stored cursor
   * (rotated/recreated) and the read restarted from 0. This field is an
   * addition to the `design.md` §4.2 return shape (recorded for F8); it exists
   * so a caller is told about the re-read instead of silently seeing nothing.
   */
  reset?: boolean;
  /**
   * Why the task could not be started, or ended abnormally: the `.exit` record's
   * `error`, falling back to the entry's `spawn_error`. Omitted when neither is
   * present. Makes a failed start diagnosable instead of looking like a normal
   * exit whose code happens to be unknown (F8/H1a).
   */
  failure?: string;
  /** The signal that terminated the task, from the `.exit` record. Omitted when absent. */
  signal?: string;
  /** Present only on a refusal/error result. */
  error?: string;
}

function bgOutputError(message: string) {
  return textResult(
    {
      status: "unknown",
      exit_code: null,
      bytes: 0,
      next_offset: 0,
      truncated: false,
      text: "",
      error: message,
    },
    message,
    true,
  );
}

/**
 * Coerce a parameter to an integer inside `[min, max]`, falling back to
 * `fallback` for a missing or non-finite value. Out-of-range input is clamped,
 * never rejected: the schemas document the bounds, and a clamp keeps the tool
 * usable when a model guesses a larger number.
 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  if (integer < min) return min;
  if (integer > max) return max;
  return integer;
}

/** The log's size in bytes, or 0 when it does not exist yet. */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Read `length` bytes starting at `start`. A missing or unreadable file yields
 * an empty buffer: output is best-effort, and the caller reports the task state
 * separately rather than turning a vanished log into a thrown error.
 */
function readRange(path: string, start: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* the descriptor is gone either way */
    }
  }
}

/**
 * Read at most `maxBytes` from the end of a file, plus where that chunk began.
 * Bounding the read from the end is what keeps `tail` from slurping a huge log:
 * only the window a caller could display is touched.
 *
 * The window is aligned to a UTF-8 character boundary before it is read, for the
 * same reason `delta` aligns its end: a window that opens mid-character decodes
 * to U+FFFD and corrupts the first character of the returned text.
 */
function readTailChunk(path: string, maxBytes: number): { buffer: Buffer; chunkStart: number; size: number } {
  const size = fileSize(path);
  if (size <= 0) return { buffer: Buffer.alloc(0), chunkStart: 0, size: 0 };
  let chunkStart = Math.max(0, size - maxBytes);
  if (chunkStart > 0) {
    chunkStart = alignTailStart(path, chunkStart, size);
  }
  // Degenerate case: aligning forward walked past the whole final character
  // (the byte budget is smaller than that character), leaving the start at EOF.
  // Returning nothing would make `tail` report empty output for a non-empty log,
  // so back up to the start of the last complete character instead. This
  // exceeds the caller's byte budget by at most three bytes — the same trade-off
  // `alignDeltaEnd` makes at the other end.
  if (chunkStart >= size) {
    chunkStart = lastCharacterStart(path, size);
  }
  return { buffer: readRange(path, chunkStart, size - chunkStart), chunkStart, size };
}

/** Read the single byte at `index`, or -1 when it cannot be read. */
function readByteAt(path: string, index: number): number {
  const buffer = readRange(path, index, 1);
  return buffer.length === 1 ? buffer[0] : -1;
}

/** Whether `byte` is a UTF-8 continuation byte (`0b10xxxxxx`). -1 is not. */
function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/**
 * The LF byte. A `tail` window whose preceding byte is LF starts on a line
 * boundary, so its first line is complete; otherwise the window opened mid-line.
 */
const NEWLINE_BYTE = 0x0a;

/**
 * Pull an exclusive delta `end` position back to the nearest UTF-8 character
 * boundary, so a multi-byte character is never split between two reads.
 *
 * `end` is exclusive, so it is a boundary when the byte *at* `end` is not a
 * continuation byte (`0b10xxxxxx`), or when it has reached the end of the file.
 * At most three bytes are skipped: no UTF-8 character is longer than four
 * bytes, so a run of continuation bytes at `end` cannot extend further.
 *
 * Degenerate case: if backing up would land on `offset` and return zero bytes
 * (the byte budget is smaller than the character at `offset`), the end is
 * pushed *forward* to the end of that character instead. Returning nothing
 * would leave the cursor in place forever, which is worse than exceeding the
 * caller's byte budget by at most three bytes. `offset` always stays a byte
 * position (`design.md` §3.3); only where the read ends moves.
 */
function alignDeltaEnd(path: string, offset: number, end: number, size: number): number {
  let aligned = end;
  let backed = 0;
  while (aligned > offset && backed < 3 && isContinuationByte(readByteAt(path, aligned))) {
    aligned -= 1;
    backed += 1;
  }
  if (aligned > offset) return aligned;
  let advanced = offset + 1;
  while (advanced < size && isContinuationByte(readByteAt(path, advanced))) {
    advanced += 1;
  }
  return advanced;
}

/**
 * Push an inclusive chunk start *forward* to the nearest UTF-8 character
 * boundary, so a `tail` read never opens in the middle of a multi-byte
 * character.
 *
 * `start` is inclusive (the first byte the chunk returns), so it is already a
 * boundary when the byte *at* `start` is not a continuation byte
 * (`0b10xxxxxx`). When it is a continuation byte the chunk would begin with the
 * tail of a character and decode to U+FFFD; advancing to the next lead byte
 * drops that fragment. At most three bytes are skipped: no UTF-8 character is
 * longer than four bytes.
 *
 * The direction is the opposite of `alignDeltaEnd`. `tail` wants the end of the
 * file, so the only way to avoid the broken opening character is to move the
 * start *toward* the end. Moving it back would pull in the very fragment that
 * decodes to U+FFFD. `start` always stays a byte position (`design.md` §3.3);
 * only where the read begins moves.
 */
function alignTailStart(path: string, start: number, size: number): number {
  let aligned = start;
  let advanced = 0;
  while (aligned < size && advanced < 3 && isContinuationByte(readByteAt(path, aligned))) {
    aligned += 1;
    advanced += 1;
  }
  return aligned;
}

/**
 * The byte offset where the file's final complete UTF-8 character begins: scan
 * back from the last byte over at most three continuation bytes (a character is
 * at most four bytes long), landing on its lead byte. Used only when aligning a
 * `tail` start forward would otherwise leave nothing to read.
 */
function lastCharacterStart(path: string, size: number): number {
  let start = Math.max(0, size - 1);
  let backed = 0;
  while (start > 0 && backed < 3 && isContinuationByte(readByteAt(path, start))) {
    start -= 1;
    backed += 1;
  }
  return start;
}

/** Whether a resolved status means the command is no longer running. */
function isFinishedStatus(status: BackgroundTaskStatus): boolean {
  return status === "exited" || status === "stopped";
}

/** Bounded async sleep; the only timer lives inside one `execute` call. */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Wait up to `waitMs` for something to read, returning as soon as either there
 * are new bytes past `offset` or the task has ended (`design.md` §4.2, ADR-3).
 * Both checks are cheap: `statSync(size)` compares sizes without reading the
 * log, and `resolveStatus` is a fixed-precedence read. The loop is bounded by a
 * deadline and never waits forever.
 */
async function waitForReadable(
  dir: string,
  entry: BackgroundEntry,
  logFile: string,
  offset: number,
  waitMs: number,
): Promise<void> {
  if (waitMs <= 0) return;
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (isFinishedStatus(resolveStatus(dir, entry).status)) return;
    if (fileSize(logFile) > offset) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await sleep(Math.min(WAIT_POLL_MS, remaining));
  }
}

/** The JSON-schema parameter object for `myflow_bg_output`. */
const BG_OUTPUT_PARAMETERS = {
  type: "object",
  properties: {
    task_id: {
      type: "string",
      description: "The task id returned by myflow_bg_start (or listed by myflow_bg_list).",
    },
    mode: {
      type: "string",
      enum: ["delta", "tail"],
      description:
        'How to frame the output. "delta" (default) returns the bytes after this session\'s ' +
        'read cursor; "tail" returns the last `lines` lines and does not move the cursor.',
    },
    peek: {
      type: "boolean",
      description:
        "When true, read without advancing the delta cursor, so the same bytes can be read again. " +
        "Defaults to false.",
    },
    max_bytes: {
      type: "number",
      description: `Byte budget for the returned text (default ${DEFAULT_MAX_BYTES}, capped at ${MAX_MAX_BYTES}).`,
    },
    lines: {
      type: "number",
      description: `For mode "tail" only: how many trailing lines to return (default ${DEFAULT_TAIL_LINES}, capped at ${MAX_TAIL_LINES}).`,
    },
    wait_ms: {
      type: "number",
      description:
        `Wait up to this many milliseconds (0-${MAX_WAIT_MS}, default 0) for new output or the ` +
        "task to end, then return; it returns early as soon as either happens.",
    },
  },
  required: ["task_id"],
} as const;

/**
 * The human-readable output. It always names the task and its status, and it
 * annotates the two cases a reader could otherwise misread: a truncated read
 * (with the offset a follow-up delta will resume at) and a cursor reset.
 */
function outputHumanText(result: BgOutputResult): string {
  const code = result.exit_code === null ? "" : ` (exit_code ${result.exit_code})`;
  const signal = result.signal ? ` (signal ${result.signal})` : "";
  const parts = [`Task ${result.task_id ?? "?"} — ${result.status}${code}${signal}`];
  if (result.failure) {
    parts.push(`FAILURE: ${result.failure}`);
  }
  if (result.reset) {
    parts.push(
      "NOTE: the log is shorter than the read cursor (rotated or recreated); the cursor was " +
        "reset to 0 and the task was re-read from the start.",
    );
  }
  if (result.truncated) {
    parts.push(
      `NOTE: output was truncated at max_bytes; the next delta read resumes at offset ${result.next_offset}.`,
    );
  }
  parts.push("---");
  parts.push(result.text.length > 0 ? result.text : "(no new output)");
  return parts.join("\n");
}

/**
 * Build the `myflow_bg_output` tool. Exported so tests can drive `execute` with
 * a stub context instead of a live Pi session; the registration function is the
 * production entry point (wired in F7).
 *
 * Read rules (`design.md` §4.2 / §3.3):
 *   - `delta` reads `[cursor, size)` and, unless `peek`, advances the cursor to
 *     the end of *the bytes it actually returned* — not to the file end when the
 *     read was cut short, or the unreturned bytes would be lost silently.
 *   - `tail` reads the last `lines` lines and moves nothing.
 *   - `peek` reads and moves nothing.
 *   - A cursor past the file end means the log was rotated/recreated: the read
 *     restarts at 0 and reports `reset: true` rather than returning nothing.
 *
 * Status is reported honestly but not persisted here; persisting a self-healed
 * `exited` is `myflow_bg_list`'s job (F5).
 */
export function createBgOutputTool(registration: BgToolRegistration = {}): Record<string, unknown> {
  return {
    name: BG_OUTPUT_TOOL_NAME,
    label: "Myflow Background Output",
    description: [
      "Read a background task's output, either an increment since this session's last delta read or its last lines.",
      "Returns the task status and, once it has finished, its exit code.",
      "tail and peek never advance the read cursor; delta does unless peek is set.",
      "wait_ms (bounded) returns early as soon as there is new output or the task has ended.",
    ].join(" "),
    promptSnippet: "Read a background task's output",
    parameters: BG_OUTPUT_PARAMETERS,

    async execute(
      _toolCallId: string,
      params: BgOutputParams,
      _signal: AbortSignal | undefined,
      _onUpdate: ((partial: unknown) => void) | undefined,
      ctx: BgOutputContext,
    ) {
      // First line of the sub-agent guard; the tool_call hook is the second.
      const refusal = bgSubAgentRefusal(registration);
      if (refusal) return refusal;

      const taskId = typeof params?.task_id === "string" ? params.task_id.trim() : "";
      if (!taskId) {
        return bgOutputError("`task_id` must be a non-empty string.");
      }

      const root = findProjectRoot(ctx?.cwd ?? process.cwd()) ?? ctx?.cwd ?? process.cwd();
      const dir = backgroundDir(root);
      const entry = readEntry(dir, taskId);
      if (!entry) {
        return bgOutputError(
          `No background task "${taskId}" is registered. Use myflow_bg_list to see known task ids.`,
        );
      }

      const mode: BgOutputMode = params?.mode === "tail" ? "tail" : "delta";
      const peek = params?.peek === true;
      const maxBytes = clampInt(params?.max_bytes, MIN_MAX_BYTES, MAX_MAX_BYTES, DEFAULT_MAX_BYTES);
      const lines = clampInt(params?.lines, MIN_TAIL_LINES, MAX_TAIL_LINES, DEFAULT_TAIL_LINES);
      const waitMs = clampInt(params?.wait_ms, MIN_WAIT_MS, MAX_WAIT_MS, DEFAULT_WAIT_MS);

      const contextKey = registration.deriveContextKey?.(ctx) ?? FALLBACK_CONTEXT_KEY;
      const cursorFile = cursorPath(root, contextKey, taskId);
      const logFile = logPath(dir, taskId);

      // A delta cursor past the file end is a rotated/recreated log, not "no
      // data": restart at 0 and tell the caller. `tail` never uses the cursor.
      let offset = readCursor(cursorFile);
      let reset = false;
      if (mode === "delta" && offset > fileSize(logFile)) {
        offset = 0;
        reset = true;
      }

      if (waitMs > 0) {
        await waitForReadable(dir, entry, logFile, offset, waitMs);
      }

      // Resolve after the wait so a task that ended while waiting is reported as
      // ended. Reading the status does not write it back (F5 owns persistence).
      const resolved = resolveStatus(dir, entry);
      const { status, exit_code } = resolved;
      // `failure` unifies the two ways a start can fail so a caller does not
      // have to know which layer noticed: the runner's `.exit.error` (the
      // command was never created, or its log could not be opened) and the
      // entry's `spawn_error` (the extension's own `'error'` listener). The
      // `.exit` record wins when both exist, because it is written by the
      // process that actually attempted the creation.
      const failure = resolved.failure ?? normalizeReason(entry.spawn_error) ?? undefined;
      const signal = resolved.signal;

      if (mode === "tail") {
        const { buffer, chunkStart } = readTailChunk(logFile, maxBytes);
        const decoded = buffer.toString("utf-8");
        const split = decoded.split("\n");
        const hadTrailingNewline = decoded.endsWith("\n");
        if (hadTrailingNewline) split.pop();

        // A byte-budget window can open in the middle of a line. Unlike `delta`,
        // `tail` has no cursor, so a half-line at the front can never be
        // completed by a later read — the caller has no way to ask for the rest.
        // Drop that incomplete first line and start from the next complete one.
        //
        // The window opened mid-line exactly when the byte before it is not an
        // LF (and it is not the start of the file, where every line is
        // complete). When the window begins on an LF byte the decoded text
        // starts with "", which this also drops.
        //
        // Invariant: `tail` never returns a partial line. The one exception is
        // when dropping the partial first line would leave nothing at all (the
        // window covers a single line that is itself longer than `maxBytes`).
        // Returning an empty string would be less useful than the aligned tail
        // fragment, so in that case the fragment is kept and `truncated` stays
        // true. `readTailChunk` has already aligned it to a UTF-8 boundary.
        const partialFirstLine =
          chunkStart > 0 && readByteAt(logFile, chunkStart - 1) !== NEWLINE_BYTE;
        const completeLines = partialFirstLine && split.length > 1 ? split.slice(1) : split;
        const selected = completeLines.slice(-lines);
        let text = selected.join("\n");
        if (hadTrailingNewline && selected.length > 0) text += "\n";

        const result: BgOutputResult = {
          task_id: taskId,
          mode,
          status,
          exit_code,
          bytes: Buffer.byteLength(text, "utf-8"),
          // `tail` returns the cursor unchanged: next_offset is where a delta
          // would resume, and the cursor file is not touched.
          next_offset: offset,
          // Only a byte-budget cut counts as truncation. Dropping leading lines
          // to satisfy `lines` is the requested behavior, not a loss of output.
          truncated: chunkStart > 0,
          text,
          ...(failure ? { failure } : {}),
          ...(signal ? { signal } : {}),
        };
        return textResult(result as unknown as Record<string, unknown>, outputHumanText(result));
      }

      const size = fileSize(logFile);
      const available = Math.max(0, size - offset);
      const take = Math.min(available, maxBytes);
      // The byte budget must not split a multi-byte UTF-8 character: a split
      // would emit U+FFFD now *and* leave the cursor inside a character, so the
      // next delta would corrupt the same character again and lose it. Align the
      // exclusive end down to a character boundary; the bytes past it stay for
      // the next read rather than being dropped. `alignDeltaEnd` handles the
      // degenerate budget-too-small case by taking one whole character.
      let end = offset + take;
      if (end < size) {
        end = alignDeltaEnd(logFile, offset, end, size);
      }
      const buffer = readRange(logFile, offset, end - offset);
      const text = buffer.toString("utf-8");
      // `truncated` is true only when the budget left bytes unread. `next_offset`
      // is the next cursor position: for a normal delta it is the end of what
      // was returned, so the remainder is read by the next delta rather than
      // dropped. `peek` does not move the cursor, so its next_offset stays where
      // the cursor is.
      const truncated = end < size;
      const nextOffset = peek ? offset : end;

      if (!peek) {
        writeCursor(cursorFile, nextOffset);
      }

      const result: BgOutputResult = {
        task_id: taskId,
        mode,
        status,
        exit_code,
        bytes: buffer.length,
        next_offset: nextOffset,
        truncated,
        text,
        ...(reset ? { reset: true } : {}),
        ...(failure ? { failure } : {}),
        ...(signal ? { signal } : {}),
      };
      return textResult(result as unknown as Record<string, unknown>, outputHumanText(result));
    },
  };
}

// ---------------------------------------------------------------------------
// `myflow_bg_list`
//
// Reports every registered task, self-heals a task whose process is gone, and
// optionally reaps finished tasks older than 24 hours. It is the only tool that
// *writes back* a resolved status: `resolveStatus` is pure, so `list` (which
// already has to read every entry) is the natural place to persist the healed
// verdict (F5 owns this; F2/F4 deliberately do not write).
//
// It reuses the shared registry and the shared sub-agent refusal, never imports
// `./index.ts`, and keeps its clock injectable so the 24h boundary is testable
// without changing the production default.
// ---------------------------------------------------------------------------

/** The `myflow_bg_list` tool name. */
export const BG_LIST_TOOL_NAME = "myflow_bg_list";

/** `command` is truncated to this many characters for the list view. */
export const MAX_LIST_COMMAND_CHARS = 80;

/** The `myflow_bg_list` parameters (`design.md` §4.3). */
export interface BgListParams {
  include_finished?: boolean;
  prune?: boolean;
}

/** One row of the list result. */
export interface BgListRow {
  id: string;
  description?: string;
  /** Truncated for display; the full command stays in the registry entry. */
  command: string;
  command_truncated: boolean;
  status: BackgroundTaskStatus;
  exit_code: number | null;
  pid: number;
  started_at: string;
  ended_at: string | null;
  /** `started_by_context_key ===` the caller's context key. */
  current_session: boolean;
  confirmed_by: ConfirmedBy;
  /** True for `confirmed_by: "no-ui-explicit"` (R8): surfaced, never buried. */
  unconfirmed: boolean;
  /** Present when the OS could not create the process (F3b). */
  spawn_error?: string;
  /**
   * The `.exit` record's `error`, i.e. why the runner could not start or run
   * the command. Distinct from `spawn_error`: `spawn_error` is the extension
   * observing the failure, this is the detached wrapper recording it. Either
   * one is a reason, and both may be absent on a normal exit (F8/H1a).
   */
  failure?: string;
  /** The signal that terminated the command, from the `.exit` record. Omitted when absent. */
  signal?: string;
}

/** The structured payload returned by `myflow_bg_list`. */
export interface BgListResult {
  tasks: BgListRow[];
  count: number;
  /** Number of registry files that could not be read (ADR-4: reported, not swallowed). */
  warnings: number;
  warning_details: BackgroundWarning[];
  /** Entries reaped by this call; always 0 unless `prune: true`. */
  pruned: number;
  /** Entries whose resolved status differed from disk and were re-written. */
  healed: number;
  include_finished: boolean;
}

/**
 * Injection surface for `myflow_bg_list`.
 *
 * It extends the shared background registration (so it reuses the same
 * `deriveContextKey` / `isSubAgent` wiring as the other three tools) and adds
 * only a clock override. The clock exists so a test can pin the 24h prune
 * boundary; production passes nothing and gets `Date.now`.
 */
export interface BgListRegistration extends BgToolRegistration {
  /** Override the clock used by `prune` and by self-heal timestamps (tests). */
  now?: () => number;
}

/** Whether an entry records a spawn failure (F3b). */
function hasSpawnError(entry: BackgroundEntry): entry is BackgroundEntry & { spawn_error: string } {
  return typeof entry.spawn_error === "string" && entry.spawn_error.length > 0;
}

/** Truncate a command for the list view, marking that it was cut. */
function truncateCommand(command: string): { text: string; truncated: boolean } {
  if (command.length <= MAX_LIST_COMMAND_CHARS) return { text: command, truncated: false };
  return { text: `${command.slice(0, MAX_LIST_COMMAND_CHARS)}...`, truncated: true };
}

/**
 * Resolve one entry and persist the verdict when it disagrees with disk.
 *
 * Two corrections happen here, both the caller's job rather than
 * `resolveStatus`'s (which stays pure):
 *
 *   1. A recorded `spawn_error` means the OS never created the process, so the
 *      task cannot be running — even if the pid now reads as alive (pid reuse).
 *      Without this, a failed start could masquerade as a live task.
 *   2. Any disagreement between the recorded status/exit code and the resolved
 *      one is written back atomically, so a later reader sees the healed state
 *      instead of re-deriving it (F2's `resolveStatus` is pure by design).
 *
 * The first time a finished state is observed the entry gets an `ended_at`
 * (the `.exit` record's own timestamp when present, else "now"), so a healed
 * task can eventually be pruned instead of staying undated forever.
 */
function resolveAndHeal(
  dir: string,
  entry: BackgroundEntry,
  nowMs: number,
): { resolved: ResolvedStatus; entry: BackgroundEntry; healed: boolean } {
  let resolved = resolveStatus(dir, entry);
  if (hasSpawnError(entry) && resolved.status === "running") {
    resolved = { status: "exited", exit_code: null };
  }

  const changed = resolved.status !== entry.status || resolved.exit_code !== entry.exit_code;
  if (!changed) return { resolved, entry, healed: false };

  const healedEntry: BackgroundEntry = {
    ...entry,
    status: resolved.status,
    exit_code: resolved.exit_code,
  };
  if (isFinishedStatus(resolved.status) && !healedEntry.ended_at) {
    const recordedAt = readExitRecord(dir, entry)?.at;
    healedEntry.ended_at =
      typeof recordedAt === "string" && recordedAt.length > 0
        ? recordedAt
        : new Date(nowMs).toISOString();
  }
  try {
    writeEntry(dir, healedEntry);
  } catch {
    // A failed write-back must not fail the whole listing (D3): the verdict
    // above is still this call's correct answer, it just did not reach the
    // disk. Saying `healed: true` would claim a persistence that did not
    // happen, so it stays false. Only this one write is guarded — anything
    // else that throws here is a real bug and must still surface.
    return { resolved, entry: healedEntry, healed: false };
  }
  return { resolved, entry: healedEntry, healed: true };
}

/** Project an entry plus its resolved status into a list row. */
function toListRow(
  entry: BackgroundEntry,
  resolved: ResolvedStatus,
  contextKey: string,
): BgListRow {
  const { text, truncated } = truncateCommand(typeof entry.command === "string" ? entry.command : "");
  const row: BgListRow = {
    id: entry.id,
    ...(typeof entry.description === "string" && entry.description ? { description: entry.description } : {}),
    command: text,
    command_truncated: truncated,
    status: resolved.status,
    exit_code: resolved.exit_code,
    pid: typeof entry.pid === "number" ? entry.pid : 0,
    started_at: typeof entry.started_at === "string" ? entry.started_at : "",
    ended_at: typeof entry.ended_at === "string" ? entry.ended_at : null,
    current_session: entry.started_by_context_key === contextKey,
    confirmed_by: entry.confirmed_by,
    unconfirmed: entry.confirmed_by === "no-ui-explicit",
    ...(hasSpawnError(entry) ? { spawn_error: entry.spawn_error } : {}),
    ...(resolved.failure ? { failure: resolved.failure } : {}),
    ...(resolved.signal ? { signal: resolved.signal } : {}),
  };
  return row;
}

/** The human-readable list, one block per task plus a summary line. */
function listHumanText(result: BgListResult): string {
  const lines: string[] = [];
  const suffixes: string[] = [];
  if (result.pruned > 0) suffixes.push(`pruned ${result.pruned}`);
  if (result.healed > 0) suffixes.push(`self-healed ${result.healed}`);
  lines.push(
    `${result.count} background task(s)${suffixes.length > 0 ? ` (${suffixes.join(", ")})` : ""}.`,
  );
  if (result.warnings > 0) {
    lines.push(
      `WARNING: ${result.warnings} registry file(s) could not be read and were skipped ` +
        `(see warning_details).`,
    );
  }
  if (result.tasks.length === 0) {
    lines.push("(none)");
    return lines.join("\n");
  }
  for (const row of result.tasks) {
    const code = row.exit_code === null ? "" : ` exit_code=${row.exit_code}`;
    const signal = row.signal ? ` signal=${row.signal}` : "";
    const session = row.current_session ? " [this session]" : "";
    lines.push(
      `${row.id}  ${row.status}${code}${signal}  pid=${row.pid}${session}  confirmed_by=${row.confirmed_by}`,
    );
    if (row.description) lines.push(`  description: ${row.description}`);
    lines.push(`  command: ${row.command}${row.command_truncated ? " (truncated)" : ""}`);
    lines.push(`  started_at: ${row.started_at}  ended_at: ${row.ended_at ?? "-"}`);
    if (row.failure) lines.push(`  failure: ${row.failure}`);
    if (row.spawn_error) lines.push(`  spawn_error: ${row.spawn_error}`);
    if (row.unconfirmed) lines.push("  WARNING: the user did NOT confirm this command (no-ui-explicit).");
  }
  return lines.join("\n");
}

/** The JSON-schema parameter object for `myflow_bg_list`. */
const BG_LIST_PARAMETERS = {
  type: "object",
  properties: {
    include_finished: {
      type: "boolean",
      description:
        "Include tasks that have already exited or been stopped (default true). " +
        "Set false to list only tasks that are still running.",
    },
    prune: {
      type: "boolean",
      description:
        "Delete finished tasks that ended more than 24 hours ago, together with their logs, " +
        "exit records and cursors (default false).",
    },
  },
  required: [],
} as const;

/**
 * Build the `myflow_bg_list` tool. Exported so tests can drive `execute` with a
 * stub context instead of a live Pi session; the registration function is the
 * production entry point (wired in F7).
 */
export function createBgListTool(registration: BgListRegistration = {}): Record<string, unknown> {
  return {
    name: BG_LIST_TOOL_NAME,
    label: "Myflow Background List",
    description: [
      "List known background tasks with their status, exit code, pid, timestamps and how they were confirmed.",
      "Each entry is self-healed: a task whose process is gone and has no exit record is reported (and persisted) as exited.",
      "Set include_finished: false to list only running tasks; set prune: true to also delete finished tasks older than 24 hours.",
      "Unreadable registry files are reported, not hidden, and an unconfirmed (no-ui-explicit) start is flagged.",
    ].join(" "),
    promptSnippet: "List background tasks and their status",
    parameters: BG_LIST_PARAMETERS,

    async execute(
      _toolCallId: string,
      params: BgListParams,
      _signal: AbortSignal | undefined,
      _onUpdate: ((partial: unknown) => void) | undefined,
      ctx: BgOutputContext,
    ) {
      // First line of the sub-agent guard; the tool_call hook is the second.
      const refusal = bgSubAgentRefusal(registration);
      if (refusal) return refusal;

      const root = findProjectRoot(ctx?.cwd ?? process.cwd()) ?? ctx?.cwd ?? process.cwd();
      const dir = backgroundDir(root);
      const contextKey = registration.deriveContextKey?.(ctx) ?? FALLBACK_CONTEXT_KEY;
      const includeFinished = params?.include_finished !== false;
      const doPrune = params?.prune === true;
      const clock = registration.now ?? Date.now;

      // Prune first so reaped tasks do not appear in this same listing. `prune`
      // re-scans the directory itself; the list below is then a fresh read.
      const pruned = doPrune ? prune(dir, clock()) : 0;

      const { entries, warnings } = listEntries(dir);
      const tasks: BgListRow[] = [];
      let healed = 0;
      for (const entry of entries) {
        const outcome = resolveAndHeal(dir, entry, clock());
        if (outcome.healed) healed += 1;
        if (!includeFinished && isFinishedStatus(outcome.resolved.status)) continue;
        tasks.push(toListRow(outcome.entry, outcome.resolved, contextKey));
      }

      const result: BgListResult = {
        tasks,
        count: tasks.length,
        warnings: warnings.length,
        warning_details: warnings,
        pruned,
        healed,
        include_finished: includeFinished,
      };
      return textResult(result as unknown as Record<string, unknown>, listHumanText(result));
    },
  };
}

// ---------------------------------------------------------------------------
// `myflow_bg_stop`
//
// Terminates a running task's whole process tree, idempotently, and never
// claims a stop it did not achieve. The tree matters: a background command runs
// under a shell the wrapper started, and `process.kill` does not reliably reach
// shell descendants on Windows, so Windows goes through `taskkill /F /T`
// (ADR-6, `design.md` §4.4).
//
// The verdict is the process, not the kill command: `taskkill` can exit non-zero
// for a process that is already gone (success) and can exit zero while a
// descendant survives. So success is decided by re-checking `isAlive` after the
// attempt; a survivor is reported as an error with the raw stderr rather than
// being written to the registry as `stopped`.
// ---------------------------------------------------------------------------

/** The `myflow_bg_stop` tool name. */
export const BG_STOP_TOOL_NAME = "myflow_bg_stop";

/** How long a killed process gets to disappear before the stop is a failure. */
export const STOP_RECHECK_TIMEOUT_MS = 1000;

/** How often the recheck runs while waiting for a killed process to disappear. */
export const STOP_RECHECK_INTERVAL_MS = 25;

/** The `myflow_bg_stop` parameters (`design.md` §4.4). */
export interface BgStopParams {
  task_id?: string;
}

/** The outcome of one platform kill attempt. */
export interface KillOutcome {
  /**
   * The kill command's exit status, or null when it could not be run at all
   * (e.g. `taskkill` is missing). It is diagnostic only: whether the stop
   * succeeded is decided by `isAlive`, never by this value.
   */
  status: number | null;
  /** Raw stderr from the kill command, trimmed. Empty when there was none. */
  stderr: string;
}

/** The structured payload returned by `myflow_bg_stop`. */
export interface BgStopResult {
  task_id: string;
  /** True when this call actually terminated a running process tree. */
  stopped: boolean;
  /** True when there was nothing to terminate: the task had already ended. */
  already_finished: boolean;
  status: BackgroundTaskStatus;
  exit_code: number | null;
  pid: number;
  ended_at: string | null;
  /** The signal from the `.exit` record, when one was written. */
  signal?: string;
  /** Raw stderr from the kill command, present when it produced any. */
  stderr?: string;
  /** Present only on a refusal/error result. */
  error?: string;
}

/**
 * Injection surface for `myflow_bg_stop`.
 *
 * It extends the shared background registration (same `deriveContextKey` /
 * `isSubAgent` wiring as the other tools) and adds only a kill override. The
 * override exists so a test can prove the "never claim a stop that did not
 * happen" rule without needing an unkillable process: the real path
 * (`terminateTree`) is exercised by the process-tree test.
 */
export interface BgStopRegistration extends BgToolRegistration {
  /** Override the platform kill (tests); defaults to `terminateTree`. */
  terminate?: (pid: number) => KillOutcome;
}

/**
 * Terminate a process tree rooted at `pid`.
 *
 * Windows uses `taskkill /F /T` because it is the only reliable way to kill the
 * whole tree: the descendants of a background command are `cmd`/`bash` children
 * that `process.kill` does not reliably reach (ADR-6). The arguments are passed
 * as an **array**, never a single string, because Git Bash rewrites `/F` to
 * `F:/` if the command is routed through it (`design.md` §4.4).
 *
 * Everywhere else the wrapper is a process-group leader (the start tool spawns
 * it detached), so signalling the negative pid reaches the whole group; if the
 * group has already gone, the fallback signals the root pid directly.
 */
export function terminateTree(pid: number): KillOutcome {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
      encoding: "utf-8",
      windowsHide: true,
    });
    const raw = (result.stderr ?? "").trim();
    const stderr = raw || (result.error ? messageOf(result.error) : "");
    return { status: result.error ? null : result.status, stderr };
  }
  try {
    process.kill(-pid);
    return { status: 0, stderr: "" };
  } catch (groupError) {
    try {
      process.kill(pid);
      return { status: 0, stderr: "" };
    } catch (error) {
      return { status: 1, stderr: `${messageOf(groupError)}; fallback: ${messageOf(error)}` };
    }
  }
}

/**
 * Wait (bounded) for a killed process to disappear. Returns true once `isAlive`
 * is false, and the final verdict after the deadline otherwise. A single
 * immediate check would usually do — `taskkill /F` is synchronous for the tree
 * it kills — but a short bounded recheck makes a survivor a real verdict rather
 * than a race, and never waits forever.
 */
async function waitForProcessExit(pid: number): Promise<boolean> {
  if (!isAlive(pid)) return true;
  const deadline = Date.now() + STOP_RECHECK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(STOP_RECHECK_INTERVAL_MS);
    if (!isAlive(pid)) return true;
  }
  return !isAlive(pid);
}

function bgStopError(message: string, taskId: string) {
  return textResult(
    {
      task_id: taskId,
      stopped: false,
      already_finished: false,
      status: "unknown",
      exit_code: null,
      pid: 0,
      ended_at: null,
      error: message,
    },
    message,
    true,
  );
}

/** The human-readable stop result for a successful or idempotent call. */
function stopHumanText(result: BgStopResult): string {
  const code = result.exit_code === null ? "" : `, exit_code ${result.exit_code}`;
  if (result.already_finished) {
    return (
      `Task ${result.task_id} was already finished (${result.status}${code}); nothing to stop. ` +
      "Its recorded status and exit code were left untouched."
    );
  }
  const signal = result.signal ? `, signal ${result.signal}` : "";
  const lines = [
    `Stopped background task ${result.task_id} (pid ${result.pid}, status ${result.status}${code}${signal}).`,
    "The whole process tree was terminated.",
  ];
  if (result.stderr) {
    lines.push(`Note: the kill command reported: ${result.stderr}`);
  }
  return lines.join("\n");
}

/** The human-readable failure: the process survived, so nothing was recorded. */
function stopFailureText(result: BgStopResult): string {
  const lines = [
    `FAILED to stop task ${result.task_id} (pid ${result.pid}): the process is still alive.`,
    "The task was NOT recorded as stopped; read myflow_bg_output or retry myflow_bg_stop.",
  ];
  if (result.stderr) lines.push(`stderr: ${result.stderr}`);
  return lines.join("\n");
}

/** The JSON-schema parameter object for `myflow_bg_stop`. */
const BG_STOP_PARAMETERS = {
  type: "object",
  properties: {
    task_id: {
      type: "string",
      description: "The task id returned by myflow_bg_start (or listed by myflow_bg_list).",
    },
  },
  required: ["task_id"],
} as const;

/**
 * Build the `myflow_bg_stop` tool. Exported so tests can drive `execute` with a
 * stub context instead of a live Pi session; the registration function is the
 * production entry point (wired in F7).
 *
 * Behavior (`design.md` §4.4):
 *   - an already-finished task is a no-op that returns "already finished" and
 *     leaves the registry untouched, so a second stop never rewrites a real
 *     exit code;
 *   - a running task has its whole process tree killed, then `isAlive` is
 *     re-checked; success writes `status: "stopped"` and `ended_at`, keeping an
 *     exit code the wrapper may have raced in with;
 *   - a surviving process is an error carrying the raw stderr, and nothing is
 *     written — a stop is never reported as done when it is not.
 */
export function createBgStopTool(registration: BgStopRegistration = {}): Record<string, unknown> {
  return {
    name: BG_STOP_TOOL_NAME,
    label: "Myflow Background Stop",
    description: [
      "Stop a background task by killing its whole process tree.",
      "Idempotent: stopping an already-finished task reports that it was finished and changes nothing.",
      "It never reports success while the process survives; on failure it returns the raw kill error.",
      "Use myflow_bg_list to find task ids.",
    ].join(" "),
    promptSnippet: "Stop a background task",
    parameters: BG_STOP_PARAMETERS,

    async execute(
      _toolCallId: string,
      params: BgStopParams,
      _signal: AbortSignal | undefined,
      _onUpdate: ((partial: unknown) => void) | undefined,
      ctx: BgOutputContext,
    ) {
      // First line of the sub-agent guard; the tool_call hook is the second.
      const refusal = bgSubAgentRefusal(registration);
      if (refusal) return refusal;

      const taskId = typeof params?.task_id === "string" ? params.task_id.trim() : "";
      if (!taskId) {
        return bgStopError("`task_id` must be a non-empty string.", "");
      }

      const root = findProjectRoot(ctx?.cwd ?? process.cwd()) ?? ctx?.cwd ?? process.cwd();
      const dir = backgroundDir(root);
      const entry = readEntry(dir, taskId);
      if (!entry) {
        return bgStopError(
          `No background task "${taskId}" is registered. Use myflow_bg_list to see known task ids.`,
          taskId,
        );
      }

      const pid = typeof entry.pid === "number" ? entry.pid : 0;
      const resolved = resolveStatus(dir, entry);

      // Idempotent path: the task already ended (an `.exit` record, a
      // persisted `stopped`, or a sticky `exited`). Report the existing verdict
      // and write nothing, so a repeated stop can never overwrite a real exit
      // code with null — and, just as important, never `taskkill` a pid the OS
      // may have handed to an unrelated process (D1).
      if (isFinishedStatus(resolved.status)) {
        const result: BgStopResult = {
          task_id: taskId,
          stopped: false,
          already_finished: true,
          status: resolved.status,
          exit_code: resolved.exit_code,
          pid,
          ended_at: typeof entry.ended_at === "string" ? entry.ended_at : null,
          ...(resolved.signal ? { signal: resolved.signal } : {}),
        };
        return textResult(result as unknown as Record<string, unknown>, stopHumanText(result));
      }

      const terminate = registration.terminate ?? terminateTree;
      const outcome = terminate(pid);
      const gone = await waitForProcessExit(pid);
      if (!gone) {
        // The process survived. Do not write `stopped`: a later list/output
        // would contradict it. The raw stderr travels with the refusal.
        const result: BgStopResult = {
          task_id: taskId,
          stopped: false,
          already_finished: false,
          status: "running",
          exit_code: resolved.exit_code,
          pid,
          ended_at: null,
          ...(outcome.stderr ? { stderr: outcome.stderr } : {}),
        };
        return textResult(
          result as unknown as Record<string, unknown>,
          stopFailureText(result),
          true,
        );
      }

      // The tree is gone. Keep an exit code the wrapper raced in with (its
      // `.exit` record is authoritative); a forced stop with no record has no
      // code to report, which `design.md` §8 accepts.
      const exitRecord = readExitRecord(dir, entry);
      const exitCode = exitRecord ? normalizeExitCode(exitRecord.exit_code) : resolved.exit_code;
      const signal = exitRecord ? normalizeReason(exitRecord.signal) : null;
      const endedAt = new Date().toISOString();
      const updated: BackgroundEntry = {
        ...entry,
        status: "stopped",
        exit_code: exitCode,
        ended_at: endedAt,
      };
      try {
        writeEntry(dir, updated);
      } catch (error) {
        return bgStopError(
          `Task ${taskId} was terminated, but its registry entry could not be updated: ${messageOf(error)}`,
          taskId,
        );
      }

      const result: BgStopResult = {
        task_id: taskId,
        stopped: true,
        already_finished: false,
        status: "stopped",
        exit_code: exitCode,
        pid,
        ended_at: endedAt,
        ...(signal ? { signal } : {}),
        // A non-zero kill status is kept as a note, even though `isAlive` is
        // what decided success: it explains an unexpected-but-effective kill.
        ...(outcome.status !== 0 && outcome.stderr ? { stderr: outcome.stderr } : {}),
      };
      return textResult(result as unknown as Record<string, unknown>, stopHumanText(result));
    },
  };
}

// ---------------------------------------------------------------------------
// Registration
//
// The four tools above are exported individually so a test can drive one
// `execute` with a stub context. Production goes through
// `registerMyflowBackground`, the single place that puts them on Pi's API.
//
// Dependency injection, not an import of `./index.ts`: `index.ts` calls this
// function, so importing it back would close the `index.ts` -> `background.ts`
// -> `index.ts` cycle. Everything session-specific (the context-key deriver,
// the sub-agent flag, the started-id hook) is passed in by the caller, exactly
// as `ask.ts` / `approval.ts` do it.
//
// The factory registers tools and nothing else: it starts no process and no
// timer, because an extension factory runs before any session exists
// (`docs/extensions.md`: "Do not start processes or timers in the factory").
// ---------------------------------------------------------------------------

/** The four `myflow_bg_*` tool names, as one set for the main-session guard. */
export const BG_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  BG_START_TOOL_NAME,
  BG_OUTPUT_TOOL_NAME,
  BG_LIST_TOOL_NAME,
  BG_STOP_TOOL_NAME,
]);

/** Minimal `pi` surface used by the registration function. */
export interface BgPi {
  registerTool(tool: Record<string, unknown>): void;
}

/**
 * Register all four background tools on the Pi extension API.
 *
 * `registration` is forwarded verbatim to every builder, so all four share one
 * `isSubAgent` and one `deriveContextKey`. `onStarted` is only consulted by
 * `myflow_bg_start`, which calls it after the registry entry is written.
 */
export function registerMyflowBackground(pi: BgPi, registration: BgToolRegistration = {}): void {
  pi.registerTool(createBgStartTool(registration));
  pi.registerTool(createBgOutputTool(registration));
  pi.registerTool(createBgListTool(registration));
  pi.registerTool(createBgStopTool(registration));
}
