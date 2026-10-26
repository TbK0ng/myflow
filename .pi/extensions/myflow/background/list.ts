import { join } from "node:path";
import { spawn } from "node:child_process";
import { findProjectRoot } from "../find-project-root.ts";
import type { BgOutputContext } from "./output.ts";
import type { BackgroundTaskStatus, ConfirmedBy, BackgroundEntry, ResolvedStatus, BackgroundWarning } from "./registry.ts";
import type { BgToolRegistration } from "./tools.ts";
import { FALLBACK_CONTEXT_KEY, isFinishedStatus } from "./output.ts";
import { backgroundDir, writeEntry, listEntries, readPid, readExitRecord, resolveStatus, prune } from "./registry.ts";
import { textResult, bgSubAgentRefusal } from "./tools.ts";

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
  let resolved = resolveStatus(dir, entry, nowMs);
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
  dir: string,
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
    // The same pid source `resolveStatus` used (`.pid` handshake first): showing
    // the entry's cached pid here would print `0` for a task the row calls
    // `running`, which reads like a bug in the listing.
    pid: readPid(dir, entry),
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
      "status: starting means the registry entry exists but the wrapper has not confirmed a pid yet; it is not an error, and after 60 seconds without a pid the task is judged never started and reported as exited.",
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
        tasks.push(toListRow(dir, outcome.entry, outcome.resolved, contextKey));
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

