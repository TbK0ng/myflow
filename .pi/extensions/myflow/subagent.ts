/**
 * `myflow_subagent` — the Pi dispatch tool for the myflow workflow.
 *
 * A call names one agent and one or more prompts:
 *
 *   - single:   { agent, prompt }
 *   - parallel: { agent, prompt | prompts }   same agent, prompts run at once (max 6)
 *   - chain:    { agent, prompt | prompts }   same agent, sequential; later prompts
 *                                              receive "Previous output:"
 *
 * `agent` accepts `implement` or `myflow-implement`; it is normalized to the
 * `myflow-` prefix and must have a definition file in `.pi/agents/`.
 *
 * Children spawn in the caller's working directory: sub-agents share one
 * working tree. Parallel dispatch therefore requires each writing agent to
 * declare a bounded `writesUnder` scope (the child enforces it path-level);
 * a writer that declares no scope runs one at a time. This tool never creates
 * git worktrees.
 *
 * Every run is capped (`timeoutMs`, default 15 minutes, 0 disables it) and its
 * raw stream is kept under `.myflow/.runtime/subagent-logs/`, so a run that
 * never converges is reported and inspectable instead of blocking the caller.
 *
 * Live progress is reported through the tool's `onUpdate` callback and through
 * the `myflow-subagent-progress` event bus channel.
 *
 * Runtime imports are limited to Node builtins so the module stays importable
 * under `node --test` without installing the Pi package.
 */

import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type AgentConfig, discoverAgents, isSafeWriteScope } from "./agents.ts";

export const MYFLOW_AGENT_ENV = "MYFLOW_AGENT_TYPE";

/**
 * Carries an agent's declared `writesUnder` scope to the child process. The
 * child's path guard blocks any write/edit outside `<active task>/<scope>/`.
 * Injected only when the agent declares a scope.
 */
export const MYFLOW_WRITES_UNDER_ENV = "MYFLOW_WRITES_UNDER";

/**
 * Marks a process as a review worker for the verify gate. Dispatched
 * sub-agents carry an agent type instead; a channel worker is an ordinary pi
 * process, so its launcher flags it explicitly.
 */
export const MYFLOW_VERIFY_GATE_ENV = "MYFLOW_VERIFY_GATE";
export const MYFLOW_CONTEXT_ENV = "MYFLOW_CONTEXT_ID";
export const PROGRESS_CHANNEL = "myflow-subagent-progress";

export const AGENT_PREFIX = "myflow-";
export const DEFAULT_AGENT = "myflow-implement";
export const MAX_PARALLEL_PROMPTS = 6;

/**
 * Per-run wall clock cap. A dispatch that never converges used to block the
 * caller for as long as it liked (35 minutes, observed); the cap turns that
 * into a reported, inspectable stop. `timeoutMs: 0` removes it.
 */
export const SUBAGENT_TIMEOUT_MS = 900_000;

/** Raw stdout/stderr of each run, kept so a long or failed run can be read back. */
export const SUBAGENT_LOG_DIR = ".myflow/.runtime/subagent-logs";

/** Stop a child together with anything it started (MCP servers outlive a plain kill). */
export function killChildTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Minimal `pi` surface used by the subagent tool. */
export interface SubagentPi {
  registerTool(tool: Record<string, unknown>): void;
  events?: { emit(channel: string, data: unknown): void };
}

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

export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agent: string;
  runs: SingleResult[];
}

const EMPTY_USAGE = (): UsageStats => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
});

/** Tools that write to the shared working tree. */
const WRITE_TOOLS = new Set(["write", "edit"]);

/**
 * Whether an agent can write to the caller's working tree.
 *
 * An agent with no `tools:` allowlist runs with every tool, so it counts as a
 * writer. Parallel mode is rejected for a writer that declares no `writesUnder`
 * scope (see `hasWriteScope`): sub-agents share one tree, so only a writer whose
 * writes the child bounds to one directory may run alongside another.
 */
export function isWriteCapable(agent: AgentConfig): boolean {
  if (!agent.tools || agent.tools.length === 0) return true;
  return agent.tools.some((tool) => WRITE_TOOLS.has(tool));
}

