/**
 * Front-run registry — the on-disk record of every `myflow_subagent` run.
 *
 * A dispatched sub-agent used to be visible only as a log file under
 * `.myflow/.runtime/subagent-logs/`, so the caller — and any *other* session
 * sharing the project — had no way to see what is running, who dispatched it,
 * or what a run said. This module is the read/write layer for the answer: one
 * `<runId>.json` per run under `.myflow/.runtime/subagents/`, written by the
 * dispatcher and read by the `/mysubagents` board.
 *
 * Decisions that shape the file format:
 *
 *   - One file per run, written atomically (`.tmp` + rename). Concurrent
 *     sessions never write the same file, so there is no lost-update race and
 *     no lock; the cost is that `listRuns` reads a directory.
 *   - Liveness is *not* probed. `status: "running"` plus a heartbeat the
 *     dispatcher refreshes every second is enough: a reader that spawned
 *     `tasklist` per row would pay ~50ms per render at 1 fps, and a board that
 *     is slow to open is a board nobody opens. A missing heartbeat beyond
 *     `STALE_AFTER_MS` is therefore reported as `stale` — "the dispatching
 *     session is gone" — instead of being verified. Probing happens only where
 *     it is cheap and rare: the `x` key, which kills a recorded pid.
 *   - Terminal entries are pruned on open (`pruneRuns`), never during a write:
 *     the dispatcher's only job is to record the truth about its own run.
 *
 * Runtime imports are limited to Node builtins (plus the node-only background
 * registry, reused for `writeFileAtomic` and `PRUNE_AFTER_MS`) so this module
 * stays importable under `node --test` without the Pi package installed.
 */

import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { PRUNE_AFTER_MS, messageOf, writeFileAtomic } from "./background/registry.ts";
import { ctlPath } from "./ctl.ts";

/** The registry directory, relative to a project root. */
export const SUBAGENTS_DIR = join(".myflow", ".runtime", "subagents");

/**
 * How long a `running` run may go without a heartbeat before a reader calls it
 * `stale`. The dispatcher refreshes every second, so 30s of silence means the
 * session that owns the run is gone (a few missed ticks are tolerated).
 */
export const STALE_AFTER_MS = 30_000;

/** How many finished runs the registry keeps, newest first (`pruneRuns`). */
export const MAX_FINISHED_RUNS = 50;

/** The states a run reports. `queued` is a chain member that has not started. */
export type RunStatus = "queued" | "running" | "done" | "failed" | "timeout" | "stopped";

/** What a reader shows: the recorded status, or `stale` for a dead heartbeat. */
export type DisplayStatus = RunStatus | "stale";

/** The dispatch shape that produced a run; a group is one dispatch call. */
export type RunMode = "single" | "parallel" | "chain";

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["done", "failed", "timeout", "stopped"]);

/** Whether a status is final (its `endedAt` is set and it is prunable). */
export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * The session and process that dispatched a run. A project-level registry is
 * readable from any session, so every entry has to name its owner.
 */
export interface RunOwner {
  contextKey: string | null;
  pid: number;
}

/** One steer that reached the run, kept so the board can show it happened. */
export interface RunSteer {
  message: string;
  at: string;
}

/** One registry entry, `<dir>/<runId>.json` (`design.md` §2). */
export interface RunEntry {
  runId: string;
  /** One dispatch call = one group; `index` is 1-based within it. */
  group: string;
  index: number;
  total: number;
  agent: string;
  mode: RunMode;
  prompt: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  /** Refreshed every second while running; `displayStatus` reads only this. */
  heartbeatAt: string;
  pid: number | null;
  owner: RunOwner;
  logPath: string | null;
  task: string | null;
  model: string | null;
  exitCode: number | null;
  stopReason: string | null;
  errorMessage: string | null;
  steers: RunSteer[];
  /** Extra fields are tolerated so a newer writer does not break an older reader. */
  [key: string]: unknown;
}

/** A registry file that could not be read as an entry. Reported, never thrown. */
export interface RunWarning {
  file: string;
  reason: string;
}

