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
 *     original task. A present `.exit` record always outranks it.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
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
 * Write a file atomically: fill a sibling `.tmp`, then rename it into place.
 * A concurrent reader therefore sees the previous contents or the complete new
 * contents, never a half-written file (the same discipline `bg_runner.mjs`
 * applies to `<id>.exit`).
 */
function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  try {
    writeFileSync(tempPath, data, { encoding: "utf-8" });
    renameSync(tempPath, path);
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
 * Decide a task's state. The precedence is fixed and must not be reordered
 * (`design.md` §3.2, R9):
 *
 *   1. a present `.exit` record  => `exited`, with the recorded code;
 *   2. `entry.status === "stopped"` => `stopped` (a stop that raced the wrapper);
 *   3. the pid is alive          => `running`;
 *   4. otherwise                 => `exited` with `exit_code: null` (self-heal).
 *
 * Rule 1 outranking rule 3 is the point: a `.exit` record is authoritative even
 * if the OS has since reused the pid, so a long-dead task never reports as
 * running. Rule 4 self-heals an entry whose process vanished without a record.
 *
 * Pure: it reads the disk but never writes. Whether to persist the healed state
 * is the caller's decision.
 */
export function resolveStatus(dir: string, entry: BackgroundEntry): ResolvedStatus {
  const record = readExitRecord(dir, entry);
  if (record) {
    return { status: "exited", exit_code: normalizeExitCode(record.exit_code) };
  }
  if (entry.status === "stopped") {
    return { status: "stopped", exit_code: normalizeExitCode(entry.exit_code) };
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
        "The command to run in the background. Must be non-empty. It is executed by the " +
        "platform default shell (cmd.exe on Windows) — not Git Bash — so pipes, && and " +
        "redirection are interpreted by that shell.",
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
      "The command runs under the platform default shell (cmd.exe on Windows), not Git Bash.",
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
      // `exit` listener, so it cannot accidentally wait on the child.
      let pid: number | null;
      try {
        const child = spawnProcess(
          process.execPath,
          [runner, "--id", id, "--log", log, "--exit", exit, "--", command],
          { detached: true, stdio: "ignore", cwd: root },
        );
        child.unref();
        pid = typeof child.pid === "number" ? child.pid : null;
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

      // Step 4: return. No child-process event is awaited anywhere above.
      return textResult(
        { started: true, id, pid, log, confirmed_by: confirmedBy },
        startHumanText(id, pid, log, confirmedBy),
      );
    },
  };
}
