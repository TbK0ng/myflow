import { join, resolve, relative } from "node:path";
import { spawn } from "node:child_process";
import { findProjectRoot } from "../find-project-root.ts";
import type { ConfirmedBy, BackgroundEntry } from "./registry.ts";
import type { BgToolRegistration } from "./tools.ts";
import { BACKGROUND_DIR, newTaskId, backgroundDir, logPath, exitPath, pidPath, messageOf, writeEntry, readEntry, readPid, exitPathFor } from "./registry.ts";
import { textResult, bgSubAgentRefusal, bgNoUiInstruction, resolveBgCwd } from "./tools.ts";

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
  /**
   * Directory the command runs in, relative to the project root (or absolute,
   * still inside it). Absent means the project root. Validated before the
   * confirmation dialog: an out-of-root or non-existent directory is refused
   * with no dialog, no registry entry, and no spawn (R5/ADR-9).
   */
  cwd?: string;
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
    cwd: {
      type: "string",
      description:
        "Optional working directory for the command. A relative path is resolved against the " +
        "project root; an absolute path is accepted only if it is still inside it. It must be an " +
        "existing directory. Anything outside the project root (`..` traversal, an absolute path " +
        "elsewhere, a case-only trick) is refused before the confirmation dialog: nothing is " +
        "started and no registry entry is written. Defaults to the project root. The dialog always " +
        "shows this directory, because it is what actually changes the meaning of a relative command.",
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
 * Everything the *caller* owns about a start, kept out of `params` so the board
 * can reuse the same start sequence with a different approval source: the tool
 * injects `ctx.ui.confirm`, the board injects `preApproved` (pressing `r` on a
 * row that shows the command *is* the approval). Validation, the
 * entry-before-spawn order and the failure compensation therefore run
 * identically on both paths.
 */
export interface BackgroundStartDeps {
  /** The project root; the registry, the log paths and the wrapper path hang off it. */
  root: string;
  /** The asking session's context key, recorded on the entry. */
  contextKey?: string | null;
  /**
   * Show this exact command and directory to a human and ask. Present only when
   * the session has an interactive UI; absent takes the no-UI path below.
   */
  confirm?: (command: string, cwd: string) => Promise<boolean>;
  /**
   * A human already approved this exact command in a dialog this function did not
   * open. Recorded as `ui-confirm`, and no second dialog is shown.
   */
  preApproved?: boolean;
  /** The session mode, quoted by the no-UI refusal so it says where it came from. */
  mode?: string;
  /** Override `node:child_process.spawn` (tests). */
  spawnProcess?: typeof spawn;
  /** Override the wrapper path recorded on the entry (tests). */
  runnerPath?: string;
  onStarted?: (id: string) => void;
}

/**
 * What one start attempt reports: the tool's `details` object plus the text it
 * shows. One shape for every outcome keeps the tool a one-line wrapper and lets
 * a non-tool caller (the board) read `details.started` / `details.id`.
 */
export interface BackgroundStartOutcome {
  details: Record<string, unknown>;
  text: string;
  isError: boolean;
}

function startError(message: string, details: Record<string, unknown> = {}): BackgroundStartOutcome {
  return { details: { started: false, ...details, error: message }, text: message, isError: true };
}

/**
 * Build the `myflow_bg_start` tool. Exported so tests can drive `execute` with
 * a stub context instead of a live Pi session; the registration function is the
 * production entry point (wired in F7).
 *
 * The tool is the thin Pi-shaped wrapper: the sub-agent guard, the project root
 * and the *dialog*. Everything that decides anything lives in
 * `startBackgroundTask`, so the board's `r` key takes the identical path.
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
      "Optional `cwd` sets the directory the command runs in: relative paths resolve against the project root, an absolute path is accepted only inside it, and it must already exist; anything outside the project root is refused before the user is asked, leaving no trace. The confirmation dialog always shows that directory.",
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

      const root = findProjectRoot(ctx?.cwd ?? process.cwd()) ?? ctx?.cwd ?? process.cwd();
      // The dialog belongs to the tool, so the core takes it as a function: the
      // board passes `preApproved` instead and never opens a second one.
      const confirm = ctx?.ui?.confirm;
      const ask =
        ctx?.hasUI === true && typeof confirm === "function"
          ? (command: string, cwd: string) =>
              confirm.call(ctx.ui, "Run this command in the background?", `Directory: ${cwd}\n\n${command}`)
          : undefined;
      const outcome = await startBackgroundTask(params, {
        root,
        mode: ctx?.mode ?? "unknown",
        contextKey: registration.deriveContextKey?.(ctx) ?? null,
        ...(ask ? { confirm: ask } : {}),
        ...(registration.spawnProcess ? { spawnProcess: registration.spawnProcess } : {}),
        ...(registration.runnerPath ? { runnerPath: registration.runnerPath } : {}),
        ...(registration.onStarted ? { onStarted: registration.onStarted } : {}),
      });
      return textResult(outcome.details, outcome.text, outcome.isError);
    },
  };
}

/**
 * Start one background task. The start sequence is fixed (`design.md` §2 /
 * §4.1, R1):
 *
 *   0. validate the command and the `cwd` (a refusal here must not prompt),
 *   1. confirm the command and its directory with the user (or refuse for lack
 *      of a UI),
 *   2. write the registry entry as `starting` with `pid: 0`,
 *   3. spawn the detached wrapper and `unref()` it,
 *   4. write the pid back and mark the entry `running`,
 *   5. return.
 *
 * Steps 2 and 3 are in that order on purpose (ADR-8): the entry must exist
 * before a process can exist. Nothing between those steps awaits a
 * child-process event: the caller returns as soon as the entry is on disk. The
 * wrapper — and not this function — waits for the command and records its exit
 * code.
 */
export async function startBackgroundTask(
  params: BgStartParams,
  deps: BackgroundStartDeps,
): Promise<BackgroundStartOutcome> {
  const root = deps.root;

  // Validate before touching the UI: an empty command must not pop a dialog.
  const command = typeof params?.command === "string" ? params.command.trim() : "";
  if (!command) {
    return startError("`command` must be a non-empty string.", { via: "error" });
  }
  const description =
    typeof params?.description === "string" ? params.description.trim() : "";

  // `cwd` is validated *here*, before the dialog: showing a confirmation for
  // a directory we are going to refuse would ask the user to approve
  // something that never happens, and a rejection must leave no trace (no
  // dialog, no registry entry, no spawn).
  const targetCwd = resolveBgCwd(root, params?.cwd);
  if (!targetCwd.ok) {
    return startError(targetCwd.error, { via: "error" });
  }
  const cwd = targetCwd.cwd;

  const dir = backgroundDir(root);
  const contextKey = deps.contextKey ?? null;
  const unattended = params?.unattended === true;

  // Step 1: the confirmation gate (R7). With a UI the user sees the exact
  // command; without one the only way through is an explicit opt-in, which
  // is recorded rather than treated as consent (R8).
  let confirmedBy: ConfirmedBy;
  if (deps.preApproved === true) {
    confirmedBy = "ui-confirm";
  } else if (typeof deps.confirm === "function") {
    // The dialog names the directory *always*, even when it is the project
    // root: a shell makes a relative path in the command mean something
    // different in every directory, so the user must be able to read where
    // it will run instead of inferring it (R5, `implement.md` S-2).
    const agreed = await deps.confirm(command, cwd);
    if (agreed !== true) {
      return {
        details: { started: false, via: "cancelled" },
        text: "The user did not approve running this command in the background. Nothing was started.",
        isError: false,
      };
    }
    confirmedBy = "ui-confirm";
  } else {
    if (!unattended) {
      const instruction = bgNoUiInstruction(deps.mode ?? "unknown");
      return { details: { started: false, via: "no-ui", instruction }, text: instruction, isError: false };
    }
    confirmedBy = "no-ui-explicit";
  }

  const id = newTaskId();
  const log = logPath(dir, id);
  const exit = exitPath(dir, id);
  const pidFile = pidPath(dir, id);
  const runner = deps.runnerPath ?? join(root, BG_RUNNER_REL);
  const spawnProcess = deps.spawnProcess ?? spawn;

  // Step 2: record the task BEFORE spawning it (ADR-8). The order is
  // load-bearing, not cosmetic: `spawn` returns a pid only after the
  // process exists, so "spawn then write" leaves a window where a crash
  // produces an invisible, unaddressable process. Writing `starting` first
  // means the registry always knows the task; the wrapper then confirms
  // itself through `<id>.pid` before it runs anything, and `pid: 0` here is
  // the honest "no pid confirmed yet" (never "pid 0").
  //
  // `log` and `exit_file` are stored relative to the project root, the shape
  // `design.md` §3.1 documents and `exitPathFor` resolves. `cwd` is the
  // resolved absolute directory the command runs in (R5) — inside the
  // project root, always.
  const entry: BackgroundEntry = {
    id,
    command,
    ...(description ? { description } : {}),
    cwd,
    pid: 0,
    log: join(BACKGROUND_DIR, `${id}.log`),
    exit_file: join(BACKGROUND_DIR, `${id}.exit`),
    status: "starting",
    exit_code: null,
    started_at: new Date().toISOString(),
    ended_at: null,
    started_by_context_key: contextKey,
    confirmed_by: confirmedBy,
  };
  try {
    writeEntry(dir, entry);
  } catch (error) {
    // Nothing was spawned yet, so there is nothing to compensate for. Fail
    // loudly instead of starting an untracked process.
    return startError(
      `Could not write the registry entry for a new background task: ${messageOf(error)}. ` +
        "Nothing was started.",
      { via: "error" },
    );
  }

  /**
   * Record a failed spawn on the entry that already exists, so the failure
   * is diagnosable from `list` / `output` instead of leaving a `starting`
   * entry that would only self-heal into an unexplained `exited`.
   */
  const recordSpawnFailure = (error: unknown): void => {
    try {
      const current = readEntry(dir, id);
      if (!current) return;
      writeEntry(dir, {
        ...current,
        status: "exited",
        ended_at: new Date().toISOString(),
        spawn_error: messageOf(error),
      });
    } catch {
      // This runs outside the tool's control flow (a listener, or the tail
      // of a failed start): a registry write that fails here must never
      // become an uncaught exception.
    }
  };

  // Step 3: spawn the detached wrapper. `unref()` drops it from this
  // process's event loop immediately; this function deliberately registers no
  // `exit`/`close` listener, so it cannot accidentally wait on the child.
  let pid: number | null;
  try {
    const child = spawnProcess(
      process.execPath,
      // `--cwd` is the *validated, absolute* directory: the wrapper's own
      // cwd stays the project root (so `--log`/`--exit` and this script's
      // location are independent of it), and the command itself runs where
      // the dialog said it would. It precedes `--` because everything after
      // `--` is the command. `--pid` is where the wrapper writes the
      // handshake; this function never writes that file itself.
      [
        runner,
        "--id",
        id,
        "--log",
        log,
        "--exit",
        exit,
        "--pid",
        pidFile,
        "--cwd",
        cwd,
        "--",
        command,
      ],
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
    child.on("error", recordSpawnFailure);
  } catch (error) {
    // A synchronous throw means no process exists, but the `starting`
    // entry already does. Turn it into a recorded `exited` failure: leaving
    // it as `starting` would make `stop` refuse for a minute and then
    // self-heal into a bare `exited` with no reason.
    recordSpawnFailure(error);
    return startError(`Could not start the background runner: ${messageOf(error)}`, {
      via: "error",
    });
  }

  // Step 4: backfill the pid `spawn` handed back and mark the task running.
  // This is the *second* atomic write on the same entry, and it happens
  // before the caller returns: every caller (and the existing tests) may
  // read `status: "running"` as soon as it has answered. The wrapper may
  // already have written `.pid`, which is fine — `readPid` prefers it.
  const running: BackgroundEntry = { ...entry, pid: pid ?? 0, status: "running" };
  try {
    writeEntry(dir, running);
  } catch (error) {
    // The process exists and the wrapper will still write `.pid`, so the
    // task stays addressable; only the tool's cache is stale.
    return startError(
      `The background runner started (pid ${pid ?? "unknown"}) but its registry entry could ` +
        `not be updated: ${messageOf(error)}. The task remains addressable through its pid file.`,
      { started: true, id, pid, log, confirmed_by: confirmedBy, via: "error" },
    );
  }

  // Step 5: tell the caller (the session's own bookkeeping). This is a
  // notification after the fact — the entry is on disk and the process is
  // already running — so a throwing callback is swallowed rather than
  // turning a successful start into an error.
  if (deps.onStarted) {
    try {
      deps.onStarted(id);
    } catch {
      /* a bookkeeping callback must not change the outcome */
    }
  }

  // Step 6: return. No child-process event is awaited anywhere above.
  return {
    details: { started: true, id, pid, log, confirmed_by: confirmedBy },
    text: startHumanText(id, pid, log, confirmedBy),
    isError: false,
  };
}