/** A group of runs as the tree view sees it; aggregates are the view's job. */
export interface RunGroup {
  group: string;
  mode: RunMode;
  agent: string;
  runs: RunEntry[];
}

/**
 * Seed for the id suffix, mirroring `newTaskId`: two ids minted in the same
 * millisecond within one process are always distinct, and the random seed makes
 * a cross-process collision unlikely. Never derived from a pid (the OS reuses
 * them, and an id must outlive the process).
 */
let idSequence = randomBytes(2).readUInt16BE(0);

function idSuffix(): string {
  return (idSequence++ & 0xffff).toString(16).padStart(4, "0");
}

/** Mint a run id: `r-<epochMs>-<4 hex digits>`. */
export function newRunId(now: number = Date.now()): string {
  return `r-${Math.floor(now)}-${idSuffix()}`;
}

/** Mint a group id: `g-<epochMs>-<4 hex digits>`. */
export function newGroupId(now: number = Date.now()): string {
  return `g-${Math.floor(now)}-${idSuffix()}`;
}

/** The registry directory for a project root. */
export function runsDir(projectRoot: string): string {
  return join(projectRoot, SUBAGENTS_DIR);
}

/** `<dir>/<runId>.json` — the entry path. */
export function runPath(dir: string, runId: string): string {
  return join(dir, `${runId}.json`);
}

/**
 * Parse one registry file's text. Null for anything not usable as an entry —
 * invalid JSON, a truncated write, an array, or an object with no `runId` —
 * which is what turns a bad file into a warning instead of an exception.
 */
function parseRun(text: string): RunEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.runId !== "string" || record.runId.length === 0) return null;
  // A hand-edited or older entry must not crash a reader that counts steers.
  if (!Array.isArray(record.steers)) record.steers = [];
  return record as unknown as RunEntry;
}

/** Write one entry atomically. Returns the path it wrote. */
export function writeRun(dir: string, entry: RunEntry): string {
  const path = runPath(dir, entry.runId);
  writeFileAtomic(path, JSON.stringify(entry));
  return path;
}

/** Read one entry, or null when it is missing or unusable. */
export function readRun(dir: string, runId: string): RunEntry | null {
  let text: string;
  try {
    text = readFileSync(runPath(dir, runId), "utf-8");
  } catch {
    return null;
  }
  return parseRun(text);
}

function compareRuns(a: RunEntry, b: RunEntry): number {
  const aIndex = typeof a.index === "number" ? a.index : 0;
  const bIndex = typeof b.index === "number" ? b.index : 0;
  if (a.group !== b.group) return a.group < b.group ? -1 : 1;
  if (aIndex !== bIndex) return aIndex - bIndex;
  return a.runId === b.runId ? 0 : a.runId < b.runId ? -1 : 1;
}

/**
 * Display order: a group with something still live comes first (newest first),
 * then the finished tail newest-first.
 *
 * Grouping is the unit, not the run: a chain's members must stay together and
 * read `1..n` whatever order they finished in, so members of one group always
 * fall back to `compareRuns` (index order). `liveGroups` is precomputed because
 * one entry cannot know whether its siblings are still running.
 */
function compareForDisplay(a: RunEntry, b: RunEntry, liveGroups: ReadonlySet<string>): number {
  if (a.group === b.group) return compareRuns(a, b);
  const aLive = liveGroups.has(a.group) ? 0 : 1;
  const bLive = liveGroups.has(b.group) ? 0 : 1;
  if (aLive !== bLive) return aLive - bLive;
  const delta = groupRecencyMillis(b) - groupRecencyMillis(a);
  if (delta !== 0) return delta;
  return a.group < b.group ? -1 : 1;
}

/**
 * When a group was created, for display ordering.
 *
 * The `g-<epoch>` prefix is shared by every member, so it is stable; an entry
 * whose id carries no epoch falls back to its own `startedAt`, and something
 * with neither reads as "oldest" rather than "arbitrary".
 */
