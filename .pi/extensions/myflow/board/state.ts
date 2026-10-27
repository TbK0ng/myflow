/**
 * The `/mysubagents` panel's data layer: registry files → one plain `BoardState`.
 *
 * Every view (board / tree / background) and the viewer render from this one
 * object, so the three views cannot disagree about what is running. Two rules
 * keep it honest:
 *
 *   - **The sources are the on-disk registries, never a live object.** The board
 *     is routinely opened from a *different* session than the dispatcher, so
 *     anything held in memory would show only this session's runs.
 *   - **`now` is a parameter.** Staleness and elapsed time are the two things
 *     every test needs to pin, and a clock read inside the builder would make
 *     the 30s stale boundary untestable.
 *
 * Selection is carried through and *clamped* here rather than in the renderer or
 * the reducer: a refresh can remove the selected row (a rerun, a prune), and the
 * one place that knows the new bounds is the place that just read them.
 *
 * Runtime imports are Node builtins plus the node-only `runs.ts` / background
 * registry / `transcript.ts`, so `node --test` can import this module directly.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { readLogTail } from "../background/output.ts";
import { backgroundDir, listEntries, resolveStatus } from "../background/registry.ts";
import type { BackgroundTaskStatus } from "../background/registry.ts";
import {
  displayStatus,
  groupRuns,
  isTerminal,
  listRuns,
  runsDir,
  type DisplayStatus,
  type RunEntry,
  type RunMode,
} from "../runs.ts";
import { lastLine, readTranscript, type TranscriptLine } from "./transcript.ts";

/** The screens the panel can show. `viewer` is a sub-screen of a list view. */
export type ViewName = "menu" | "board" | "tree" | "background";
export type View = ViewName | "viewer" | "help";

/** A view that lists rows and can be opened from the menu. */
export type ListView = Exclude<ViewName, "menu">;

/** The three list views, in menu order; the menu's index space is this array. */
export const MENU_ITEMS: readonly ListView[] = ["board", "tree", "background"];

/** A row the viewer can open. */
export type ViewTarget = { kind: "run"; runId: string } | { kind: "background"; id: string };

/** Where the cursor sits in each view. */
export interface Selection {
  /** Menu row. */
  menuIndex: number;
  /** Board row (runs first, then background) and background row. */
  index: number;
  /** Tree: which group, and which run inside it. */
  groupIndex: number;
  runIndex: number;
}

export const EMPTY_SELECTION: Selection = { menuIndex: 0, index: 0, groupIndex: 0, runIndex: 0 };

/** One front-run row. */
export interface RunView {
  runId: string;
  group: string;
  index: number;
  total: number;
  agent: string;
  mode: RunMode;
  /** The recorded status, or `stale` when the heartbeat stopped. */
  status: DisplayStatus;
  elapsedMs: number;
  /** Whether any steer reached this run (the board marks it `»`). */
  steered: boolean;
  /** Last readable line of its log, or null when it has said nothing yet. */
  preview: string | null;
  logPath: string | null;
  /** Why it failed, when the registry recorded a reason. */
  error: string | null;
}

/** One dispatch call: its header row plus its member runs. */
export interface GroupView {
  group: string;
  mode: RunMode;
  agent: string;
  /** Aggregate of the members; `running` outranks a finished sibling. */
  status: DisplayStatus;
  elapsedMs: number;
  runs: RunView[];
}

/** One background (detached) task row. */
export interface BackgroundView {
  id: string;
  command: string;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  elapsedMs: number;
  logPath: string;
  /** Always true: these tasks outlive the terminal that started them. */
  detached: true;
}

/** The opened session viewer. */
export interface ViewerState {
  target: ViewTarget;
  title: string;
  subtitle: string;
  lines: TranscriptLine[];
}

/** Everything the renderer needs, and nothing it has to compute itself. */
export interface BoardState {
  /** The task the newest run belongs to, for the header. */
  task: string | null;
  /** Every run, ordered by group then index. */
  runs: RunView[];
  groups: GroupView[];
  background: BackgroundView[];
  selection: Selection;
  viewer: ViewerState | null;
  /** Registry files that could not be read; surfaced instead of swallowed. */
  warnings: string[];
}

export interface BuildStateOptions {
  projectRoot: string;
  /** Injected so staleness and elapsed time are testable. */
  now?: number;
  /**
   * No `view` field on purpose: the data is the same for all three views, and
   * the cursor is already carried in `selection`. A view flag here would let the
   * data and the renderer disagree about what is selected.
   */
  selection?: Partial<Selection>;
  /** Populates `state.viewer`; null/absent leaves it closed. */
  viewer?: ViewTarget | null;
}

