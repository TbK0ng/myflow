import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createActionRunner,
  type ActionRunner,
  type ActionResult,
  type RerunBackgroundRequest,
  type RestartRequest,
} from "../.pi/extensions/myflow/board/actions.ts";
import type { Action } from "../.pi/extensions/myflow/board/keys.ts";
import { registerMyflowSubagentsCommand } from "../.pi/extensions/myflow/board/index.ts";
import { ctlPath } from "../.pi/extensions/myflow/ctl.ts";
import {
  backgroundDir,
  cursorPath,
  entryPath,
  listEntries,
  logPath,
  readEntry,
  writeCursor,
  writeEntry,
  type BackgroundEntry,
} from "../.pi/extensions/myflow/background/registry.ts";
import { readLogTail } from "../.pi/extensions/myflow/background/output.ts";
import { startBackgroundTask } from "../.pi/extensions/myflow/background/start.ts";
import {
  finish,
  listRuns,
  markRunning,
  queueGroup,
  readRun,
  runPath,
  runsDir,
} from "../.pi/extensions/myflow/runs.ts";
import {
  EMPTY_SELECTION,
  buildState,
  clampSelection,
} from "../.pi/extensions/myflow/board/state.ts";
import {
  locateAnchor,
  mountPanel,
  selectionAnchor,
  type PanelOutcome,
} from "../.pi/extensions/myflow/board/index.ts";
import { plainTheme } from "../.pi/extensions/myflow/board/render.ts";

// S6/S7 — what a key press actually does. The panel itself is S5's
// render/reducer tests; here every side effect is asserted without a terminal.

const ROOT = join(import.meta.dirname, "..");

function project(): string {
  return mkdtempSync(join(tmpdir(), "myflow-board-actions-"));
}

/** A registry entry with the fields the background tools read, plus overrides. */
function backgroundEntry(
  root: string,
  id: string,
  overrides: Partial<BackgroundEntry> = {},
): BackgroundEntry {
  const now = new Date().toISOString();
  return {
    id,
    command: "echo hi",
    cwd: root,
    pid: 0,
    log: join(".myflow", ".runtime", "background", `${id}.log`),
    exit_file: join(".myflow", ".runtime", "background", `${id}.exit`),
    status: "running",
    exit_code: null,
    started_at: now,
    ended_at: null,
    started_by_context_key: "pi_session",
    confirmed_by: "ui-confirm",
    ...overrides,
  };
}