function groupRecencyMillis(entry: RunEntry): number {
  const match = /^g-(\d+)-/.exec(entry.group ?? "");
  if (match) return Number(match[1]);
  const started = Date.parse(entry.startedAt ?? "");
  return Number.isNaN(started) ? 0 : started;
}

/**
 * Read every entry in a directory, ordered by group then index.
 *
 * A file that does not parse is **skipped and reported** rather than thrown:
 * one truncated write must not blind the board to every other run. A missing
 * directory is simply empty (no run was ever dispatched).
 */
export function listRuns(dir: string): { runs: RunEntry[]; warnings: RunWarning[] } {
  const runs: RunEntry[] = [];
  const warnings: RunWarning[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { runs, warnings };
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
    const entry = parseRun(text);
    if (!entry) {
      warnings.push({ file, reason: "not a usable run entry (invalid JSON or missing runId)" });
      continue;
    }
    runs.push(entry);
  }
  const liveGroups = new Set<string>();
  for (const entry of runs) if (!isTerminal(entry.status)) liveGroups.add(entry.group);
  runs.sort((a, b) => compareForDisplay(a, b, liveGroups));
  return { runs, warnings };
}

/**
 * Group entries by `group`, preserving `index` order inside each group.
 *
 * Structural only: aggregate status and elapsed time belong to the view, so a
 * second dispatch to the same agent cannot inherit the first one's verdict.
 */
export function groupRuns(entries: readonly RunEntry[]): RunGroup[] {
  const groups = new Map<string, RunGroup>();
  for (const entry of entries) {
    const existing = groups.get(entry.group);
    if (existing) {
      existing.runs.push(entry);
      continue;
    }
    groups.set(entry.group, { group: entry.group, mode: entry.mode, agent: entry.agent, runs: [entry] });
  }
  // Group order follows the caller's (display) order; members are re-sorted by
  // index so a chain still reads 1..n whatever order the files were read in.
  for (const group of groups.values()) group.runs.sort(compareRuns);
  return [...groups.values()];
}

/** What to record for one member of a dispatch, before it starts. */
export interface QueueMember {
  agent: string;
  mode: RunMode;
  prompt: string;
  /** Defaults to `newRunId(now)`; the caller passes one when it needs it up front. */
  runId?: string;
  logPath?: string | null;
  task?: string | null;
  model?: string | null;
}

/** Who and when, for a whole dispatch. */
export interface QueueOptions {
  /** Defaults to `newGroupId(now)`; one call = one group. */
  group?: string;
  contextKey?: string | null;
  /** The dispatcher's pid; defaults to this process. Recorded, never probed here. */
  pid?: number;
  now?: number;
}

/**
 * Record every member of a dispatch as `queued` in one group before any of them
 * starts, so a chain member that has not had its turn is still visible (and a
 * cancelled group can address it).
 */
export function queueGroup(
  dir: string,
  members: readonly QueueMember[],
  options: QueueOptions = {},
): RunEntry[] {
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  const group = options.group ?? newGroupId(now);
  const owner: RunOwner = { contextKey: options.contextKey ?? null, pid: options.pid ?? process.pid };
  const total = members.length;
  const entries: RunEntry[] = [];
  for (let position = 0; position < members.length; position += 1) {
    const member = members[position];
    const entry: RunEntry = {
      runId: member.runId ?? newRunId(now),
      group,
      index: position + 1,
      total,
      agent: member.agent,
      mode: member.mode,
      prompt: member.prompt,
      status: "queued",
      startedAt: at,
      endedAt: null,
      heartbeatAt: at,
      pid: null,
      owner,
      logPath: member.logPath ?? null,
      task: member.task ?? null,
      model: member.model ?? null,
      exitCode: null,
      stopReason: null,
      errorMessage: null,
      steers: [],
    };
    writeRun(dir, entry);
    entries.push(entry);
  }
  return entries;
}

/** What a run learns the moment it actually starts. */
export interface StartPatch {
  pid?: number | null;
  logPath?: string | null;
  startedAt?: string;
}

/**
 * Flip a `queued` run to `running`.
 *
 * `startedAt` is reset to now on purpose: a chain member that waited minutes
 * for its turn must not report that wait as running time.
 */