/** How much of a background task's output the viewer shows. */
export const BACKGROUND_TAIL_BYTES = 32 * 1024;

function elapsedBetween(startedAt: string, endedAt: string | null, now: number): number {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return 0;
  const end = endedAt ? Date.parse(endedAt) : now;
  const bounded = Number.isNaN(end) ? now : end;
  return Math.max(0, bounded - start);
}

function toRunView(entry: RunEntry, now: number, logFile: string | null): RunView {
  return {
    runId: entry.runId,
    group: entry.group,
    index: typeof entry.index === "number" ? entry.index : 0,
    total: typeof entry.total === "number" ? entry.total : 1,
    agent: entry.agent,
    mode: entry.mode,
    status: displayStatus(entry, now),
    elapsedMs: elapsedBetween(entry.startedAt, entry.endedAt, now),
    steered: Array.isArray(entry.steers) && entry.steers.length > 0,
    preview: logFile ? lastLine(logFile) : null,
    logPath: entry.logPath ?? null,
    error: entry.errorMessage ?? entry.stopReason ?? null,
  };
}

/**
 * A group's aggregate status.
 *
 * The order is the point: one member still running makes the whole dispatch
 * "running" even if a sibling already failed, because the group is not over yet.
 * `queued` outranks the terminal states for the same reason (a chain member has
 * not had its turn). Otherwise the first real failure names the group.
 */
export function aggregateStatus(statuses: readonly DisplayStatus[]): DisplayStatus {
  const has = (value: DisplayStatus) => statuses.includes(value);
  if (has("running")) return "running";
  if (has("queued")) return "queued";
  if (has("stale")) return "stale";
  if (has("failed")) return "failed";
  if (has("timeout")) return "timeout";
  if (has("stopped")) return "stopped";
  return "done";
}

function toGroupViews(
  entries: readonly RunEntry[],
  now: number,
  resolveLog: (entry: RunEntry) => string | null,
): GroupView[] {
  return groupRuns(entries).map((group) => {
    const runs = group.runs.map((entry) => toRunView(entry, now, resolveLog(entry)));
    const starts = group.runs.map((entry) => Date.parse(entry.startedAt)).filter((value) => !Number.isNaN(value));
    const finished = group.runs.every((entry) => isTerminal(entry.status) && entry.endedAt);
    const ends = group.runs
      .map((entry) => (entry.endedAt ? Date.parse(entry.endedAt) : now))
      .filter((value) => !Number.isNaN(value));
    const from = starts.length > 0 ? Math.min(...starts) : now;
    const to = finished ? (ends.length > 0 ? Math.max(...ends) : now) : now;
    return {
      group: group.group,
      mode: group.mode,
      agent: group.agent,
      status: aggregateStatus(runs.map((run) => run.status)),
      elapsedMs: Math.max(0, to - from),
      runs,
    };
  });
}

/** The project-relative log path a run recorded, resolved to a real file path. */
function resolveLogPath(projectRoot: string, value: string | null): string | null {
  return value ? join(projectRoot, value) : null;
}

function newestTask(entries: readonly RunEntry[]): string | null {
  let best: { at: number; task: string } | null = null;
  for (const entry of entries) {
    if (!entry.task) continue;
    const at = Date.parse(entry.startedAt);
    const stamp = Number.isNaN(at) ? 0 : at;
    if (!best || stamp >= best.at) best = { at: stamp, task: entry.task };
  }
  return best ? best.task : null;
}

function clamp(value: number, max: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  const bounded = Math.floor(value);
  return bounded > max ? max : bounded;
}

/** The first 8 characters of an id, the width the board shows. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * Clamp a selection to what the freshly read registries actually contain.
 *
 * Navigation wraps, so a stale index is normal (a run finished and was pruned
 * while the panel was open) — it must land on the nearest existing row instead
 * of rendering an empty cursor.
 */
export function clampSelection(
  selection: Selection,
  state: Pick<BoardState, "groups" | "runs" | "background">,
): Selection {
  const groupIndex = clamp(selection.groupIndex, Math.max(0, state.groups.length - 1));
  const runMax = Math.max(0, (state.groups[groupIndex]?.runs.length ?? 1) - 1);
  return {
    menuIndex: clamp(selection.menuIndex, MENU_ITEMS.length - 1),
    index: clamp(selection.index, Math.max(0, state.runs.length + state.background.length - 1)),
    groupIndex,
    runIndex: clamp(selection.runIndex, runMax),
  };
}