function roots(): { dir: string; root: string; cleanup: () => void } {
  const root = project();
  return { root, dir: runsDir(root), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * One key press, awaited.
 *
 * A background stop only answers once the process tree is gone, so the runner's
 * answer is a promise for those keys; awaiting everywhere keeps the assertions
 * about a key's effect identical for both kinds.
 */
async function press(
  run: ActionRunner,
  action: Action,
  context?: { message?: string },
): Promise<ActionResult> {
  return await run(action, context);
}

function queuedRun(dir: string, prompt = "do the thing", group?: string): { runId: string; group: string } {
  const entry = queueGroup(dir, [{ agent: "myflow-implement", mode: "single", prompt, model: "p/m" }], {
    group,
  })[0];
  return { runId: entry.runId, group: entry.group };
}

function runningRun(
  dir: string,
  pid: number,
  prompt = "do the thing",
  group?: string,
): { runId: string; group: string } {
  const entry = queuedRun(dir, prompt, group);
  markRunning(dir, entry.runId, { pid });
  return entry;
}

test("stop-run kills the recorded pid and records stopped", async () => {
  const { root, dir, cleanup } = roots();
  try {
    const { runId } = runningRun(dir, 4321);
    const killed: Array<number | undefined> = [];
    const written: Array<{ path: string; type: string }> = [];
    const run = createActionRunner({
      projectRoot: root,
      contextKey: "pi_session",
      killTree: (pid) => killed.push(pid),
      writeControl: (path, command) => written.push({ path, type: command.type }),
    });

    const result = await press(run, { kind: "stop-run", runId });

    assert.equal(result.ok, true);
    assert.deepEqual(killed, [4321]);
    // The abort line lets a live dispatcher record the stop through its own path.
    assert.deepEqual(written, [{ path: ctlPath(dir, runId), type: "abort" }]);
    const entry = readRun(dir, runId);
    assert.equal(entry?.status, "stopped");
    assert.ok(entry?.endedAt);
    assert.equal(entry?.stopReason, "stopped from the board");
  } finally {
    cleanup();
  }
});

test("stop-run without a pid records the stop and says nothing was killed", async () => {
  const { root, dir, cleanup } = roots();
  try {
    // A queued (or stale, pid-less) run is exactly the case where a kill is
    // impossible; it must still end, and the message must not claim a kill.
    const { runId } = queuedRun(dir);
    const killed: Array<number | undefined> = [];
    const run = createActionRunner({ projectRoot: root, killTree: (pid) => killed.push(pid) });

    const result = await press(run, { kind: "stop-run", runId });

    assert.equal(result.ok, true);
    assert.equal(result.message.includes("no pid"), true);
    assert.deepEqual(killed, []);
    assert.equal(readRun(dir, runId)?.status, "stopped");
  } finally {
    cleanup();
  }
});

test("stop-run on a finished run changes nothing", async () => {
  const { root, dir, cleanup } = roots();
  try {
    const { runId } = queuedRun(dir);
    finish(dir, runId, "done");
    const killed: Array<number | undefined> = [];
    const run = createActionRunner({ projectRoot: root, killTree: (pid) => killed.push(pid) });

    const result = await press(run, { kind: "stop-run", runId });

    assert.equal(result.ok, false);
    assert.deepEqual(killed, []);
    assert.equal(readRun(dir, runId)?.status, "done");
  } finally {
    cleanup();
  }
});

test("steer appends one control line with the message and the asking session", async () => {
  const { root, dir, cleanup } = roots();
  try {
    const { runId } = runningRun(dir, 1234);
    const run = createActionRunner({ projectRoot: root, contextKey: "pi_session" });

    const result = await press(run, { kind: "steer", runId }, { message: "  focus on the tests  " });

    assert.equal(result.ok, true);
    const path = ctlPath(dir, runId);
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const command = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(command.type, "steer");
    assert.equal(command.message, "focus on the tests");
    assert.equal(command.by, "pi_session");
    assert.equal(typeof command.id, "string");
  } finally {
    cleanup();
  }
});

test("steer to a run whose dispatcher is gone says it cannot be forwarded", async () => {
  const { root, dir, cleanup } = roots();
  try {
    const { runId } = runningRun(dir, 1234);
    // Age the heartbeat past the stale threshold: this is what a run whose
    // dispatching session died looks like on disk.
    const entry = readRun(dir, runId)!;
    writeFileSync(
      runPath(dir, runId),
      JSON.stringify({ ...entry, heartbeatAt: new Date(Date.now() - 60_000).toISOString() }),
    );
    const run = createActionRunner({ projectRoot: root });

    const result = await press(run, { kind: "steer", runId }, { message: "keep going" });

    // The line is still written (another session may start polling it), but the
    // report must not promise a forwarding nobody will do.
    assert.equal(result.ok, true);
    assert.match(result.message, /stale/);
    assert.match(result.message, /will not be forwarded/);
    assert.equal(readFileSync(ctlPath(dir, runId), "utf-8").trim().split("\n").length, 1);
  } finally {
    cleanup();
  }
});

test("steer needs a message and refuses a run that already ended", async () => {
  const { root, dir, cleanup } = roots();
  try {
    const { runId } = runningRun(dir, 1234);
    const run = createActionRunner({ projectRoot: root });
    const path = ctlPath(dir, runId);

    assert.equal((await press(run, { kind: "steer", runId }, { message: "   " })).ok, false);
    assert.equal(existsSync(path), false);

    finish(dir, runId, "failed", { errorMessage: "boom" });
    const late = await press(run, { kind: "steer", runId }, { message: "keep going" });
    assert.equal(late.ok, false);
    assert.match(late.message, /already ended/);
    assert.equal(existsSync(path), false);
  } finally {
    cleanup();
  }
});

test("cancel-group stops every running member of one group and leaves the rest", async () => {
  const { root, dir, cleanup } = roots();
  try {
    const group = "g-1-aaaa";
    const first = runningRun(dir, 11, "one", group);
    const second = runningRun(dir, 12, "two", group);
    const finished = queuedRun(dir, "three", group);
    finish(dir, finished.runId, "done");
    const other = runningRun(dir, 13, "other", "g-2-bbbb");
    const killed: Array<number | undefined> = [];
    const run = createActionRunner({ projectRoot: root, killTree: (pid) => killed.push(pid) });

    const result = await press(run, { kind: "cancel-group", group });

    assert.equal(result.ok, true);
    assert.deepEqual(killed.sort(), [11, 12]);
    assert.equal(readRun(dir, first.runId)?.status, "stopped");
    assert.equal(readRun(dir, second.runId)?.status, "stopped");
    assert.equal(readRun(dir, finished.runId)?.status, "done");
    assert.equal(readRun(dir, other.runId)?.status, "running");
  } finally {
    cleanup();
  }
});

test("cancel-group on a group with nothing running says so", async () => {
  const { root, dir, cleanup } = roots();
  try {
    const { group } = queuedRun(dir);
    const run = createActionRunner({ projectRoot: root, killTree: () => assert.fail("killed nothing to kill") });

    const result = await press(run, { kind: "cancel-group", group });

    assert.equal(result.ok, false);
    assert.match(result.message, /no running run/);
  } finally {
    cleanup();
  }
});

test("restart-run queues a new run in a new group and does not wait for it", async () => {
  const { root, dir, cleanup } = roots();
  try {
    const original = runningRun(dir, 99, "the original prompt");
    finish(dir, original.runId, "done");
    const requests: RestartRequest[] = [];
    const run = createActionRunner({
      projectRoot: root,
      contextKey: "pi_session",
      startRun: (request) => {
        requests.push(request);
        // A dispatch that never settles must not hold the key press: awaiting this
        // promise would hang the runner (and this test) forever.
        return new Promise<void>(() => {});
      },
    });

    const result = await press(run, { kind: "restart-run", runId: original.runId });

    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.agent, "myflow-implement");
    assert.equal(request.prompt, "the original prompt");
    assert.equal(request.model, "p/m");
    assert.equal(request.contextKey, "pi_session");
    assert.notEqual(request.runId, original.runId);
    assert.notEqual(request.group, original.group);
    // The new attempt is visible in the registry before it starts.
    const queued = readRun(dir, request.runId);
    assert.equal(queued?.status, "queued");
    assert.equal(queued?.group, request.group);
    // The first attempt is untouched: a rerun is a second attempt, not an edit.
    assert.equal(readRun(dir, original.runId)?.status, "done");
  } finally {
    cleanup();
  }
});

test("restart-run records a failed dispatch instead of throwing", async () => {
  const { root, dir, cleanup } = roots();
  try {
    const original = queuedRun(dir);
    const run = createActionRunner({
      projectRoot: root,
      startRun: () => {
        throw new Error("no agent definition");
      },
    });

    const result = await press(run, { kind: "restart-run", runId: original.runId });

    assert.equal(result.ok, false);
    assert.match(result.message, /no agent definition/);
    // The new attempt is the one that failed; the original is never rewritten.
    const attempts = listRuns(dir).runs.filter((entry) => entry.runId !== original.runId);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "failed");
    assert.equal(attempts[0].errorMessage, "no agent definition");
    assert.equal(readRun(dir, original.runId)?.status, "queued");
  } finally {
    cleanup();
  }
});