/**
 * Whether an agent bounds its writes to a declared task-relative directory.
 *
 * A bounded writer may run in parallel: `runSingleAgent` injects the
 * declaration as `MYFLOW_WRITES_UNDER`, and the child's `tool_call` guard
 * refuses any write/edit outside `<active task>/<writesUnder>/`. This is a
 * *boundary* guarantee, not mutual exclusion: the code cannot verify that
 * parallel prompts write disjoint files, so it shrinks the blast radius to one
 * directory and the agent contract requires one topic per file.
 */
export function hasWriteScope(agent: AgentConfig): boolean {
  return declaresWriteScope(agent) && isSafeWriteScope(agent.writesUnder!);
}

/**
 * Whether an agent declares any non-blank `writesUnder` value.
 *
 * Deliberately weaker than `hasWriteScope`: the child's guard must activate on
 * *any* declaration so an unsafe scope fails closed inside the child instead of
 * leaving writes unbounded. Only parallel mode needs the stricter check, since
 * an escaping scope must not earn parallel mode.
 */
export function declaresWriteScope(agent: AgentConfig): boolean {
  return typeof agent.writesUnder === "string" && agent.writesUnder.trim().length > 0;
}

/** Normalize a caller-provided agent name to its `myflow-` form. */
export function normalizeAgentName(agent?: string): string {
  const name = agent?.trim() || DEFAULT_AGENT;
  return name.startsWith(AGENT_PREFIX) ? name : `${AGENT_PREFIX}${name}`;
}

function parseThinking(value: unknown): ThinkingLevel | undefined {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (THINKING_LEVELS as readonly string[]).includes(raw) ? (raw as ThinkingLevel) : undefined;
}

/** Split a trailing `:thinking` suffix off a model reference. */
export function splitModelThinking(model?: string): { model?: string; thinking?: ThinkingLevel } {
  const raw = model?.trim();
  if (!raw) return {};
  const suffix = raw.match(/:(off|minimal|low|medium|high|xhigh|max)$/i)?.[1];
  return {
    model: raw.replace(/:(off|minimal|low|medium|high|xhigh|max)$/i, ""),
    thinking: parseThinking(suffix),
  };
}

export interface RunConfig {
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
}

/**
 * Resolve model, thinking, and tools for one dispatch.
 *
 * Precedence: call parameters, then the agent definition, then the caller's
 * model and thinking level. A `model:thinking` suffix on any model reference
 * supplies the thinking level.
 */
export function resolveRunConfig(
  input: { model?: string; thinking?: string },
  agent: AgentConfig,
  inherited: { model?: string; thinking?: string } = {},
): RunConfig {
  const inputModel = splitModelThinking(input.model);
  const agentModel = splitModelThinking(agent.model);
  const model = inputModel.model || agentModel.model || inherited.model?.trim() || undefined;
  const thinking =
    parseThinking(input.thinking) ??
    inputModel.thinking ??
    parseThinking(agent.thinking) ??
    agentModel.thinking ??
    parseThinking(inherited.thinking);
  return { model, thinking, tools: agent.tools };
}

/** The JSON-schema parameter object for the tool (plain JSON, no TypeBox). */
const SUBAGENT_PARAMETERS = {
  type: "object",
  properties: {
    agent: { type: "string", description: "Agent name, such as myflow-implement or myflow-check. `implement` also works." },
    prompt: { type: "string", description: "Task prompt for the sub-agent." },
    mode: { type: "string", enum: ["single", "parallel", "chain"], description: "Dispatch mode. Default: single." },
    prompts: {
      type: "array",
      maxItems: MAX_PARALLEL_PROMPTS,
      items: { type: "string" },
      description: `Parallel or chain prompts, all for the same agent (max ${MAX_PARALLEL_PROMPTS}).`,
    },
    model: { type: "string", description: "Optional model override for the child process." },
    thinking: { type: "string", enum: [...THINKING_LEVELS], description: "Optional thinking level override." },
    timeoutMs: {
      type: "number",
      description: `Per-run cap in milliseconds (default ${SUBAGENT_TIMEOUT_MS}); 0 disables it. A stopped run reports the cap, its log path, and leaves any changes in the tree.`,
    },
  },
} as const;