export function markRunning(
  dir: string,
  runId: string,
  patch: StartPatch = {},
  now: number = Date.now(),
): RunEntry | null {
  const entry = readRun(dir, runId);
  if (!entry) return null;
  const at = new Date(now).toISOString();
  const updated: RunEntry = {
    ...entry,
    status: "running",
    pid: patch.pid ?? entry.pid ?? null,
    logPath: patch.logPath ?? entry.logPath ?? null,
    startedAt: patch.startedAt ?? at,
    heartbeatAt: at,
  };
  writeRun(dir, updated);
  return updated;
}

/**
 * Refresh `heartbeatAt`. This is the *only* sign of life a reader gets: no
 * process is probed, so a missed beat is what turns a run into `stale`.
 */
export function heartbeat(dir: string, runId: string, now: number = Date.now()): RunEntry | null {
  const entry = readRun(dir, runId);
  if (!entry) return null;
  const updated: RunEntry = { ...entry, heartbeatAt: new Date(now).toISOString() };
  writeRun(dir, updated);
  return updated;
}

/** Append a steer that reached the run (`design.md` §4). */
export function addSteer(
  dir: string,
  runId: string,
  message: string,
  now: number = Date.now(),
): RunEntry | null {
  const entry = readRun(dir, runId);
  if (!entry) return null;
  const updated: RunEntry = {
    ...entry,
    steers: [...entry.steers, { message, at: new Date(now).toISOString() }],
  };
  writeRun(dir, updated);
  return updated;
}

/** What the end of a run records beyond its status. */
export interface FinishPatch {
  exitCode?: number | null;
  stopReason?: string | null;
  errorMessage?: string | null;
  logPath?: string | null;
  endedAt?: string;
}

/** Record a run's final state: status, `endedAt`, and why it ended. */
export function finish(
  dir: string,
  runId: string,
  status: RunStatus,
  patch: FinishPatch = {},
  now: number = Date.now(),
): RunEntry | null {
  const entry = readRun(dir, runId);
  if (!entry) return null;
  const at = new Date(now).toISOString();
  const updated: RunEntry = {
    ...entry,
    status,
    endedAt: patch.endedAt ?? at,
    heartbeatAt: at,
    exitCode: patch.exitCode !== undefined ? patch.exitCode : entry.exitCode ?? null,
    stopReason: patch.stopReason !== undefined ? patch.stopReason : entry.stopReason ?? null,
    errorMessage: patch.errorMessage !== undefined ? patch.errorMessage : entry.errorMessage ?? null,
    logPath: patch.logPath ?? entry.logPath ?? null,
  };
  writeRun(dir, updated);
  return updated;
}

/**
 * What a reader displays for a run.
 *
 * Pure and reads only the entry: `running` whose heartbeat is older than
 * `STALE_AFTER_MS` is `stale`. An unreadable `heartbeatAt` counts as stale —
 * "nothing can prove it is alive" — because the alternative is an entry that
 * counts up as `running` forever after its dispatcher disappeared.
 */
export function displayStatus(entry: RunEntry, now: number = Date.now()): DisplayStatus {
  if (entry.status !== "running") return entry.status;
  const beat = Date.parse(entry.heartbeatAt);
  if (Number.isNaN(beat) || now - beat > STALE_AFTER_MS) return "stale";
  return "running";
}