test("restart-run without a dispatcher refuses instead of queueing a run nobody starts", async () => {
  const { root, dir, cleanup } = roots();
  try {
    const original = queuedRun(dir);
    const run = createActionRunner({ projectRoot: root });

    const result = await press(run, { kind: "restart-run", runId: original.runId });

    assert.equal(result.ok, false);
    assert.match(result.message, /not wired/);
  } finally {
    cleanup();
  }
});

test("stop-bg runs the task's own stop rules and reports what happened", async () => {
  const { root, cleanup } = roots();
  try {
    const asked: string[] = [];
    const run = createActionRunner({
      projectRoot: root,
      stopBackground: async (id) => {
        asked.push(id);
        return {
          details: {},
          text:
            "Stopped background task bg-1-0001 (pid 4242, status stopped).\n" +
            "The whole process tree was terminated.",
          isError: false,
        };
      },
    });

    const result = await press(run, { kind: "stop-bg", id: "bg-1-0001" });

    // The id reaches the stop logic unchanged; a success notifies one line.
    assert.deepEqual(asked, ["bg-1-0001"]);
    assert.equal(result.ok, true);
    assert.match(result.message, /Stopped background task bg-1-0001/);
    assert.equal(result.message.includes("\n"), false);
  } finally {
    cleanup();
  }
});

