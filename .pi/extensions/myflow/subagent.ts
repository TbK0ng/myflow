/**
 * `myflow_subagent` — the native Pi dispatch tool for the myflow workflow.
 *
 * Pi has no built-in sub-agents, so the myflow Pi adapter provides one. The
 * tool spawns an isolated `pi` process per delegated task, discovers agent
 * definitions from `.pi/agents/` (and `~/.pi/agent/agents/`), in two dispatch
 * modes:
 *
 *   - single:   { agent, task }
 *   - parallel: { tasks: [{ agent, task }, ...] }   (max 8, 4 concurrent)
 *
 * Live progress is reported through the tool's `onUpdate` callback and through
 * the `myflow-subagent-progress` event bus channel.
 *
 * Runtime imports are limited to Node builtins so the module stays importable
 * under `node --test` without installing the Pi package.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

export const MYFLOW_AGENT_ENV = "MYFLOW_AGENT_TYPE";
export const MYFLOW_CONTEXT_ENV = "MYFLOW_CONTEXT_ID";
export const PROGRESS_CHANNEL = "myflow-subagent-progress";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

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
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: SubagentMessage[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface SubagentDetails {
  mode: "single" | "parallel";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
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

/** The JSON-schema parameter object for the tool (plain JSON, no TypeBox). */
const SUBAGENT_PARAMETERS = {
  type: "object",
  properties: {
    agent: { type: "string", description: "Agent name for single mode" },
    task: { type: "string", description: "Task text for single mode" },
    tasks: {
      type: "array",
      description: "Parallel dispatch: one { agent, task } per subagent",
      items: {
        type: "object",
        properties: { agent: { type: "string" }, task: { type: "string" } },
        required: ["agent", "task"],
      },
    },
    agentScope: {
      type: "string",
      enum: ["user", "project", "both"],
      description: 'Which agent directories to use. Default: "both".',
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
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  const omitted = byteLength - Buffer.byteLength(truncated, "utf8");
  return `${truncated}\n\n[Output truncated: ${omitted} bytes omitted. Full output preserved in tool details.]`;
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

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    for (;;) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

interface DispatchDefaults {
  model?: string;
  thinkingLevel?: string;
}

interface RunOptions {
  defaultCwd: string;
  dispatchDefaults: DispatchDefaults;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  signal?: AbortSignal;
  contextKey: string | null;
  onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: SubagentDetails }) => void;
  makeDetails: (results: SingleResult[]) => SubagentDetails;
}

function applyUsage(usage: UsageStats, raw: NonNullable<SubagentMessage["usage"]>): void {
  usage.input += raw.input ?? 0;
  usage.output += raw.output ?? 0;
  usage.cacheRead += raw.cacheRead ?? 0;
  usage.cacheWrite += raw.cacheWrite ?? 0;
  usage.cost += raw.cost?.total ?? 0;
  usage.contextTokens = raw.totalTokens ?? usage.contextTokens;
}

async function runSingleAgent(options: RunOptions): Promise<SingleResult> {
  const { agents, agentName, task, defaultCwd, dispatchDefaults, contextKey, signal } = options;
  const agent = agents.find((candidate) => candidate.name === agentName);

  if (!agent) {
    const available = agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: EMPTY_USAGE(),
    };
  }

  // The parent process only has this tool because its own project is trusted.
  // `--approve` lets the isolated child load the same project extension so it
  // receives the myflow task context.
  const args: string[] = ["--mode", "json", "-p", "--no-session", "--approve"];
  const inheritsDispatchConfig = !agent.model;
  const model = agent.model ?? dispatchDefaults.model;
  if (model) args.push("--model", model);
  if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) args.push("--thinking", dispatchDefaults.thinkingLevel);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: EMPTY_USAGE(),
    model,
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

    args.push(`Task: ${task}`);

    let wasAborted = false;
    const invocation = getPiInvocation(args);
    const env: NodeJS.ProcessEnv = { ...process.env, [MYFLOW_AGENT_ENV]: agent.name };
    if (contextKey) env[MYFLOW_CONTEXT_ENV] = contextKey;

    const exitCode = await new Promise<number>((resolveExit) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd: defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      let buffer = "";

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
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        currentResult.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolveExit(code ?? 0);
      });

      proc.on("error", (error) => {
        currentResult.stderr += String(error);
        resolveExit(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
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
      "Delegate myflow work to a specialized sub-agent in an isolated context.",
      "Modes: single (agent + task) or parallel (tasks array, max 8).",
      "Agents are read from .pi/agents/ (project) and ~/.pi/agent/agents/ (user).",
      "myflow agents: myflow-implement, myflow-check, myflow-research.",
    ].join(" "),
    promptSnippet: "Delegate work to myflow-implement / myflow-check / myflow-research sub-agents",
    parameters: SUBAGENT_PARAMETERS,

    async execute(
      _toolCallId: string,
      params: {
        agent?: string;
        task?: string;
        tasks?: Array<{ agent: string; task: string }>;
        agentScope?: AgentScope;
      },
      signal: AbortSignal | undefined,
      onUpdate: ((partial: unknown) => void) | undefined,
      ctx: { cwd: string; model?: { provider: string; id: string }; thinkingLevel?: string },
    ) {
      const agentScope: AgentScope = params.agentScope ?? "both";
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const contextKey = registration.deriveContextKey?.(ctx) ?? null;
      const dispatchDefaults: DispatchDefaults = {
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.thinkingLevel,
      };

      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasTasks) + Number(hasSingle);

      const makeDetails =
        (mode: "single" | "parallel") =>
        (results: SingleResult[]): SubagentDetails => ({
          mode,
          agentScope,
          projectAgentsDir: discovery.projectAgentsDir,
          results,
        });

      const available = agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";

      if (modeCount !== 1) {
        return {
          content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` }],
          details: makeDetails("single")([]),
        };
      }

      const runOptions = (
        agentName: string,
        task: string,
        update: RunOptions["onUpdate"],
      ): RunOptions => ({
        defaultCwd: ctx.cwd,
        dispatchDefaults,
        agents,
        agentName,
        task,
        signal,
        contextKey,
        onUpdate: update,
        makeDetails: makeDetails(hasTasks ? "parallel" : "single"),
      });

      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          return {
            content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
            details: makeDetails("parallel")([]),
          };
        }

        const allResults: SingleResult[] = params.tasks.map((task) => ({
          agent: task.agent,
          agentSource: "unknown" as const,
          task: task.task,
          exitCode: -1,
          messages: [],
          stderr: "",
          usage: EMPTY_USAGE(),
        }));

        const emitParallel = () => {
          const running = allResults.filter((result) => result.exitCode === -1).length;
          const done = allResults.length - running;
          emitProgress({ mode: "parallel", done, running, total: allResults.length });
          (onUpdate as ((partial: unknown) => void) | undefined)?.({
            content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
            details: makeDetails("parallel")([...allResults]),
          });
        };

        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task, index) => {
          const result = await runSingleAgent(
            runOptions(task.agent, task.task, (partial) => {
              const current = partial.details.results[0];
              if (current) allResults[index] = current;
              emitParallel();
            }),
          );
          allResults[index] = result;
          emitParallel();
          return result;
        });

        const successCount = results.filter((result) => !isFailedResult(result)).length;
        const summaries = results.map((result) => {
          const status = isFailedResult(result)
            ? `failed${result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : ""}`
            : "completed";
          return `### [${result.agent}] ${status}\n\n${truncateParallelOutput(getResultOutput(result))}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
            },
          ],
          details: makeDetails("parallel")(results),
        };
      }

      if (params.agent && params.task) {
        emitProgress({ mode: "single", agent: params.agent });
        const result = await runSingleAgent(
          runOptions(params.agent, params.task, onUpdate as RunOptions["onUpdate"]),
        );
        if (isFailedResult(result)) {
          return {
            content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
            details: makeDetails("single")([result]),
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
          details: makeDetails("single")([result]),
        };
      }

      return {
        content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
        details: makeDetails("single")([]),
      };
    },
  });
}
