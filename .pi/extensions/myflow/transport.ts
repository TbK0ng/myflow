/**
 * The RPC transport for one front-run of `myflow_subagent`.
 *
 * A run used to be `pi --mode json -p` plus "wait for the exit code": there was
 * no way to say anything to a child that was already thinking, so a stuck run
 * could only be killed. This module owns the replacement — one child process
 * driven over `pi --mode rpc`, with a settle state machine:
 *
 *   stdin   {"id":"p0","type":"prompt","message":…} first, then `steer` / `abort`
 *   stdout  `message_end` (accumulate), `agent_settled` (settle), `response`
 *           (did the prompt start?), `extension_ui_request` (answer cancelled)
 *   files   `.myflow/.runtime/subagents/<runId>.json`    registry entry
 *           `.myflow/.runtime/subagents/<runId>.ctl.jsonl` board → run commands
 *
 * Three properties are load-bearing and each has a test:
 *
 *   - **Every wait has a cap** (prompt acceptance 10s, abort grace 5s, exit
 *     grace 5s). A child that ignores `abort`, or ignores the closed stdin, is
 *     killed; nothing in this state machine can wait on another pi forever.
 *   - **Settle is `agent_settled`, not process exit.** `exitCode` is recorded
 *     as reference only — an rpc child can exit 0 after failing, so failure is
 *     decided by what the child reported (`isFailedResult`).
 *   - **The control file is the only channel into a running child.** The board
 *     may be a different session than the dispatcher, so `steer` / `abort` are
 *     appended to `<runId>.ctl.jsonl` and polled here once a second; the poll
 *     also refreshes the registry heartbeat, which is what makes a run whose
 *     dispatcher disappeared show up as `stale` instead of running forever.
 *
 * Runtime imports are Node builtins plus the node-only `runs.ts` / `ctl.ts`, so
 * this module is importable under `node --test` without the Pi package. The
 * result types live here because this module produces them; `subagent.ts`
 * re-exports them, and the dependency between the two is one-way at runtime.
 */

import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { appendControl, clearControls, ctlPath, readNewControls } from "./ctl.ts";
import { addSteer, finish, heartbeat, markRunning, readRun, runsDir } from "./runs.ts";

/** Carries an agent's name to the child, so the child knows it is a sub-agent. */
export const MYFLOW_AGENT_ENV = "MYFLOW_AGENT_TYPE";

/** Carries the dispatching session's myflow context key to the child. */
export const MYFLOW_CONTEXT_ENV = "MYFLOW_CONTEXT_ID";

/**
 * Carries an agent's declared `writesUnder` scope to the child process. The
 * child's path guard blocks any write/edit outside `<active task>/<scope>/`.
 * Injected only when the agent declares a non-blank scope.
 */
export const MYFLOW_WRITES_UNDER_ENV = "MYFLOW_WRITES_UNDER";

/** Raw stdout/stderr of each run, kept so a long or failed run can be read back. */
export const SUBAGENT_LOG_DIR = ".myflow/.runtime/subagent-logs";

/** The bounded waits of the state machine; injectable so tests stay fast. */
export interface RunTimings {
  /** How long the child gets to answer the prompt before the run is failed. */
  promptAcceptMs: number;
  /** How long an aborted run gets to settle before its tree is killed. */
  abortGraceMs: number;
  /** How long a settled run gets to exit after its stdin is closed. */
  exitGraceMs: number;
  /** Control-file / heartbeat poll interval. */
  pollMs: number;
}