test("stop-bg reports a stop that did not happen as a failure, keeping the reason", async () => {
  const { root, cleanup } = roots();
  try {
    const run = createActionRunner({
      projectRoot: root,
      stopBackground: async () => ({
        details: {},
        text:
          "FAILED to stop task bg-1-0001 (pid 4242): the process is still alive.\n" +
          "The task was NOT recorded as stopped; read myflow_bg_output or retry myflow_bg_stop.",
        isError: true,
      }),
    });

    const result = await press(run, { kind: "stop-bg", id: "bg-1-0001" });

    assert.equal(result.ok, false);
    // The second line is usually the part that says what was *not* done, so a
    // failure keeps all of it.
    assert.match(result.message, /still alive/);
    assert.match(result.message, /NOT recorded as stopped/);
  } finally {
    cleanup();
  }
});

test("stop-bg on a task that already ended goes through the real registry", async () => {
  const { root, cleanup } = roots();
  try {
    const dir = backgroundDir(root);
    writeEntry(dir, backgroundEntry(root, "bg-old-0001", { status: "exited", exit_code: 0 }));
    const run = createActionRunner({ projectRoot: root });

    const result = await press(run, { kind: "stop-bg", id: "bg-old-0001" });

    assert.equal(result.ok, true);
    assert.match(result.message, /already finished/);
  } finally {
    cleanup();
  }
});

test("prune-bg removes only finished tasks and reports how many", async () => {
  const { root, cleanup } = roots();
  try {
    const dir = backgroundDir(root);
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeEntry(
      dir,
      backgroundEntry(root, "bg-old-0001", { status: "exited", exit_code: 0, ended_at: longAgo }),
    );
    // A live pid is this very process, so `resolveStatus` reads the row as
    // running without spawning anything — and prune must leave it alone.
    writeEntry(dir, backgroundEntry(root, "bg-live-0002", { status: "running", pid: process.pid }));
    const run = createActionRunner({ projectRoot: root });

    const result = await press(run, { kind: "prune-bg" });

    assert.equal(result.ok, true);
    assert.match(result.message, /pruned 1 finished background task$/);
    assert.equal(existsSync(entryPath(dir, "bg-old-0001")), false);
    assert.equal(readEntry(dir, "bg-live-0002")?.status, "running");
  } finally {
    cleanup();
  }
});

test("prune-bg with nothing to remove says so instead of claiming a prune", async () => {
  const { root, cleanup } = roots();
  try {
    const run = createActionRunner({ projectRoot: root });
    const result = await press(run, { kind: "prune-bg" });
    assert.equal(result.ok, true);
    assert.match(result.message, /no finished background tasks to prune/);
  } finally {
    cleanup();
  }
});

