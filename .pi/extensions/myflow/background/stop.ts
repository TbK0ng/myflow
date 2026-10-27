import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { findProjectRoot } from "../find-project-root.ts";
import type { BgOutputContext } from "./output.ts";
import { sleep, isFinishedStatus } from "./output.ts";
import type { BackgroundTaskStatus, BackgroundEntry } from "./registry.ts";
import type { BgToolRegistration } from "./tools.ts";
import { backgroundDir, messageOf, writeEntry, readEntry, isAlive, readPid, readExitRecord, normalizeExitCode, normalizeReason, resolveStatus } from "./registry.ts";
import { textResult, bgSubAgentRefusal } from "./tools.ts";

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
 * `taskkill /F /T` is the only reliable way to kill the whole tree on Windows:
 * the descendants of a background command are `cmd`/`bash` children that
 * `process.kill` does not reliably reach (ADR-6). The arguments are passed as an
 * **array**, never a single string, because Git Bash rewrites `/F` to `F:/` if
 * the command is routed through it (`design.md` §4.4).
 */
export function terminateTree(pid: number): KillOutcome {
  const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
    encoding: "utf-8",
    windowsHide: true,
  });
  const raw = (result.stderr ?? "").trim();
  const stderr = raw || (result.error ? messageOf(result.error) : "");
  return { status: result.error ? null : result.status, stderr };
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

/**
 * Where {@link stopBackgroundTask} takes its one test seam.
 *
 * The override exists so a test can prove the "never claim a stop that did not
 * happen" rule without needing an unkillable process; the real path
 * (`terminateTree`) is exercised by the process-tree test.
 */
export interface BackgroundStopDeps {
  /** Override the platform kill (tests); defaults to `terminateTree`. */
  terminate?: (pid: number) => KillOutcome;
}

/**
 * What one stop attempt reports: the tool's `details` object plus the text it
 * shows. One shape for every outcome keeps the tool a one-line wrapper.
 */
export interface BackgroundStopOutcome {
  details: Record<string, unknown>;
  text: string;
  isError: boolean;
}

function stopFailed(details: Record<string, unknown>, text: string): BackgroundStopOutcome {
  return { details, text, isError: true };
}

function bgStopError(message: string, taskId: string): BackgroundStopOutcome {
  return stopFailed(
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
  );
}

/** The human-readable refusal for a task that is not addressable yet (R7). */
function bgStopStartingError(taskId: string, pid: number): BackgroundStopOutcome {
  const message =
    `Task ${taskId} is still "starting": its wrapper has not confirmed a pid yet ` +
    `(no <id>.pid, no live pid). It is not addressable yet — retry in a moment. ` +
    "Nothing was killed and the registry entry was left untouched.";
  return stopFailed(
    {
      task_id: taskId,
      stopped: false,
      already_finished: false,
      status: "starting",
      exit_code: null,
      pid,
      ended_at: null,
      error: message,
    },
    message,
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
 *   - a `starting` task (entry written, no live pid confirmed yet) is refused
 *     with an explicit "not addressable yet" error: nothing is killed and
 *     nothing is written, because there is no pid to address — and "pid 0"
 *     means the whole process group, not a task;
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
      "A task still in status starting (pid not confirmed yet) is refused with an explicit error and nothing is killed or written; retry once it has a pid.",
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

      const root = findProjectRoot(ctx?.cwd ?? process.cwd()) ?? ctx?.cwd ?? process.cwd();
      const outcome = await stopBackgroundTask(backgroundDir(root), params?.task_id, {
        ...(registration.terminate ? { terminate: registration.terminate } : {}),
      });
      return textResult(outcome.details, outcome.text, outcome.isError);
    },
  };
}

/**
 * Stop one background task by its id, against an already-resolved registry
 * directory.
 *
 * Split out of the tool so the board's `x` key reaches the identical rules —
 * idempotence, the `starting` refusal, and "never claim a stop that did not
 * happen" — instead of re-implementing them.
 */
export async function stopBackgroundTask(
  dir: string,
  requestedId: unknown,
  deps: BackgroundStopDeps = {},
): Promise<BackgroundStopOutcome> {
  const taskId = typeof requestedId === "string" ? requestedId.trim() : "";
  if (!taskId) {
    return bgStopError("`task_id` must be a non-empty string.", "");
  }
  const entry = readEntry(dir, taskId);
  if (!entry) {
    return bgStopError(
      `No background task "${taskId}" is registered. Use myflow_bg_list to see known task ids.`,
      taskId,
    );
  }

  // One pid source for every reader (`design.md` §2.3): the wrapper's
  // `<id>.pid` handshake first, then the entry's cached pid. The cache can
  // still be `0` when the wrapper already wrote the handshake, so reading
  // the entry directly would refuse to address a live task.
  const pid = readPid(dir, entry);
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
    return { details: result as unknown as Record<string, unknown>, text: stopHumanText(result), isError: false };
  }

  // Not addressable yet (R7): the entry exists but no pid has been
  // confirmed. This is the window that used to make `stop` either miss the
  // task entirely or — worse — signal "pid 0" (the process group). Refuse
  // explicitly: no kill, no `stopped` write, so a later call (after `.pid`
  // appears, or after the `starting` timeout self-heals the entry) still
  // sees the truth.
  if (resolved.status === "starting") {
    return bgStopStartingError(taskId, pid);
  }

  const terminate = deps.terminate ?? terminateTree;
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
    return {
      details: result as unknown as Record<string, unknown>,
      text: stopFailureText(result),
      isError: true,
    };
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
  return { details: result as unknown as Record<string, unknown>, text: stopHumanText(result), isError: false };
}