export const DEFAULT_RUN_TIMINGS: RunTimings = {
  promptAcceptMs: 10_000,
  abortGraceMs: 5_000,
  exitGraceMs: 5_000,
  pollMs: 1_000,
};

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SubagentMessage {
  role: string;
  content?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
    totalTokens?: number;
  };
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface SingleResult {
  agent: string;
  prompt: string;
  exitCode: number;
  messages: SubagentMessage[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  /** Durability for a run that outlives the caller's patience: raw child stream. */
  logPath?: string;
  /** The run hit its cap and was stopped; whatever it changed stays in the tree. */
  timedOut?: boolean;
  durationMs?: number;
}

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/**
 * Whether a run failed.
 *
 * `exitCode` is deliberately absent: under rpc a child can exit 0 after a
 * failed turn and non-zero after a clean stop, so the outcome comes from what
 * the child reported. A timeout or a stop counts as a failure too — the caller
 * asked for a finished run, not for a partial one.
 */
export function isFailedResult(result: SingleResult): boolean {
  return (
    result.timedOut === true ||
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    result.stopReason === "timeout" ||
    // The child left before it settled: nothing reported an outcome, which is a
    // failure even if the process exited 0.
    result.stopReason === "unexpected exit"
  );
}

/**
 * Stop a child together with anything it started (MCP servers outlive a plain
 * kill). `taskkill /T` is the only way to reach the whole tree on Windows.
 */
export function killChildTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

/** Resolve how to invoke another Pi process. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

/** What one run needs from its caller; everything is a plain value. */
export interface StartRunOptions {
  projectRoot: string;
  /** Allocated by `queueGroup`; the registry entry already exists as `queued`. */
  runId: string;
  agentName: string;
  /** The agent definition's system prompt, injected via `--append-system-prompt`. */
  systemPrompt: string;
  /**
   * Already normalized: the trimmed `writesUnder` when the agent declares one,
   * otherwise null. The decision itself stays with `subagent.ts`.
   */
  writesUnder: string | null;
  prompt: string;
  /** Model / thinking / tools, resolved by the caller (`resolveRunConfig`). */
  config: { model?: string; thinking?: string; tools?: string[] };
  contextKey: string | null;
  /** Wall-clock cap in ms; 0 disables it. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called after every `message_end` so the tool can publish progress. */
  onUpdate?: (result: SingleResult) => void;
  /** Test seam; production passes nothing. */
  timings?: Partial<RunTimings>;
}

/** The handle a caller drives one run with (`design.md` §3). */
export interface RunHandle {
  runId: string;
  /** The control file the board appends `steer` / `abort` to. */
  controlPath: string;
  settled: Promise<SingleResult>;
  /** Queue a steer; true when it was written (false after settle). */
  steer(message: string): boolean;
  abort(reason?: "abort" | "timeout"): void;
}

/** A record read from the child's stdout. Unknown fields are tolerated. */
interface RpcRecord {
  type?: string;
  id?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: { disposition?: string };
  aborted?: boolean;
  method?: string;
  message?: SubagentMessage;
}

/** `ctx.ui` methods that block until the client answers. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** The id of the one prompt this run sends. */
const PROMPT_ID = "p0";

/** A final status: `finalize` is never called with `queued` / `running`. */
type TerminalStatus = "done" | "failed" | "timeout" | "stopped";

interface LazyLog {
  write(chunk: Buffer): void;
  close(): void;
  path(): string | null;
}

/** Append-only log that only touches the disk once there is something to write. */
function lazyLogStream(target: string, header: string): LazyLog {
  let stream: ReturnType<typeof createWriteStream> | null = null;
  let failed = false;
  const open = () => {
    if (stream || failed) return stream;
    try {
      mkdirSync(dirname(target), { recursive: true });
      stream = createWriteStream(target, { flags: "a" });
      // A write stream reports a disk/permission failure as an `error` event; with
      // no listener that becomes an uncaught exception in the host session. The
      // log is best-effort, so a failure drops the log and keeps the run.
      stream.on("error", () => {
        failed = true;
      });
      stream.write(header);
    } catch {
      failed = true;
      stream = null;
    }
    return stream;
  };
  return {
    write(chunk: Buffer) {
      open()?.write(chunk);
    },
    close() {
      try {
        stream?.end();
      } catch {
        /* the log is best-effort */
      }
    },
    path() {
      return stream ? target : null;
    },
  };
}

function applyUsage(usage: UsageStats, raw: NonNullable<SubagentMessage["usage"]>): void {
  usage.input += raw.input ?? 0;
  usage.output += raw.output ?? 0;
  usage.cacheRead += raw.cacheRead ?? 0;
  usage.cacheWrite += raw.cacheWrite ?? 0;
  usage.cost += raw.cost?.total ?? 0;
  usage.contextTokens = raw.totalTokens ?? usage.contextTokens;
}

/** A project-relative path with `/` separators, the shape the registry stores. */
function toPosixRelative(projectRoot: string, path: string): string {
  return relative(projectRoot, path).split("\\").join("/");
}

/**
 * Build the child's argv.
 *
 * `--mode rpc` instead of `-p --mode json`: the prompt arrives on stdin as the
 * first record, which is what keeps a channel open for `steer` / `abort`. Model,
 * thinking, tools, and the appended system prompt are the same options the old
 * transport passed.
 */
function buildArgs(options: StartRunOptions, promptPath: string | null): string[] {
  const { config } = options;
  const args = ["--mode", "rpc", "--no-session", "--approve"];
  if (config.model) {
    const model =
      config.thinking && config.thinking !== "off" && !config.model.includes(":")
        ? `${config.model}:${config.thinking}`
        : config.model;
    args.push("--model", model);
  } else if (config.thinking && config.thinking !== "off") {
    args.push("--thinking", config.thinking);
  }
  if (config.tools && config.tools.length > 0) args.push("--tools", config.tools.join(","));
  if (promptPath) args.push("--append-system-prompt", promptPath);
  return args;
}

/**
 * Start one run and return a handle. Never throws: a setup or spawn failure is
 * reported as a settled, failed result (and a failed registry entry), because a
 * dispatch that cannot even spawn must not leave a `queued` entry behind.
 */
export function startRun(options: StartRunOptions): RunHandle {
  const timings: RunTimings = { ...DEFAULT_RUN_TIMINGS, ...(options.timings ?? {}) };
  const dir = runsDir(options.projectRoot);
  const controlPath = ctlPath(dir, options.runId);
  // A control line left over from an earlier run must never steer this one.
  clearControls(controlPath);

  const startedAt = Date.now();
  const logFile = join(options.projectRoot, SUBAGENT_LOG_DIR, `${options.agentName}-${startedAt}.log`);
  const logStream = lazyLogStream(
    logFile,
    `# ${options.agentName} @ ${new Date(startedAt).toISOString()}\n# prompt: ${options.prompt.slice(0, 400)}\n`,
  );

  const result: SingleResult = {
    agent: options.agentName,
    prompt: options.prompt,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: options.config.model,
  };

  let proc: ChildProcess | null = null;
  let isSettled = false;
  let exited = false;
  let promptAccepted = false;
  let abortReason: "abort" | "timeout" | null = null;
  let graceRunning = false;
  let buffer = "";
  let controlOffset = 0;
  let tmpPromptDir: string | null = null;
  const handledControls = new Set<string>();

  let acceptTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let exitTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  let resolveSettled!: (value: SingleResult) => void;
  const settledPromise = new Promise<SingleResult>((resolve) => {
    resolveSettled = resolve;
  });

  const clearTimers = () => {
    for (const timer of [acceptTimer, timeoutTimer, graceTimer, exitTimer]) {
      if (timer) clearTimeout(timer);
    }
    if (pollTimer) clearInterval(pollTimer);
    acceptTimer = timeoutTimer = graceTimer = exitTimer = pollTimer = null;
  };

  const cleanupTmp = () => {
    if (!tmpPromptDir) return;
    try {
      rmSync(tmpPromptDir, { recursive: true, force: true });
    } catch {
      /* cleanup failure must not change a run's outcome */
    }
    tmpPromptDir = null;
  };

  /** The one handle shape, so a failed start looks like a settled one. */
  const handle = (): RunHandle => ({
    runId: options.runId,
    controlPath,
    settled: settledPromise,
    steer(message: string): boolean {
      if (isSettled) return false;
      try {
        appendControl(controlPath, { type: "steer", message });
        return true;
      } catch {
        return false;
      }
    },
    abort(reason: "abort" | "timeout" = "abort"): void {
      requestAbort(reason);
    },
  });

  /** Write one record to the child's stdin; false when the pipe is gone. */
  const writeRecord = (record: Record<string, unknown>): boolean => {
    const stdin = proc?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
    try {
      stdin.write(`${JSON.stringify(record)}\n`);
      return true;
    } catch {
      return false;
    }
  };

  const failSetup = (message: string): RunHandle => {
    result.stderr += message;
    result.durationMs = Date.now() - startedAt;
    result.stopReason = "error";
    result.errorMessage = message;
    try {
      finish(dir, options.runId, "failed", {
        stopReason: "error",
        errorMessage: message,
        logPath: toPosixRelative(options.projectRoot, logFile),
      });
    } catch {
      /* the caller still gets the result */
    }
    cleanupTmp();
    resolveSettled(result);
    return handle();
  };

  /**
   * Record the run's final state exactly once, then unwind.
   *
   * Order matters: timers stop first (no callback may race this), then the
   * registry entry becomes terminal (a reader that sees the log is finished
   * must not still see `running`), then the control file is dropped, then the
   * child is asked to leave — and killed if it does not.
   */
  const finalize = (requested: TerminalStatus, patch: { stopReason?: string; errorMessage?: string } = {}) => {
    if (isSettled) return;
    isSettled = true;
    clearTimers();
    options.signal?.removeEventListener("abort", onSignalAbort);
    // A run stopped from the board (`x` / `X`) is killed at once, possibly before
    // this side polled the abort line. The board already recorded `stopped`; this
    // side's "unexpected exit" must not rewrite the verdict the operator asked for.
    const boardStopped = requested === "failed" && readRun(dir, options.runId)?.status === "stopped";
    const status: TerminalStatus = boardStopped ? "stopped" : requested;
    result.durationMs = Date.now() - startedAt;
    result.timedOut = status === "timeout";
    if (status === "timeout") result.stopReason = "timeout";
    else if (status === "stopped") result.stopReason = "aborted";
    if (!boardStopped) {
      if (patch.stopReason) result.stopReason = patch.stopReason;
      if (patch.errorMessage) result.errorMessage = patch.errorMessage;
    }
    // The log opens with the first byte the child produced; a run that never
    // produced anything (a spawn failure) reports no log rather than an empty one.
    const written = logStream.path();
    if (written) result.logPath = written;
    try {
      finish(dir, options.runId, status, {
        exitCode: result.exitCode,
        // A recorded `stopped` keeps the board's reason as well, not just its status.
        ...(boardStopped
          ? {}
          : { stopReason: result.stopReason ?? null, errorMessage: result.errorMessage ?? null }),
        logPath: toPosixRelative(options.projectRoot, logFile),
      });
    } catch {
      /* a registry write failure must not lose the run's outcome */
    }
    clearControls(controlPath);
    cleanupTmp();
    if (proc && !exited) {
      // Closing stdin is the documented "you may leave now"; the grace timer is
      // what keeps a child that ignores it from lingering after the caller has
      // already been told the run is over.
      try {
        proc.stdin?.end();
      } catch {
        /* the pipe is already gone */
      }
      const pid = proc.pid;
      exitTimer = setTimeout(() => killChildTree(pid), timings.exitGraceMs);
      if (typeof exitTimer.unref === "function") exitTimer.unref();
    } else {
      logStream.close();
    }
    resolveSettled(result);
  };

  /** Ask the child to stop; the grace timer turns an ignored abort into a kill. */
  function requestAbort(reason: "abort" | "timeout"): void {
    if (isSettled || graceRunning) return;
    abortReason = abortReason ?? reason;
    graceRunning = true;
    writeRecord({ type: "abort" });
    graceTimer = setTimeout(() => {
      graceRunning = false;
      if (isSettled) return;
      killChildTree(proc?.pid);
      finalize(abortReason === "timeout" ? "timeout" : "stopped", {
        errorMessage:
          abortReason === "timeout"
            ? `the run hit its cap (${options.timeoutMs} ms) and was stopped`
            : "the run was stopped from the board",
      });
    }, timings.abortGraceMs);
    if (typeof graceTimer.unref === "function") graceTimer.unref();
  }

  function onSignalAbort(): void {
    requestAbort("abort");
  }

  const noteAccepted = () => {
    promptAccepted = true;
    if (acceptTimer) {
      clearTimeout(acceptTimer);
      acceptTimer = null;
    }
  };

  const recordMessage = (message: SubagentMessage) => {
    result.messages.push(message);
    if (message.role === "assistant") {
      result.usage.turns += 1;
      if (message.usage) applyUsage(result.usage, message.usage);
      if (!result.model && message.model) result.model = message.model;
      if (message.stopReason) result.stopReason = message.stopReason;
      if (message.errorMessage) result.errorMessage = message.errorMessage;
    }
    try {
      options.onUpdate?.(result);
    } catch {
      /* progress is best-effort */
    }
  };

  /** `agent_settled` is the one and only completion signal. */
  const settleFromAgent = (aborted: boolean) => {
    if (isSettled) return;
    if (abortReason === "timeout") return finalize("timeout");
    if (abortReason === "abort" || aborted) return finalize("stopped");
    return finalize(isFailedResult(result) ? "failed" : "done");
  };

  const onResponse = (event: RpcRecord) => {
    if (isSettled) return;
    // Only the prompt response decides anything; a steer/abort response is an
    // acknowledgement, not an outcome.
    if (event.command !== "prompt" && event.id !== PROMPT_ID) return;
    noteAccepted();
    const disposition = event.data?.disposition;
    if (event.success !== false && (disposition === "started" || disposition === "queued")) return;
    // `handled` means no run started for this prompt, so waiting for
    // `agent_settled` would wait for an event that never comes.
    const reason =
      disposition === "handled"
        ? "the child handled the prompt without starting a run"
        : event.error ?? `the child refused the prompt (disposition: ${disposition ?? "none"})`;
    killChildTree(proc?.pid);
    finalize("failed", { stopReason: "error", errorMessage: reason });
  };

  const answerUiRequest = (event: RpcRecord) => {
    const method = event.method ?? "";
    if (!event.id || !DIALOG_METHODS.has(method)) return; // fire-and-forget: ignored
    // A dispatched run has no user behind it: answer as cancelled so the child's
    // turn ends instead of blocking on a reply nobody will send.
    writeRecord({ type: "extension_ui_response", id: event.id, cancelled: true });
  };

  const handleLine = (raw: string) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.trim()) return;
    let event: RpcRecord;
    try {
      event = JSON.parse(line) as RpcRecord;
    } catch {
      return; // not a protocol record: never let one line end the run
    }
    switch (event.type) {
      case "message_end":
        if (event.message) {
          noteAccepted(); // a message proves the prompt was accepted
          recordMessage(event.message);
        }
        return;
      case "agent_settled":
        noteAccepted();
        settleFromAgent(event.aborted === true);
        return;
      case "response":
        onResponse(event);
        return;
      case "extension_ui_request":
        answerUiRequest(event);
        return;
      default:
        return; // unknown records are ignored, never thrown
    }
  };

  // ---- argv, env, spawn ---------------------------------------------------

  const promptName = `prompt-${options.agentName.replace(/[^\w.-]+/g, "_")}.md`;
  let promptPath: string | null = null;
  if (options.systemPrompt.trim()) {
    try {
      tmpPromptDir = mkdtempSync(join(tmpdir(), "myflow-subagent-"));
      promptPath = join(tmpPromptDir, promptName);
      writeFileSync(promptPath, options.systemPrompt, { encoding: "utf-8", mode: 0o600 });
    } catch (error) {
      return failSetup(`could not write the agent system prompt: ${String(error)}`);
    }
  }

  const env: NodeJS.ProcessEnv = { ...process.env, [MYFLOW_AGENT_ENV]: options.agentName };
  if (options.contextKey) env[MYFLOW_CONTEXT_ENV] = options.contextKey;
  // The scope reaches the child exactly as the agent declared it (blank means
  // "no scope"), so the child's guard fails closed on an escaping declaration.
  if (options.writesUnder) env[MYFLOW_WRITES_UNDER_ENV] = options.writesUnder;
  else delete env[MYFLOW_WRITES_UNDER_ENV];

  const args = buildArgs(options, promptPath);

  try {
    const invocation = getPiInvocation(args);
    proc = spawn(invocation.command, invocation.args, {
      cwd: options.projectRoot,
      shell: false,
      // Not detached: the tree is stopped by `taskkill /T` on pid, not by
      // signalling a process group.
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
  } catch (error) {
    return failSetup(`could not start the child process: ${String(error)}`);
  }

  markRunning(dir, options.runId, {
    pid: typeof proc.pid === "number" ? proc.pid : null,
    logPath: toPosixRelative(options.projectRoot, logFile),
  });

  const child = proc;
  // A write to a child that has already gone emits EPIPE *asynchronously* on the
  // stream, so the `try` in `writeRecord` cannot catch it and an unhandled `error`
  // event would take down the host session. Steering a run that just died is
  // normal (the board and the exit race), so the pipes report and continue.
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.on("error", (error: Error) => {
      result.stderr += String(error);
    });
  }

  child.stdout?.on("data", (data: Buffer) => {
    logStream.write(data);
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });

  child.stderr?.on("data", (data: Buffer) => {
    logStream.write(data);
    result.stderr += data.toString();
  });

  child.on("close", (code) => {
    exited = true;
    result.exitCode = typeof code === "number" ? code : result.exitCode;
    if (buffer.trim()) handleLine(buffer);
    buffer = "";
    if (!isSettled) {
      // The child left before it settled: a run whose outcome nobody heard is
      // a failure, unless the caller already asked for the stop.
      if (abortReason) finalize(abortReason === "timeout" ? "timeout" : "stopped");
      else finalize("failed", { stopReason: "unexpected exit" });
    }
    logStream.close();
  });

  child.on("error", (error) => {
    result.stderr += String(error);
    killChildTree(child.pid);
    finalize("failed", { stopReason: "error", errorMessage: String(error) });
  });

  // ---- prompt, cap, controls ---------------------------------------------

  if (!writeRecord({ id: PROMPT_ID, type: "prompt", message: options.prompt })) {
    killChildTree(child.pid);
    finalize("failed", { stopReason: "error", errorMessage: "the child's stdin is not writable" });
    return handle();
  }

  acceptTimer = setTimeout(() => {
    if (isSettled || promptAccepted) return;
    killChildTree(child.pid);
    finalize("failed", {
      stopReason: "error",
      errorMessage: `the child did not accept the prompt within ${timings.promptAcceptMs} ms`,
    });
  }, timings.promptAcceptMs);
  if (typeof acceptTimer.unref === "function") acceptTimer.unref();

  if (options.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => requestAbort("timeout"), options.timeoutMs);
    if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();
  }

  if (options.signal) {
    if (options.signal.aborted) onSignalAbort();
    else options.signal.addEventListener("abort", onSignalAbort, { once: true });
  }

  pollTimer = setInterval(() => {
    if (isSettled) return;
    try {
      // The heartbeat is the board's only evidence of life: no process is
      // probed, so a missed beat is what turns a run into `stale`.
      heartbeat(dir, options.runId);
      const batch = readNewControls(controlPath, controlOffset);
      controlOffset = batch.offset;
      for (const command of batch.commands) {
        // Two sessions may steer the same run; an id is forwarded once.
        if (command.id) {
          if (handledControls.has(command.id)) continue;
          handledControls.add(command.id);
        }
        if (command.type === "steer") {
          const message = command.message.trim();
          if (!message) continue;
          if (writeRecord({ type: "steer", message })) addSteer(dir, options.runId, message);
        } else {
          requestAbort("abort");
        }
      }
    } catch {
      /* a poll that cannot write must not end the run or crash the session */
    }
  }, timings.pollMs);
  if (typeof pollTimer.unref === "function") pollTimer.unref();

  return handle();
}
