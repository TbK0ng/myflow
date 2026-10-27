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
 *   <taskId>.pid    the wrapper's own handshake — written by `bg_runner.mjs`
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
 *   - Liveness is `process.kill(pid, 0)`, which can mistake a reused PID for the
 *     original task. Two things outrank it: a present `.exit` record, and an
 *     entry already recorded as `exited`/`stopped` (a finished verdict is
 *     sticky, so a reused pid can neither resurrect a task nor make a stop
 *     kill an unrelated process). The residual risk is narrower: a task whose
 *     pid was reused *before any reader ever observed it* still reads as
 *     running, because nothing on disk records that it died.
 *
 * The orphan window is **closed**, not merely narrowed: the entry is written as
 * `starting` before the spawn, and the wrapper writes its own `<taskId>.pid`
 * before it can run anything, so a command never executes without a pid on
 * disk (ADR-8). A `starting` entry that never produces a handshake self-heals
 * to `exited` after `STARTING_TIMEOUT_MS`, and `myflow_bg_stop` refuses it
 * instead of signalling pid 0.
 *
 * `exit_code` is nullable everywhere: a stop that force-kills the wrapper leaves
 * `status: "stopped"` with no code, and a self-healed entry records `null`.
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

/** The registry directory, relative to a project root. */
export const BACKGROUND_DIR = join(".myflow", ".runtime", "background");

/** The per-session cursor sub-directory, a child of the registry directory. */
export const CURSORS_SUBDIR = "cursors";

/** Separator between a context key and a task id in a cursor file name. */
export const CURSOR_SEPARATOR = "__";

/** Finished tasks older than this are eligible for `prune`. */
export const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * How long an entry may sit in `starting` before it is read as "never started".
 *
 * `starting` covers only the window between the tool writing the entry and the
 * wrapper writing `<id>.pid` — milliseconds. The timeout is generous because it
 * is a *self-heal deadline*, not a race: a task that never produced a pid must
 * eventually become visible as finished instead of blocking `stop` forever
 * (`design.md` §2.2). It is injected through `resolveStatus`'s `nowMs`, so the
 * boundary is testable without sleeping.
 */
export const STARTING_TIMEOUT_MS = 60_000;

/**
 * The four reachable states a task reports, plus `unknown` for an untrusted
 * result.
 *
 * `starting` is the fourth *reachable* state: the registry entry exists but the
 * wrapper has not confirmed its pid yet (`<id>.pid` missing, no live pid, and
 * the entry is younger than `STARTING_TIMEOUT_MS`). It is a state, not
 * "running with a flag", because `list` / `output` / `stop` all have to say
 * something honest about it (ADR-10). `unknown` stays unreachable: the tools
 * never resolve to it themselves, it only labels a refusal payload.
 */
export type BackgroundTaskStatus = "starting" | "running" | "exited" | "stopped" | "unknown";

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
  /**
   * The pid `spawn` reported to the tool, cached at start time. **Never read it
   * directly**: it stays `0` until the tool's write-back lands, and it is a
   * value *about* a process, not a statement *by* that process. Use
   * `readPid(dir, entry)`, which prefers the wrapper's own `<id>.pid`
   * handshake (`design.md` §2.3).
   */
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

/**
 * The parsed shape of a `<taskId>.exit` record written by `bg_runner.mjs`.
 *
 * The wrapper has always written `shell` (on every record) and `retries` (only
 * when creation was retried); the type used to admit neither, so a reader could
 * not see them without casting. They are here now because a reader exists:
 * `myflow_bg_output` reports both once a task has finished (H3/R3).
 */