export function getFinalOutput(messages: SubagentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{ type?: string; text?: string }>) {
      if (part?.type === "text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
}

export function isFailedResult(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
  if (result.timedOut) {
    const seconds = Math.round((result.durationMs ?? 0) / 1000);
    const partial = getFinalOutput(result.messages);
    return [
      `${result.agent} was stopped after ${seconds}s: it hit the dispatch cap (timeoutMs).`,
      "Changes it already made are still in the working tree; nothing was reverted.",
      "Inspect its log, then re-dispatch a bounded next step (or raise timeoutMs, 0 = no cap).",
      result.logPath ? `log: ${result.logPath}` : "",
      partial ? `\nlast output:\n${partial}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (isFailedResult(result)) {
    const detail = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
    return result.logPath ? `${detail}\n\nlog: ${result.logPath}` : detail;
  }
  return getFinalOutput(result.messages) || "(no output)";
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

interface RunOptions {
  projectRoot: string;
  agent: AgentConfig;
  prompt: string;
  config: RunConfig;
  signal?: AbortSignal;
  contextKey: string | null;
  timeoutMs: number;
  onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: SubagentDetails }) => void;
  makeDetails: (runs: SingleResult[]) => SubagentDetails;
}

async function runSingleAgent(options: RunOptions): Promise<SingleResult> {
  const { agent, prompt, projectRoot, config, contextKey, signal, timeoutMs } = options;

  // The parent process only has this tool because its own project is trusted.
  // `--approve` lets the isolated child load the same project extension so it
  // receives the myflow task context.
  const args: string[] = ["--mode", "json", "-p", "--no-session", "--approve"];
  if (config.model) {
    const model = config.thinking && config.thinking !== "off" && !config.model.includes(":")
      ? `${config.model}:${config.thinking}`
      : config.model;
    args.push("--model", model);
  } else if (config.thinking && config.thinking !== "off") {
    args.push("--thinking", config.thinking);
  }
  if (config.tools && config.tools.length > 0) args.push("--tools", config.tools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agent.name,
    prompt,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: EMPTY_USAGE(),
    model: config.model,
  };

  const emitUpdate = () => {
    if (!options.onUpdate) return;
    options.onUpdate({
      content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
      details: options.makeDetails([currentResult]),
    });
  };

  try {
    if (agent.systemPrompt.trim()) {
      tmpPromptDir = mkdtempSync(join(tmpdir(), "myflow-subagent-"));
      tmpPromptPath = join(tmpPromptDir, `prompt-${agent.name.replace(/[^\w.-]+/g, "_")}.md`);
      writeFileSync(tmpPromptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
      args.push("--append-system-prompt", tmpPromptPath);
    }

    args.push(prompt);

    let wasAborted = false;
    let timedOut = false;
    const startedAt = Date.now();
    const logPath = join(projectRoot, SUBAGENT_LOG_DIR, `${agent.name}-${startedAt}.log`);
    // The file appears with the first byte of output: a run that never produced
    // anything (a spawn failure, say) should not leave an empty log behind.
    const logStream = lazyLogStream(logPath, `# ${agent.name} @ ${new Date(startedAt).toISOString()}\n# prompt: ${prompt.slice(0, 400)}\n`);

    const invocation = getPiInvocation(args);
    const env: NodeJS.ProcessEnv = { ...process.env, [MYFLOW_AGENT_ENV]: agent.name };
    if (contextKey) env[MYFLOW_CONTEXT_ENV] = contextKey;
    // Hand the declared write scope to the child so it can enforce it path-level.
    // Inject on any non-blank declaration (not only a *safe* one) so the child's
    // guard activates and blocks an escaping scope; clearing it otherwise keeps an
    // inherited value from silently bounding an unscoped writer such as
    // myflow-implement.
    if (declaresWriteScope(agent)) env[MYFLOW_WRITES_UNDER_ENV] = agent.writesUnder!.trim();
    else delete env[MYFLOW_WRITES_UNDER_ENV];

    const exitCode = await new Promise<number>((resolveExit) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd: projectRoot,
        shell: false,
        // POSIX: own process group, so the whole tree can be signalled at once.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      let buffer = "";
      let settled = false;
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveExit(code);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killChildTree(proc.pid);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: { type?: string; message?: SubagentMessage };
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const message = event.message;
          currentResult.messages.push(message);
          if (message.role === "assistant") {
            currentResult.usage.turns += 1;
            if (message.usage) applyUsage(currentResult.usage, message.usage);
            if (!currentResult.model && message.model) currentResult.model = message.model;
            if (message.stopReason) currentResult.stopReason = message.stopReason;
            if (message.errorMessage) currentResult.errorMessage = message.errorMessage;
          }
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        logStream.write(data);
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        logStream.write(data);
        currentResult.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        if (timedOut) {
          // 124 mirrors timeout(1): the run was stopped by its own cap.
          finish(124);
          return;
        }
        finish(code ?? 0);
      });

      proc.on("error", (error) => {
        currentResult.stderr += String(error);
        finish(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          killChildTree(proc.pid);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    currentResult.timedOut = timedOut;
    currentResult.durationMs = Date.now() - startedAt;
    logStream.close();
    currentResult.logPath = logStream.path() ?? undefined;
    if (wasAborted) throw new Error("Subagent was aborted");
    return currentResult;
  } finally {
    if (tmpPromptDir) {
      try {
        rmSync(tmpPromptDir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup failure */
      }
    }
  }
}

export interface SubagentRegistration {
  /** Derive the parent session's myflow context key, if any. */
  deriveContextKey?: (ctx: unknown) => string | null;
}

/** Register the `myflow_subagent` tool on the Pi extension API. */
export function registerMyflowSubagent(pi: SubagentPi, registration: SubagentRegistration = {}): void {
  const emitProgress = (data: Record<string, unknown>) => {
    try {
      pi.events?.emit(PROGRESS_CHANNEL, data);
    } catch {
      /* progress is best-effort */
    }
  };

  pi.registerTool({
    name: "myflow_subagent",
    label: "Myflow Subagent",
    description: [
      "Run one myflow project sub-agent with active task context.",
      `Modes: single (prompt), parallel (prompts, max ${MAX_PARALLEL_PROMPTS}), chain (sequential prompts with "Previous output:").`,
      "The agent must have a definition file in .pi/agents/; `implement` expands to `myflow-implement`.",
      "Sub-agents share the caller's working tree: parallel mode is rejected for a write-capable agent that declares no `writesUnder` scope, so myflow-implement and myflow-check run one at a time. An agent that declares `writesUnder` (myflow-research -> research/) may run in parallel because the child confines each run's writes to that directory.",
      `Every run is capped (timeoutMs, default ${SUBAGENT_TIMEOUT_MS} ms; 0 disables the cap) and logs its stream under ${SUBAGENT_LOG_DIR}/; a stopped run reports its log path.`,
    ].join(" "),
    promptSnippet: "Run a myflow-implement / myflow-check / myflow-research sub-agent",
    parameters: SUBAGENT_PARAMETERS,

    async execute(
      _toolCallId: string,
      params: {
        agent?: string;
        prompt?: string;
        mode?: "single" | "parallel" | "chain";
        prompts?: string[];
        model?: string;
        thinking?: string;
        timeoutMs?: number;
      },
      signal: AbortSignal | undefined,
      onUpdate: ((partial: unknown) => void) | undefined,
      ctx: { cwd: string; model?: { provider: string; id: string }; thinkingLevel?: string },
    ) {
      const discovery = discoverAgents(ctx.cwd);
      const agents = discovery.agents;
      const agentName = normalizeAgentName(params.agent);
      const agent = agents.find((candidate) => candidate.name === agentName);

      if (!agent) {
        const known = agents.map((candidate) => candidate.name).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: [
                "`myflow_subagent` only runs agents with a definition file in .pi/agents/.",
                `No definition found for: ${agentName}`,
                `Defined agents: ${known}`,
                `Create .pi/agents/${agentName}.md to dispatch it.`,
              ].join("\n"),
            },
          ],
          details: { mode: "single", agent: agentName, runs: [] } satisfies SubagentDetails,
        };
      }

      const mode = params.mode ?? "single";
      const prompt = params.prompt?.trim();
      const prompts = (params.prompts ?? []).map((entry) => entry.trim()).filter(Boolean);
      if (mode === "single" && !prompt) {
        throw new Error("subagent prompt is required for single mode");
      }
      if ((mode === "parallel" || mode === "chain") && !prompt && prompts.length === 0) {
        throw new Error("subagent prompt or prompts are required for parallel/chain mode");
      }
      if (mode === "parallel" && prompts.length > MAX_PARALLEL_PROMPTS) {
        throw new Error(`subagent parallel mode supports at most ${MAX_PARALLEL_PROMPTS} prompts`);
      }
      if (mode === "parallel" && isWriteCapable(agent) && !hasWriteScope(agent)) {
        // The rule the workflow, the tool description, and this check all state:
        // one *unbounded* writer per working tree. A declared `writesUnder`
        // scope makes a writer parallel-safe within that directory. Repeats in
        // single/chain mode are fine — they are sequential.
        throw new Error(
          `parallel dispatch needs a bounded writer: ${agent.name} can write and declares no \`writesUnder\` scope, ` +
            "and sub-agents share the caller's working tree. " +
            "Either run one writer at a time (single or chain), or add `writesUnder: <dir>` to its frontmatter " +
            "so the child confines every write to `<active task>/<dir>/` (one file per prompt).",
        );
      }

      const config = resolveRunConfig(params, agent, {
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinking: ctx.thinkingLevel,
      });
      const contextKey = registration.deriveContextKey?.(ctx) ?? null;
      const timeoutMs =
        typeof params.timeoutMs === "number" && params.timeoutMs >= 0 ? params.timeoutMs : SUBAGENT_TIMEOUT_MS;
      const makeDetails = (runs: SingleResult[]): SubagentDetails => ({ mode, agent: agentName, runs });
      const runOptions = (runPrompt: string, update: RunOptions["onUpdate"]): RunOptions => ({
        projectRoot: ctx.cwd,
        agent,
        prompt: runPrompt,
        config,
        signal,
        contextKey,
        timeoutMs,
        onUpdate: update,
        makeDetails,
      });

      emitProgress({ mode, agent: agentName, prompts: mode === "single" ? 1 : prompts.length });

      if (mode === "parallel") {
        const runPrompts = prompts.length > 0 ? prompts : [prompt!];
        const runs = await Promise.all(
          runPrompts.map((entry) => runSingleAgent(runOptions(entry, onUpdate as RunOptions["onUpdate"]))),
        );
        return {
          content: [{ type: "text", text: runs.map(getResultOutput).join("\n\n---\n\n") }],
          details: makeDetails(runs),
          isError: runs.some(isFailedResult),
        };
      }

      if (mode === "chain") {
        const runPrompts = prompts.length > 0 ? prompts : [prompt!];
        const runs: SingleResult[] = [];
        let previous = "";
        for (const entry of runPrompts) {
          const composed = previous ? `${entry}\n\nPrevious output:\n${previous}` : entry;
          const result = await runSingleAgent(runOptions(composed, onUpdate as RunOptions["onUpdate"]));
          runs.push(result);
          previous = getFinalOutput(result.messages);
          if (isFailedResult(result)) break;
        }
        return {
          content: [{ type: "text", text: previous || "(no output)" }],
          details: makeDetails(runs),
          isError: runs.some(isFailedResult),
        };
      }

      const run = await runSingleAgent(runOptions(prompt!, onUpdate as RunOptions["onUpdate"]));
      return {
        content: [{ type: "text", text: getResultOutput(run) }],
        details: makeDetails([run]),
        isError: isFailedResult(run),
      };
    },
  });
}
