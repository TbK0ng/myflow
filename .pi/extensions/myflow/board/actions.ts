/**
 * Executes the actions `keys.ts` produces.
 *
 * The split exists for one reason: "what can the board do?" must be answerable
 * without a terminal, a process, or a registry. `keys.ts` decides *whether* a key
 * may act (board: never; tree: stop/steer/rerun; background: the three task
 * operations) and this module carries the act out.
 *
 * Everything with a side effect outside these files is injected: the control-file
 * writer, the process-tree killer, the dispatcher used by `r`, and the three
 * background operations. The defaults are the real implementations, so a panel
 * opened without them still works; a test passes recorders and asserts exactly
 * what was written, killed, or started — including that `restart-run` returns
 * before the new run can settle.
 *
 * The operations that address a *run* write the project-level registry, never an
 * in-memory handle: the board is routinely opened from a session that did not
 * dispatch the run, and the dispatcher's files are the only thing both sessions
 * share. The background operations reuse `stopBackgroundTask` /
 * `startBackgroundTask` for the same reason: `x`, `r` here and the `myflow_bg_*`
 * tools must not be able to disagree about what a stop or a start means.
 *
 * Runtime imports are Node builtins plus the node-only `runs.ts` / `ctl.ts` /
 * `transport.ts` / `background/` modules, so `node --test` imports this directly.
 */

import { backgroundDir, messageOf, prune as pruneRegistry, readEntry } from "../background/registry.ts";
import { startBackgroundTask, type BackgroundStartOutcome } from "../background/start.ts";
import { stopBackgroundTask, type BackgroundStopOutcome } from "../background/stop.ts";
import { appendControl, ctlPath, type ControlInput } from "../ctl.ts";
import {
  deleteFinishedRuns,
  deleteRun,
  displayStatus,
  finish,
  isTerminal,
  listRuns,
  newGroupId,
  queueGroup,
  readRun,
  runsDir,
} from "../runs.ts";
import { killChildTree } from "../transport.ts";
import type { Action } from "./keys.ts";
import { shortId } from "./state.ts";

/** What one key press achieved, in one line the panel can show. */
export interface ActionResult {
  ok: boolean;
  /** Empty when there is nothing to say (the panel then stays quiet). */
  message: string;
}

/**
 * A background task to replay: the fields `startBackgroundTask` needs to start
 * the same command again. Taken from the registry entry, never re-derived.
 */
export interface RerunBackgroundRequest {
  command: string;
  description?: string;
  cwd?: string;
}

/** A request to dispatch a run again; `board/index.ts` fills in the agent. */
export interface RestartRequest {
  projectRoot: string;
  /** The freshly allocated run id (and group) the new dispatch uses. */
  runId: string;
  group: string;
  agent: string;
  prompt: string;
  model: string | null;
  contextKey: string | null;
}

export interface ActionDeps {
  projectRoot: string;
  /** Which session asked, recorded on every control line. */
  contextKey?: string | null;
  /** Queue one control line; defaults to `appendControl`. */
  writeControl?: (path: string, command: ControlInput) => unknown;
  /** Kill a front run's process tree; defaults to `killChildTree`. */
  killTree?: (pid: number | undefined) => void;
  /**
   * Start a re-dispatched run and return without waiting for it to settle.
   * Absent means "this build cannot re-dispatch" and `r` says so.
   */
  startRun?: (request: RestartRequest) => unknown;
  /**
   * Stop one background task; defaults to `stopBackgroundTask` on this project,
   * so the board inherits its idempotence and its `starting` refusal instead of
   * re-implementing them.
   */
  stopBackground?: (id: string) => Promise<BackgroundStopOutcome>;
  /** Drop finished background entries; defaults to `prune` on this project. */
  pruneBackground?: () => number;
  /**
   * Replay a recorded background command; defaults to `startBackgroundTask` with
   * `preApproved` — pressing `r` on a row that shows the command *is* the
   * approval, so no second dialog is shown.
   */
  rerunBackground?: (task: RerunBackgroundRequest) => Promise<BackgroundStartOutcome>;
}

/** Extra input a key alone cannot carry: the steer text from the dialog. */
export interface ActionContext {
  message?: string;
}

export interface ActionRunner {
  /**
   * Returning a promise is the background case: stopping a task waits (bounded)
   * for its process to disappear, and reporting a stop that has not happened yet
   * would be the one lie this board cannot afford.
   */
  (action: Action, context?: ActionContext): ActionResult | Promise<ActionResult>;
}

function ok(message: string): ActionResult {
  return { ok: true, message };
}

function failed(message: string): ActionResult {
  return { ok: false, message };
}

/**
 * The one line a panel notification shows for an outcome that carries a
 * paragraph. A failure keeps all of it: the second line is usually the part that
 * says what was *not* done.
 */