test("rerun-bg replays the recorded command, description and directory", async () => {
  const { root, cleanup } = roots();
  try {
    const dir = backgroundDir(root);
    writeEntry(
      dir,
      backgroundEntry(root, "bg-1-0001", {
        command: "npm run build",
        description: "the build",
        cwd: root,
        status: "exited",
        exit_code: 1,
      }),
    );
    const replayed: RerunBackgroundRequest[] = [];
    const run = createActionRunner({
      projectRoot: root,
      rerunBackground: async (task) => {
        replayed.push(task);
        return {
          details: { started: true, id: "bg-2-0002" },
          text: "Started background task bg-2-0002 (pid 4242).",
          isError: false,
        };
      },
    });

    const result = await press(run, { kind: "rerun-bg", id: "bg-1-0001" });

    assert.equal(result.ok, true);
    assert.deepEqual(replayed, [{ command: "npm run build", description: "the build", cwd: root }]);
    assert.match(result.message, /Started background task bg-2-0002/);
    // The old entry is history: a rerun adds a task, it never rewrites one.
    assert.equal(readEntry(dir, "bg-1-0001")?.status, "exited");
  } finally {
    cleanup();
  }
});

test("rerun-bg refuses an id that is not in the registry", async () => {
  const { root, cleanup } = roots();
  try {
    const run = createActionRunner({
      projectRoot: root,
      rerunBackground: () => assert.fail("there is nothing to replay"),
    });

    const result = await press(run, { kind: "rerun-bg", id: "bg-missing-0001" });

    assert.equal(result.ok, false);
    assert.match(result.message, /not in the registry/);
  } finally {
    cleanup();
  }
});

test("rerun-bg starts a real task with no second confirmation", async () => {
  const { root, cleanup } = roots();
  try {
    // The board's default is `startBackgroundTask` with `preApproved`: pressing
    // `r` on a row that shows the command *is* the approval, so the entry is
    // created without any dialog and recorded as ui-confirm.
    const spawns: unknown[][] = [];
    const outcome = await startBackgroundTask(
      { command: "echo rerun", description: "the build" },
      {
        root,
        preApproved: true,
        runnerPath: join(ROOT, ".myflow", "scripts", "bg_runner.mjs"),
        spawnProcess: ((...args: unknown[]) => {
          spawns.push(args[1] as unknown[]);
          return { pid: 4242, unref() {}, on() {} };
        }) as never,
      },
    );

    assert.equal(outcome.isError, false);
    assert.equal(outcome.details.started, true);
    assert.equal(spawns.length, 1);
    const entries = listEntries(backgroundDir(root)).entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].command, "echo rerun");
    assert.equal(entries[0].description, "the build");
    assert.equal(entries[0].confirmed_by, "ui-confirm");
  } finally {
    cleanup();
  }
});

test("readLogTail shows a task's output and never moves a read cursor", async () => {
  const { root, cleanup } = roots();
  try {
    const dir = backgroundDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(logPath(dir, "bg-1-0001"), "first\nsecond\nthird\n");
    const cursor = cursorPath(root, "pi_session", "bg-1-0001");
    writeCursor(cursor, 6);
    const before = readFileSync(cursor, "utf-8");

    assert.equal(readLogTail(dir, "bg-1-0001", 32 * 1024), "first\nsecond\nthird\n");
    // The viewer's window leaves this session's delta cursor exactly as it was.
    assert.equal(readFileSync(cursor, "utf-8"), before);
    // A window that opens inside the last complete line keeps it (the byte
    // before the window is an LF)...
    assert.equal(readLogTail(dir, "bg-1-0001", 13), "second\nthird\n");
    // ...while one that opens mid-line drops the fragment: unlike a delta read,
    // there is no cursor to complete it later.
    assert.equal(readLogTail(dir, "bg-1-0001", 12), "third\n");
    // A missing log is empty, not an error.
    assert.equal(readLogTail(dir, "bg-missing-0001"), "");
  } finally {
    cleanup();
  }
});