/**
 * The parsed transcript of each log, keyed by the file's size.
 *
 * The panel rebuilds its state once a second, and a run's log can reach megabytes
 * (every tool result is in it), so re-parsing it on every tick would spend the
 * render thread on a file that changed by one line. Size is the invalidation key
 * because a log is append-only. `TRANSCRIPT_CACHE_LIMIT` bounds the memory: the
 * oldest log seen is dropped rather than accumulated for hours.
 *
 * shortcut: one cached entry per open viewer, evicted after
 * `TRANSCRIPT_CACHE_LIMIT` distinct logs — upgrade only if the panel ever shows
 * many transcripts at once.
 */
const transcriptCache = new Map<string, { size: number; lines: TranscriptLine[] }>();
export const TRANSCRIPT_CACHE_LIMIT = 8;

function cachedTranscript(path: string): TranscriptLine[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  const hit = transcriptCache.get(path);
  if (hit && hit.size === size) {
    // Re-insert so the eviction below drops the least recently read log.
    transcriptCache.delete(path);
    transcriptCache.set(path, hit);
    return hit.lines;
  }
  const lines = readTranscript(path);
  transcriptCache.set(path, { size, lines });
  if (transcriptCache.size > TRANSCRIPT_CACHE_LIMIT) {
    const oldest = transcriptCache.keys().next().value;
    if (oldest !== undefined) transcriptCache.delete(oldest);
  }
  return lines;
}

/**
 * Build the viewer's content for one target.
 *
 * A run is rendered through `transcript.ts` (its log is rpc JSONL); a background
 * task is shown as an output tail (`readLogTail`, because its log is plain text).
 * Both are **read-only**: nothing here advances a read cursor, so opening the
 * viewer from the board cannot consume output the session's own
 * `myflow_bg_output` still has to read.
 */
function buildViewer(
  target: ViewTarget,
  now: number,
  projectRoot: string,
  entries: readonly RunEntry[],
  background: readonly BackgroundView[],
): ViewerState | null {
  if (target.kind === "run") {
    const entry = entries.find((candidate) => candidate.runId === target.runId);
    if (!entry) return null;
    const file = resolveLogPath(projectRoot, entry.logPath);
    return {
      target,
      title: `${shortId(entry.runId)} · ${entry.agent} · ${entry.mode} ${entry.index}/${entry.total}`,
      subtitle: `${displayStatus(entry, now)} · ${entry.logPath ?? "no log yet"}`,
      lines: file ? cachedTranscript(file) : [],
    };
  }
  const entry = background.find((candidate) => candidate.id === target.id);
  if (!entry) return null;
  const lines = readLogTail(backgroundDir(projectRoot), entry.id, BACKGROUND_TAIL_BYTES)
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ kind: "result" as const, text: line }));
  return {
    target,
    title: `${entry.id} · ${(entry.command.split("\n")[0] ?? "").trim()}`,
    subtitle: `${entry.status} · detached · ${entry.logPath}`,
    lines,
  };
}

/**
 * Read both registries and build the view state.
 *
 * Read-only: it never writes, never prunes, and never spawns a process to check
 * liveness (see `runs.ts` on why the heartbeat, not `tasklist`, decides).
 */
export function buildState(options: BuildStateOptions): BoardState {
  const now = options.now ?? Date.now();
  const { projectRoot } = options;
  const runRead = listRuns(runsDir(projectRoot));
  const bgDir = backgroundDir(projectRoot);
  const bgRead = listEntries(bgDir);
  const resolveLog = (entry: RunEntry) => resolveLogPath(projectRoot, entry.logPath);

  const background: BackgroundView[] = bgRead.entries.map((entry) => {
    const resolved = resolveStatus(bgDir, entry, now);
    const endedAt = typeof entry.ended_at === "string" ? entry.ended_at : null;
    return {
      id: entry.id,
      command: typeof entry.command === "string" ? entry.command : "",
      status: resolved.status,
      exitCode: resolved.exit_code,
      elapsedMs: elapsedBetween(String(entry.started_at ?? ""), endedAt, now),
      logPath: typeof entry.log === "string" && entry.log ? join(projectRoot, entry.log) : join(bgDir, `${entry.id}.log`),
      detached: true,
    };
  });

  const partial = {
    task: newestTask(runRead.runs),
    runs: runRead.runs.map((entry) => toRunView(entry, now, resolveLog(entry))),
    groups: toGroupViews(runRead.runs, now, resolveLog),
    background,
    viewer: null as ViewerState | null,
    warnings: [
      ...runRead.warnings.map((warning) => `run registry: ${warning.file} — ${warning.reason}`),
      ...bgRead.warnings.map((warning) => `background registry: ${warning.file} — ${warning.reason}`),
    ],
  };

  return {
    ...partial,
    selection: clampSelection({ ...EMPTY_SELECTION, ...(options.selection ?? {}) }, partial),
    viewer: options.viewer ? buildViewer(options.viewer, now, projectRoot, runRead.runs, background) : null,
  };
}