function noticeOf(outcome: { text: string; isError: boolean }): string {
  if (outcome.isError) return outcome.text;
  return outcome.text.split("\n")[0] ?? "";
}

/**
 * Build the runner for one panel session.
 *
 * Both registry directories are resolved once: every action addresses the same
 * project, and re-resolving them per key would only add a way for them to
 * disagree.
 */
export function createActionRunner(deps: ActionDeps): ActionRunner {
  const dir = runsDir(deps.projectRoot);
  const writeControl = deps.writeControl ?? ((path, command) => appendControl(path, command));
  const killTree = deps.killTree ?? ((pid) => killChildTree(pid));
  const by = deps.contextKey ?? undefined;
  const bgDir = backgroundDir(deps.projectRoot);
  const stopBackground = deps.stopBackground ?? ((id: string) => stopBackgroundTask(bgDir, id));
  const pruneBackground = deps.pruneBackground ?? (() => pruneRegistry(bgDir, Date.now()));
  const rerunBackground =
    deps.rerunBackground ??
    ((task: RerunBackgroundRequest) =>
      startBackgroundTask(
        {
          command: task.command,
          ...(task.description ? { description: task.description } : {}),
          ...(task.cwd ? { cwd: task.cwd } : {}),
        },
        { root: deps.projectRoot, contextKey: deps.contextKey ?? null, preApproved: true },
      ));

  /**
   * Stop one run.
   *
   * The control line is queued *before* the kill so a live dispatcher reaches its
   * own `abort` path and records `stopped`; the kill is what makes it work when
   * that dispatcher is gone (a stale run), and the direct `finish` is what makes
   * the board tell the truth either way. A run with no recorded pid (the
   * dispatcher died before it could write one) can only be recorded, never
   * killed — and the message says so instead of claiming a kill.
   */
  function stopRun(runId: string): ActionResult {
    const entry = readRun(dir, runId);
    if (!entry) return failed(`run ${shortId(runId)} is not in the registry`);
    if (isTerminal(entry.status)) return failed(`run ${shortId(runId)} already ended (${entry.status})`);
    try {
      writeControl(ctlPath(dir, runId), { type: "abort", by });
    } catch {
      /* the kill below still stops it; the control line is the graceful path */
    }
    const pid = typeof entry.pid === "number" && entry.pid > 0 ? entry.pid : null;
    if (pid) killTree(pid);
    finish(dir, runId, "stopped", { stopReason: "stopped from the board" });
    return ok(
      pid
        ? `stopped ${shortId(runId)} (killed pid ${pid})`
        : `recorded ${shortId(runId)} as stopped; no pid was known, so nothing could be killed`,
    );
  }

  /**
   * Queue a steer. Nothing here touches the child: the dispatcher polls the
   * control file every second and forwards the line to its own stdin, which is
   * what lets a *second* session steer a run it does not own.
   */
  function steerRun(runId: string, message: string | undefined): ActionResult {
    const text = message?.trim() ?? "";
    if (!text) return failed("no steer message was given");
    const entry = readRun(dir, runId);
    if (!entry) return failed(`run ${shortId(runId)} is not in the registry`);
    if (isTerminal(entry.status)) {
      return failed(`run ${shortId(runId)} already ended (${entry.status}); nothing is listening`);
    }
    try {
      writeControl(ctlPath(dir, runId), { type: "steer", message: text, by });
    } catch (error) {
      return failed(`could not queue the steer for ${shortId(runId)}: ${messageOf(error)}`);
    }
    // A run whose heartbeat stopped has no dispatcher polling its control file, so
    // the line is written but nothing will forward it. Saying "queued" alone would
    // promise a delivery that cannot happen.
    if (displayStatus(entry) === "stale") {
      return ok(
        `queued the steer for ${shortId(runId)}, but nothing is polling that run (stale): ` +
          "the dispatching session is gone, so it will not be forwarded",
      );
    }
    return ok(`queued the steer for ${shortId(runId)}; the dispatching session forwards it within a second`);
  }

  /**
   * Re-dispatch one run's agent and prompt as a new run in a new group.
   *
   * The old entry is left untouched on purpose: "rerun" is a second attempt, not
   * an edit, and two attempts in one registry file would make the first one
   * unrecoverable. The new entry is recorded as `queued` before the dispatcher is
   * called, so the board sees the attempt even if the dispatch fails immediately.
   * Mode is `single`: one prompt is being dispatched, whatever the original call's
   * mode was.
   */
  function restartRun(runId: string): ActionResult {
    const entry = readRun(dir, runId);
    if (!entry) return failed(`run ${shortId(runId)} is not in the registry`);
    if (!deps.startRun) return failed(`rerunning ${shortId(runId)} is not wired in this build`);
    const group = newGroupId();
    const queued = queueGroup(
      dir,
      [{ agent: entry.agent, mode: "single", prompt: entry.prompt, task: entry.task, model: entry.model }],
      { group, contextKey: deps.contextKey ?? null },
    )[0];
    try {
      // Fire-and-forget: the tool call that dispatched the original run is gone,
      // and a board key must answer immediately rather than hold the panel until
      // a fresh sub-agent finishes minutes later.
      deps.startRun({
        projectRoot: deps.projectRoot,
        runId: queued.runId,
        group,
        agent: entry.agent,
        prompt: entry.prompt,
        model: entry.model,
        contextKey: deps.contextKey ?? null,
      });
    } catch (error) {
      finish(dir, queued.runId, "failed", { errorMessage: messageOf(error) });
      return failed(`could not rerun ${shortId(runId)}: ${messageOf(error)}`);
    }
    return ok(`rerunning ${shortId(entry.runId)} as ${shortId(queued.runId)} in group ${group}`);
  }

  /** Cancel every still-running member of one dispatch call. */
  function cancelGroup(group: string): ActionResult {
    const members = listRuns(dir).runs.filter((entry) => entry.group === group && entry.status === "running");
    if (members.length === 0) return failed(`group ${group} has no running run`);
    const results = members.map((entry) => stopRun(entry.runId));
    return ok(`cancelled group ${group}: ${results.map((result) => result.message).join("; ")}`);
  }

  /**
   * Stop one background task.
   *
   * Everything that decides anything — the idempotent verdict, the refusal of a
   * task whose pid is not confirmed yet, "never claim a stop that did not
   * happen" — belongs to `stopBackgroundTask`. This only turns its outcome into a
   * notification, which is why `x` here and `myflow_bg_stop` cannot disagree.
   */
  async function stopBg(id: string): Promise<ActionResult> {
    try {
      const outcome = await stopBackground(id);
      return { ok: !outcome.isError, message: noticeOf(outcome) };
    } catch (error) {
      return failed(`could not stop background task ${id}: ${messageOf(error)}`);
    }
  }

  /** Drop finished background entries past the retention window; running ones are never touched. */
  function pruneBg(): ActionResult {
    try {
      const removed = pruneBackground();
      return ok(
        removed === 0
          ? "no finished background tasks to prune"
          : `pruned ${removed} finished background task${removed === 1 ? "" : "s"}`,
      );
    } catch (error) {
      return failed(`could not prune background tasks: ${messageOf(error)}`);
    }
  }

  /**
   * Replay a recorded background command as a new task.
   *
   * The command, its description and its directory come from the registry — the
   * same fields the user is looking at in the row they pressed `r` on — and
   * validation still runs inside `startBackgroundTask`, so a replay can be
   * refused (a directory that has since vanished) instead of failing in the
   * wrapper.
   */
  async function rerunBg(id: string): Promise<ActionResult> {
    const entry = readEntry(bgDir, id);
    if (!entry) return failed(`background task ${id} is not in the registry`);
    const command = typeof entry.command === "string" ? entry.command.trim() : "";
    if (!command) return failed(`background task ${id} recorded no command to replay`);
    try {
      const outcome = await rerunBackground({
        command,
        ...(typeof entry.description === "string" && entry.description
          ? { description: entry.description }
          : {}),
        ...(typeof entry.cwd === "string" && entry.cwd ? { cwd: entry.cwd } : {}),
      });
      return { ok: !outcome.isError, message: noticeOf(outcome) };
    } catch (error) {
      return failed(`could not rerun background task ${id}: ${messageOf(error)}`);
    }
  }

  /** Forget one finished run (`d`). The store refuses a live one on its own. */
  function forgetRun(runId: string): ActionResult {
    const refusal = deleteRun(dir, runId);
    if (refusal) return failed(refusal);
    return ok(`removed ${shortId(runId)} from the board`);
  }

  /** Forget every finished run (`D`) — the manual prune. */
  function forgetFinished(): ActionResult {
    try {
      const removed = deleteFinishedRuns(dir);
      return ok(removed === 0 ? "nothing finished to remove" : `removed ${removed} finished run(s)`);
    } catch (error) {
      return failed(`could not clear finished runs: ${messageOf(error)}`);
    }
  }

  return (action, context = {}) => {
    switch (action.kind) {
      case "stop-run":
        return stopRun(action.runId);
      case "delete-run":
        return forgetRun(action.runId);
      case "delete-finished":
        return forgetFinished();
      case "cancel-group":
        return cancelGroup(action.group);
      case "steer":
        return steerRun(action.runId, context.message);
      case "restart-run":
        return restartRun(action.runId);
      case "stop-bg":
        return stopBg(action.id);
      case "prune-bg":
        return pruneBg();
      case "rerun-bg":
        return rerunBg(action.id);
      default:
        // Navigation and `close`/`open-viewer` belong to the panel: they change
        // what is shown, not what exists on disk.
        return ok("");
    }
  };
}