test("the panel reports a background stop once its bounded wait ends", async () => {
  const { root, cleanup } = roots();
  try {
    writeEntry(
      backgroundDir(root),
      backgroundEntry(root, "bg-1-0001", { status: "stopped", ended_at: new Date().toISOString() }),
    );
    const notices: string[] = [];
    const panel = mountPanel({
      projectRoot: root,
      runner: createActionRunner({ projectRoot: root }),
      view: "background",
      selection: EMPTY_SELECTION,
      viewer: null,
      theme: plainTheme(),
      keybindings: { matches: () => false },
      truncate: (text: string) => text,
      requestRender: () => undefined,
      notify: (message) => notices.push(message),
      finish: () => undefined,
    });

    panel.handleInput("x");
    // The stop answers on a later turn (it waits for the process to disappear),
    // so the panel must still deliver its notification — the reason the panel
    // settles actions through a promise instead of assuming a sync result.
    assert.deepEqual(notices, []);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(notices.length, 1);
    assert.match(notices[0], /already finished/);
    panel.dispose();
  } finally {
    cleanup();
  }
});

test("navigation actions are the panel's business, not the runner's", async () => {
  const { root, cleanup } = roots();
  try {
    const run = createActionRunner({ projectRoot: root });
    for (const action of [
      { kind: "none" } as const,
      { kind: "close" } as const,
      { kind: "open-view", view: "tree" } as const,
      { kind: "close-viewer" } as const,
    ]) {
      const result = await press(run, action);
      assert.equal(result.ok, true);
      assert.equal(result.message, "");
    }
  } finally {
    cleanup();
  }
});

test("/mysubagents outside the TUI prints a report and never throws", async () => {
  const { root, dir, cleanup } = roots();
  try {
    runningRun(dir, 4321);
    const sent: Array<{ customType: string; content: string }> = [];
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    registerMyflowSubagentsCommand(
      {
        registerCommand: (name: string, options: { handler: typeof handler }) => {
          assert.equal(name, "mysubagents");
          handler = options.handler;
        },
        sendMessage: (message: { customType: string; content: string }) => sent.push(message),
      } as unknown as ExtensionAPI,
      { deriveContextKey: () => "pi_session" },
    );
    assert.ok(handler);
    const ctx = {
      cwd: root,
      mode: "json",
      hasUI: false,
      ui: { notify: () => undefined },
    } as unknown as ExtensionContext;

    await handler("", ctx);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].customType, "myflow-subagents");
    // No argument means the board: a menu is a terminal affordance.
    assert.match(sent[0].content, /mysubagents · board/);

    await handler("tree", ctx);
    assert.match(sent[1].content, /mysubagents · tree/);
  } finally {
    cleanup();
  }
});

test("the panel routes a key to an action and hands a steer back to the caller", async () => {
  const { root, dir, cleanup } = roots();
  const captured: { outcome: PanelOutcome } = { outcome: undefined };
  const mount = (finish: (outcome: PanelOutcome) => void) =>
    mountPanel({
      projectRoot: root,
      runner: createActionRunner({ projectRoot: root, killTree: () => undefined }),
      view: "tree",
      selection: EMPTY_SELECTION,
      viewer: null,
      theme: plainTheme(),
      // No matcher: the literal fallback bindings are what a test can press.
      keybindings: { matches: () => false },
      truncate: (text: string) => text,
      requestRender: () => undefined,
      notify: () => undefined,
      finish,
    });
  try {
    const { runId } = runningRun(dir, 1234);
    const steering = mount((result) => {
      captured.outcome = result;
    });

    assert.ok(steering.render(100).join(" ").includes(runId.slice(0, 8)));
    steering.handleInput("s");
    const outcome = captured.outcome;
    assert.equal(outcome?.kind, "steer");
    assert.equal(outcome?.kind === "steer" ? outcome.runId : null, runId);
    assert.equal(outcome?.kind === "steer" ? outcome.view : null, "tree");

    // `x` is handled in place: it stops the run and closes nothing.
    const stopper = mount((result) => {
      captured.outcome = result;
    });
    stopper.handleInput("x");
    assert.equal(readRun(dir, runId)?.status, "stopped");
    stopper.dispose();
  } finally {
    cleanup();
  }
});