export interface ExitRecord {
  exit_code: number | null;
  /**
   * The shell that actually ran the command, or `null` for a refusal (no POSIX
   * shell resolved, so nothing ran). `null` is a recorded fact, not "unknown".
   */
  shell?: string | null;
  /**
   * How many times the wrapper retried creation before this outcome. Absent
   * when the first attempt succeeded, so an absent field means "no retries".
   */
  retries?: number;
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
 * `<dir>/<id>.pid` — the pid handshake, written by the *wrapper* (`design.md`
 * §3.3 / ADR-8).
 *
 * The tools never write it: it is the wrapper's own statement that this pid
 * belongs to the task, and it is written before the command can run. That is
 * what makes it authoritative over the entry's `pid`, which is only the value
 * `spawn` returned to the tool a moment later.
 */
export function pidPath(dir: string, id: string): string {
  return join(dir, `${id}.pid`);
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

export function messageOf(error: unknown): string {
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
 * Non-positive and non-integer pids are rejected up front: on Windows
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

/** A positive integer, or 0 for anything else (0 means "no pid known"). */
function normalizePid(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return 0;
  return value;
}

/**
 * The pid recorded by the wrapper's handshake file, or 0 when it is missing,
 * unreadable, or does not carry a positive integer.
 *
 * A corrupt/incomplete `.pid` is treated as absent rather than as an error: the
 * wrapper writes it atomically, so this is only the defensive branch, and
 * falling back to the entry's cached pid is strictly better than failing a
 * status read.
 */
export function readPidFile(dir: string, id: string): number {
  let text: string;
  try {
    text = readFileSync(pidPath(dir, id), "utf-8");
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
  return normalizePid((parsed as Record<string, unknown>).pid);
}

/**
 * The single place a task's pid is decided (`design.md` §2.3 / ADR-8).
 *
 * Priority: the wrapper's own `<id>.pid` handshake, then the entry's cached
 * `pid`. The cache is *not* trusted first: it is `spawn`'s return value, which
 * the tool writes after spawning, so a crash between spawn and that write-back
 * leaves `pid: 0` in the entry even though the wrapper is running and has said
 * so. Reading the handshake first is what makes `starting` resolve to `running`
 * as soon as the wrapper confirms itself.
 *
 * Every caller (`resolveStatus`, `myflow_bg_stop`, and through it `list` /
 * `output` / `session_shutdown`) goes through this function so the two sources
 * can never disagree between tools. 0 means "no pid known", never "pid 0".
 */
export function readPid(dir: string, entry: BackgroundEntry): number {
  const recorded = readPidFile(dir, entry.id);
  if (recorded > 0) return recorded;
  return normalizePid(entry.pid);
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

export function normalizeExitCode(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Normalize a reason string (`error` / `signal` from a `.exit` record). A blank
 * value is dropped so a present-but-empty field does not render as an empty
 * `failure:` line.
 */
export function normalizeReason(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Normalize the `.exit` record's `shell`.
 *
 * `null` survives normalization on purpose: the wrapper records a *refusal*
 * (no POSIX shell resolved, nothing ran) as `shell: null`, which must stay
 * distinguishable from "this record predates the field". A blank or non-string
 * value is the latter and is reported as `null` too — the honest answer either
 * way is "no shell name is on record".
 */
export function normalizeExitShell(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Normalize the `.exit` record's `retries`. Returns `null` when the field is
 * absent, which the caller turns into "omit the field" rather than `0`: the
 * wrapper only writes `retries` once it has retried, so absence carries the
 * same information as a zero would, without inventing a value.
 */
export function normalizeRetryCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * Decide a task's state. The precedence is fixed and must not be reordered
 * (`design.md` §2.2, R9):
 *
 *   1. a present `.exit` record       => `exited`, with the recorded code;
 *   2. `entry.status === "stopped"`   => `stopped` (a stop that raced the wrapper);
 *   3. `entry.status === "exited"`    => `exited` (a verdict already reached stays);
 *   4. the pid is alive               => `running`;
 *   5. `entry.status === "starting"` and the entry is younger than
 *      `STARTING_TIMEOUT_MS`          => `starting` (the handshake has not landed);
 *   6. otherwise                      => `exited` with `exit_code: null`
 *      (self-heal: a task that never started, or one whose process vanished).
 *
 * Rules 1 and 3 both outrank rule 4, and for the same reason: a task that has
 * already been judged finished must never come back to life because the OS
 * reused its pid. Rule 3 is what makes a self-healed entry *sticky* — without
 * it, `list` would write `exited` and the next read would flip the entry back
 * to `running`, which would let `myflow_bg_stop` `taskkill` an unrelated
 * process that inherited the pid (D1). Rule 1 still wins over rule 3, so a
 * `.exit` record that arrives later overwrites a healed verdict's exit code.
 *
 * Rule 4 outranks rule 5 on purpose: once a pid is known and alive the task is
 * *confirmed*, so an entry still saying `starting` (the write-back did not
 * happen yet) must report `running`, not `starting` — otherwise `stop` would
 * refuse to address a task that is plainly running.
 *
 * Rule 5 has to sit before rule 6, and its bound is what keeps `starting` from
 * being a terminal state: a wrapper that died before writing `.pid` leaves an
 * entry nobody can address, so after the timeout it self-heals to `exited`
 * (`exit_code: null`: it never started).
 *
 * `nowMs` is an explicit parameter (never read from the clock here) so the
 * timeout boundary and the future callers' clocks stay testable; production
 * callers pass nothing and get `Date.now`.
 *
 * Pure: it reads the disk but never writes. Whether to persist the healed state
 * is the caller's decision.
 */
export function resolveStatus(
  dir: string,
  entry: BackgroundEntry,
  nowMs: number = Date.now(),
): ResolvedStatus {
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
  // One pid source for every reader (`.pid` handshake first, then the entry).
  if (isAlive(readPid(dir, entry))) {
    return { status: "running", exit_code: null };
  }
  if (entry.status === "starting") {
    const startedAt = parseTimestamp(entry.started_at);
    // An undateable `starting` entry cannot be timed out; treating it as
    // `starting` forever would block `stop` on a task nobody can address, so
    // only a *known* timestamp inside the window keeps the state.
    if (startedAt !== null && nowMs - startedAt <= STARTING_TIMEOUT_MS) {
      return { status: "starting", exit_code: null };
    }
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

/**
 * Whether a task has ended. A `.exit` record or an ended status both count; a
 * `starting` entry counts only once it is past `STARTING_TIMEOUT_MS`, because
 * until then it is a task that may still confirm itself (and pruning it would
 * race the wrapper).
 *
 * A **live pid** outranks the `starting` timeout, for the same reason level 4
 * outranks level 5 in `resolveStatus`: the wrapper wrote its `<id>.pid`
 * handshake, so the task did start — only the tool's `running` write-back never
 * landed (the tool crashed between `spawn` and that second write). Deleting such
 * an entry, its log and its `.pid` would leave a running command with no
 * registry entry at all: exactly the orphan this feature exists to prevent. A
 * reused pid can therefore keep an old `starting` entry unprunable, which is the
 * safe direction — the documented pid-identity limit, never a deletion.
 */
function isFinished(dir: string, entry: BackgroundEntry, nowMs: number): boolean {
  if (existsSync(exitPathFor(dir, entry))) return true;
  if (entry.status === "exited" || entry.status === "stopped") return true;
  if (isAlive(readPid(dir, entry))) return false;
  if (entry.status === "starting") {
    const startedAt = parseTimestamp(entry.started_at);
    return startedAt === null || nowMs - startedAt > STARTING_TIMEOUT_MS;
  }
  return false;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * When a task ended, in milliseconds: the entry's `ended_at`, falling back to
 * the `.exit` record's `at`, then (for a `starting` entry that never started)
 * to its `started_at`. Null when nothing dates the task, in which case `prune`
 * leaves it alone rather than guessing.
 */
function endedAtOf(dir: string, entry: BackgroundEntry): number | null {
  const fromEntry = parseTimestamp(entry.ended_at);
  if (fromEntry !== null) return fromEntry;
  const fromRecord = parseTimestamp(readExitRecord(dir, entry)?.at);
  if (fromRecord !== null) return fromRecord;
  // A never-confirmed `starting` entry has neither an `ended_at` nor a `.exit`:
  // the moment it was written is the only date it has. Using it keeps such a
  // residue prunable instead of frozen in the registry forever.
  if (entry.status === "starting") return parseTimestamp(entry.started_at);
  return null;
}

/**
 * Delete an entry's `.json` / `.log` / `.exit` / `.pid` and every session's
 * cursor for it.
 *
 * The `.pid` handshake is the wrapper's file, but it belongs to this task, so it
 * is deleted with it (and with their `.tmp` siblings, which a failed atomic
 * write can leave behind).
 */
function removeEntryFiles(dir: string, entry: BackgroundEntry): void {
  const files = new Set([
    entryPath(dir, entry.id),
    logPath(dir, entry.id),
    exitPath(dir, entry.id),
    `${exitPath(dir, entry.id)}.tmp`,
    exitPathFor(dir, entry),
    pidPath(dir, entry.id),
    `${pidPath(dir, entry.id)}.tmp`,
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
 * boundary is testable. A running task is never touched, a `starting` task is
 * left alone until its handshake timeout has passed **and** no pid reads alive,
 * and a finished task with no usable end date is left in place: something we
 * cannot date is not something we should delete.
 */
export function prune(dir: string, now: number): number {
  const cutoff = now - PRUNE_AFTER_MS;
  const { entries } = listEntries(dir);
  let removed = 0;
  for (const entry of entries) {
    if (!isFinished(dir, entry, now)) continue;
    const endedAt = endedAtOf(dir, entry);
    if (endedAt === null || endedAt >= cutoff) continue;
    removeEntryFiles(dir, entry);
    removed += 1;
  }
  return removed;
}

/**
 * Forget one finished task, its log, its `.pid` handshake, and its cursors.
 *
 * Returns the refusal reason, or null on success. A live task is refused rather
 * than deleted: `isFinished` already knows how to tell a leftover `.pid` from a
 * running command, and deleting a live entry would leave the command running
 * with nothing pointing at it — the orphan this feature exists to prevent.
 *
 * Unlike a front run (whose transcript is the point and is kept), a task's log
 * goes with it, exactly as `prune` already does.
 */
export function deleteFinishedTask(dir: string, id: string, now: number = Date.now()): string | null {
  const entry = readEntry(dir, id);
  if (!entry) return `background task ${id} is not in the registry`;
  if (!isFinished(dir, entry, now)) {
    return `background task ${id} is still ${entry.status}; stop it first`;
  }
  removeEntryFiles(dir, entry);
  return null;
}

/** Forget every finished task — the manual version of `prune`, with no 24h wait. */
export function deleteFinishedTasks(dir: string, now: number = Date.now()): number {
  const { entries } = listEntries(dir);
  let removed = 0;
  for (const entry of entries) {
    if (!isFinished(dir, entry, now)) continue;
    removeEntryFiles(dir, entry);
    removed += 1;
  }
  return removed;
}