/** `endedAt` in milliseconds, or 0 when the entry carries no usable date. */
function endedAtMillis(entry: RunEntry): number {
  const parsed = Date.parse(entry.endedAt ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Delete terminal entries that are older than 24h, then the oldest terminal
 * entries beyond `MAX_FINISHED_RUNS`. Returns how many entries were removed.
 *
 * Running, queued, and undateable entries are never touched: one may still
 * produce output, and something we cannot date is not something we delete.
 *
 * With `projectRoot`, the entry's log goes too, and log files nobody references
 * any more are swept once they are older than the same cutoff. Without that a
 * registry of 8 runs left 91 MB of orphaned transcripts behind: the entries were
 * pruned and the logs had no owner left to delete them.
 */
export function pruneRuns(dir: string, now: number = Date.now(), projectRoot?: string): number {
  const cutoff = now - PRUNE_AFTER_MS;
  const all = listRuns(dir).runs;
  const terminal = all.filter((entry) => isTerminal(entry.status));
  const doomed = new Set<string>();
  for (const entry of terminal) {
    const endedAt = Date.parse(entry.endedAt ?? "");
    if (!Number.isNaN(endedAt) && endedAt < cutoff) doomed.add(entry.runId);
  }
  const survivors = terminal
    .filter((entry) => !doomed.has(entry.runId))
    .sort((a, b) => endedAtMillis(b) - endedAtMillis(a));
  for (const entry of survivors.slice(MAX_FINISHED_RUNS)) doomed.add(entry.runId);
  const removed = terminal.filter((entry) => doomed.has(entry.runId));
  if (projectRoot) for (const entry of removed) removeLog(projectRoot, entry);
  for (const runId of doomed) {
    const path = runPath(dir, runId);
    rmSync(path, { force: true });
    rmSync(`${path}.tmp`, { force: true });
    rmSync(ctlPath(dir, runId), { force: true });
  }
  if (projectRoot) sweepOrphanLogs(projectRoot, all, doomed, cutoff);
  return doomed.size;
}

/** Delete one entry's log, if it recorded one. Never throws: pruning is best-effort. */
function removeLog(projectRoot: string, entry: RunEntry): void {
  if (!entry.logPath) return;
  try {
    rmSync(join(projectRoot, entry.logPath), { force: true });
  } catch {
    /* a log we cannot delete must not stop the registry prune */
  }
}

/**
 * Delete log files that no surviving entry points at and that are past the
 * cutoff.
 *
 * `deleteRun` deliberately keeps a run's log (it is the transcript a human may
 * still want to read), so the sweep is what finally reclaims them. Fresh orphans
 * are kept: a run whose entry was forgotten a minute ago may still be read.
 */
function sweepOrphanLogs(
  projectRoot: string,
  entries: readonly RunEntry[],
  doomed: ReadonlySet<string>,
  cutoff: number,
): void {
  const referenced = new Set<string>();
  const dirs = new Set<string>();
  for (const entry of entries) {
    if (!entry.logPath) continue;
    const absolute = join(projectRoot, entry.logPath);
    dirs.add(dirname(absolute));
    if (!doomed.has(entry.runId)) referenced.add(absolute.toLowerCase());
  }
  for (const logDir of dirs) {
    let names: string[];
    try {
      names = readdirSync(logDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".log")) continue;
      const absolute = join(logDir, name);
      if (referenced.has(absolute.toLowerCase())) continue;
      try {
        if (statSync(absolute).mtimeMs >= cutoff) continue;
        rmSync(absolute, { force: true });
      } catch {
        /* raced with a live run's first byte, or already gone */
      }
    }
  }
}

/**
 * Forget one run. Returns why it was refused, or null on success.
 *
 * A live run is refused rather than quietly deleted: its dispatcher is still
 * writing to that entry and will recreate it on the next transition, which would
 * leave a row the user believes they removed. Deleting is for the finished tail.
 */
export function deleteRun(dir: string, runId: string): string | null {
  const entry = readRun(dir, runId);
  if (!entry) return `run ${runId} is not in the registry`;
  if (!isTerminal(entry.status)) {
    return `run ${runId} is still ${entry.status}; stop it first`;
  }
  const path = runPath(dir, runId);
  rmSync(path, { force: true });
  rmSync(`${path}.tmp`, { force: true });
  rmSync(ctlPath(dir, runId), { force: true });
  return null;
}

/** Forget every finished run — the manual version of `pruneRuns`. */
export function deleteFinishedRuns(dir: string): number {
  let removed = 0;
  for (const entry of listRuns(dir).runs) {
    if (!isTerminal(entry.status)) continue;
    if (deleteRun(dir, entry.runId) !== null) continue;
    removed += 1;
  }
  return removed;
}