test("delete-run forgets a finished entry and refuses a live one", async () => {
  const { root, dir, cleanup } = roots();
  try {
    const live = queuedRun(dir, "still going");
    const done = queuedRun(dir, "all done");
    assert.ok(finish(dir, done.runId, "done", {}, Date.now()));

    const run = createActionRunner({ projectRoot: root });

    const refused = await press(run, { kind: "delete-run", runId: live.runId });
    assert.equal(refused.ok, false);
    assert.ok(existsSync(runPath(dir, live.runId)), "a live entry stays on disk");

    const removed = await press(run, { kind: "delete-run", runId: done.runId });
    assert.equal(removed.ok, true);
    assert.equal(existsSync(runPath(dir, done.runId)), false);

    const again = await press(run, { kind: "delete-run", runId: done.runId });
    assert.equal(again.ok, false);
  } finally {
    cleanup();
  }
});

test("delete-finished clears the tail and reports the count", async () => {
  const { root, dir, cleanup } = roots();
  try {
    const live = queuedRun(dir, "still going");
    const first = queuedRun(dir, "one");
    const second = queuedRun(dir, "two");
    assert.ok(finish(dir, first.runId, "done", {}, Date.now()));
    assert.ok(finish(dir, second.runId, "failed", {}, Date.now()));

    const run = createActionRunner({ projectRoot: root });

    const cleared = await press(run, { kind: "delete-finished" });
    assert.equal(cleared.ok, true);
    assert.match(cleared.message, /removed 2 finished run\(s\)/);
    assert.deepEqual(
      listRuns(dir).runs.map((entry) => entry.runId),
      [live.runId],
    );

    const empty = await press(run, { kind: "delete-finished" });
    assert.equal(empty.ok, true);
    assert.match(empty.message, /nothing finished to remove/);
  } finally {
    cleanup();
  }
});

test("the panel's cursor actually moves (down arrow is not undone by the refresh)", async () => {
  const { root, dir, cleanup } = roots();
  try {
    const first = queuedRun(dir, "first");
    const second = queuedRun(dir, "second");
    assert.ok(finish(dir, first.runId, "done", {}, Date.now() - 1_000));
    assert.ok(finish(dir, second.runId, "done", {}, Date.now()));

    const panel = mountPanel({
      projectRoot: root,
      runner: createActionRunner({ projectRoot: root }),
      view: "board",
      selection: EMPTY_SELECTION,
      viewer: null,
      theme: plainTheme(),
      keybindings: { matches: () => false },
      truncate: (text: string) => text,
      requestRender: () => undefined,
      notify: () => undefined,
      finish: () => undefined,
    });

    const selectedRow = () => {
      const lines = panel.render(120);
      const index = lines.findIndex((line) => line.includes(">"));
      assert.ok(index >= 0, "a row is marked as selected");
      return lines[index]!;
    };

    // Display order is newest first, so the second dispatch is row 0.
    assert.match(selectedRow(), new RegExp(second.runId.slice(0, 8)));
    panel.handleInput("\u001b[B"); // CSI down
    assert.match(selectedRow(), new RegExp(first.runId.slice(0, 8)));
    panel.handleInput("\u001bOA"); // SS3 up (application cursor mode)
    assert.match(selectedRow(), new RegExp(second.runId.slice(0, 8)));
    panel.dispose();
  } finally {
    cleanup();
  }
});
