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
 * Each run also registers itself under `.myflow/.runtime/subagents/` before it
 * starts, so the `/mysubagents` board and any other session can see it — and
 * steer or stop it — while it runs.
 *
 * The child process itself (rpc transport, settle state machine, control-file
 * polling) lives in `transport.ts`; this module decides *what* to dispatch and
 * turns the results into the tool's answer.
 *
 * Live progress is reported through the tool's `onUpdate` callback and through
 * the `myflow-subagent-progress` event bus channel.
 *
 * Runtime imports are limited to Node builtins and the node-only modules of
 * this directory, so the module stays importable under `node --test` without
 * installing the Pi package.
 */

import { relative } from "node:path";
import { type AgentConfig, discoverAgents, isSafeWriteScope } from "./agents.ts";
import { resolveActiveTaskStatus } from "./turn-cache.ts";
import { newGroupId, queueGroup, runsDir } from "./runs.ts";
import {
  MYFLOW_AGENT_ENV,
  MYFLOW_CONTEXT_ENV,
  MYFLOW_WRITES_UNDER_ENV,
  SUBAGENT_LOG_DIR,
  getPiInvocation,
  isFailedResult,
  killChildTree,
  startRun,
  type SingleResult,
  type SubagentMessage,
  type UsageStats,
} from "./transport.ts";

// The transport owns the child process, so the pieces tied to it live there;
// they are re-exported here because this module is the tool's public surface.
export {
  MYFLOW_AGENT_ENV,
  MYFLOW_CONTEXT_ENV,
  MYFLOW_WRITES_UNDER_ENV,
  SUBAGENT_LOG_DIR,
  getPiInvocation,
  isFailedResult,
  killChildTree,
};
export type { SingleResult, SubagentMessage, UsageStats };

/**
 * Marks a process as a review worker for the verify gate. Dispatched
 * sub-agents carry an agent type instead; a channel worker is an ordinary pi
 * process, so its launcher flags it explicitly.
 */
export const MYFLOW_VERIFY_GATE_ENV = "MYFLOW_VERIFY_GATE";
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

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Minimal `pi` surface used by the subagent tool. */
export interface SubagentPi {
  registerTool(tool: Record<string, unknown>): void;
  events?: { emit(channel: string, data: unknown): void };
}

export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agent: string;
  runs: SingleResult[];
}

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

/**
 * Run one sub-agent and return its result.
 *
 * Everything about the child process — rpc argv, settle state machine, control
 * poll, log file, registry entry — belongs to `startRun`; this function only
 * turns the settled result into the caller's shape.
 */
async function runSingleAgent(options: RunOptions, runId: string): Promise<SingleResult> {
  const { agent, prompt, projectRoot, config, contextKey, signal, timeoutMs } = options;

  const handle = startRun({
    projectRoot,
    runId,
    agentName: agent.name,
    systemPrompt: agent.systemPrompt,
    // Inject on any non-blank declaration (not only a *safe* one) so the child's
    // guard activates and blocks an escaping scope; clearing it otherwise keeps an
    // inherited value from silently bounding an unscoped writer such as
    // myflow-implement.
    writesUnder: declaresWriteScope(agent) ? agent.writesUnder!.trim() : null,
    prompt,
    config,
    contextKey,
    timeoutMs,
    signal,
    onUpdate: (result) => {
      if (!options.onUpdate) return;
      options.onUpdate({
        content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
        details: options.makeDetails([result]),
      });
    },
  });

  // A cancelled caller still gets a result: the run is stopped and marked as an
  // error instead of throwing out of the middle of a parallel dispatch.
  return handle.settled;
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

      const runPrompts = mode === "single" ? [prompt!] : prompts.length > 0 ? prompts : [prompt!];
      const { taskDir } = resolveActiveTaskStatus(ctx.cwd, contextKey);
      // Register the whole dispatch before any child starts, so a chain member
      // that has not had its turn — and a run the caller never gets to await —
      // is visible to (and stoppable from) the board. A chain member's entry
      // records the prompt as dispatched; the "Previous output:" suffix is added
      // per run and exists only in that run's log.
      const queued = queueGroup(
        runsDir(ctx.cwd),
        runPrompts.map((entry) => ({
          agent: agentName,
          mode,
          prompt: entry,
          task: taskDir ? relative(ctx.cwd, taskDir).split("\\").join("/") : null,
          model: config.model ?? null,
        })),
        { group: newGroupId(), contextKey },
      );

      emitProgress({ mode, agent: agentName, prompts: runPrompts.length });

      if (mode === "parallel") {
        const runs = await Promise.all(
          runPrompts.map((entry, index) =>
            runSingleAgent(runOptions(entry, onUpdate as RunOptions["onUpdate"]), queued[index].runId),
          ),
        );
        return {
          content: [{ type: "text", text: runs.map(getResultOutput).join("\n\n---\n\n") }],
          details: makeDetails(runs),
          isError: runs.some(isFailedResult),
        };
      }

      if (mode === "chain") {
        const runs: SingleResult[] = [];
        let previous = "";
        for (let index = 0; index < runPrompts.length; index += 1) {
          const entry = runPrompts[index];
          const composed = previous ? `${entry}\n\nPrevious output:\n${previous}` : entry;
          const result = await runSingleAgent(
            runOptions(composed, onUpdate as RunOptions["onUpdate"]),
            queued[index].runId,
          );
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

      const run = await runSingleAgent(runOptions(prompt!, onUpdate as RunOptions["onUpdate"]), queued[0].runId);
      return {
        content: [{ type: "text", text: getResultOutput(run) }],
        details: makeDetails([run]),
        isError: isFailedResult(run),
      };
    },
  });
}
