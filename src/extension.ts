import { findProjectRoot } from "./find-project-root.ts";
import { TurnContextCache } from "./turn-cache.ts";
import { readPromptInjectionSkipKeyword, shouldSkipWorkflowState } from "./escape-hatch.ts";
import {
  type AgentType,
  taskContextJsonlNames,
  taskContextInputPaths,
  taskContextSignature,
  ContextBudget,
  materialize,
  readJsonlLines,
  DEFAULT_CONTEXT_INJECTION_LIMITS,
} from "./context-injection.ts";
import { parseWorkflowStateBlocks } from "./parse-workflow-state.ts";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Message shape used by the omp event system. */
export interface Message {
  role: string;
  customType?: string;
  content?: string;
  display?: boolean;
  timestamp?: number;
}

/** Context passed to event hooks. */
export interface HookContext {
  cwd: string;
  sessionManager?: { getSessionId?: () => string };
  ui?: { notify: (msg: string, level: string) => void };
}

/** Event payload for the `input` hook. */
export interface InputEvent {
  text?: string;
}

/** Event payload for the `context` hook. */
export interface ContextEvent {
  messages: Message[];
}

/** Event payload for the `tool_call` hook. */
export interface ToolCallEvent {
  toolName: string;
  input: { env?: Record<string, string> };
}

/** Return value for the `before_agent_start` hook. */
export interface BeforeAgentStartResult {
  message: { customType: string; content: string; display: boolean };
}

/** Return value for the `context` hook. */
export interface ContextResult {
  messages: Message[];
}

/** Extension API surface. */
export interface ExtensionAPI {
  on: (
    event: string,
    handler: (event: unknown, ctx: HookContext) => void | Promise<void>,
  ) => void;
  sendMessage: (msg: {
    customType: string;
    content: string;
    display: boolean;
  }) => Promise<void>;
}

const MYFLOW_AGENTS = new Set(["myflow-implement", "myflow-check", "myflow-research"]);

function detectAgentType(): AgentType {
  const blocked = process.env.PI_BLOCKED_AGENT;
  if (blocked && MYFLOW_AGENTS.has(blocked)) {
    return blocked as AgentType;
  }
  return null;
}

function deriveContextKey(ctx: HookContext): string | null {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  if (!sessionId) return null;
  return `myflow_session_${sessionId}`;
}

function resolveActiveTaskStatus(
  projectRoot: string,
  contextKey: string | null,
): { status: string; taskDir: string | null } {
  const tasksDir = join(projectRoot, ".myflow", "tasks");
  if (!existsSync(tasksDir)) return { status: "implement", taskDir: null };
  return { status: "implement", taskDir: null };
}

function buildSessionContext(
  projectRoot: string,
  contextKey: string | null,
): string {
  const workflowPath = join(projectRoot, ".myflow", "workflow.md");
  let workflowMd = "";
  try {
    workflowMd = readFileSync(workflowPath, "utf-8");
  } catch {
    return "";
  }
  const blocks = parseWorkflowStateBlocks(workflowMd);
  if (blocks.size === 0) return "";
  const parts: string[] = [];
  for (const [status, content] of blocks) {
    parts.push(`[workflow-state:${status}]\n${content}\n[/workflow-state:${status}]`);
  }
  return `<session-context>\n${parts.join("\n\n")}\n</session-context>`;
}

function getTaskContext(
  taskDir: string,
  projectRoot: string,
  agentType?: AgentType,
): string {
  const prdPath = join(taskDir, "prd.md");
  let prd = "";
  try {
    prd = readFileSync(prdPath, "utf-8");
  } catch {
    return "";
  }
  return `<task-context>\n### prd.md\n\n${prd}\n</task-context>`;
}

export default function extension(pi: ExtensionAPI): void {
  let projectRoot: string | null = null;
  const turnCache = new TurnContextCache();
  const agentType = detectAgentType();
  const isSubAgent = agentType !== null;
  let lastCompactionTs = 0;
  let lastInjectionTs = 0;

  pi.on("session_start", async (_event, ctx) => {
    projectRoot = findProjectRoot(ctx.cwd);
    const contextKey = deriveContextKey(ctx);
    if (!projectRoot) return;

    if (isSubAgent) {
      const { taskDir } = resolveActiveTaskStatus(projectRoot, contextKey);
      if (taskDir) {
        const taskCtx = getTaskContext(taskDir, projectRoot, agentType);
        if (taskCtx) await pi.sendMessage({ customType: "task-context", content: taskCtx, display: false });
      }
      return;
    }

    const sessionCtx = buildSessionContext(projectRoot, contextKey);
    if (sessionCtx) {
      await pi.sendMessage({ customType: "session-context", content: sessionCtx, display: false });
    }
  });

  pi.on("input", async (event, ctx) => {
    const inputEvent = event as InputEvent;
    if (!projectRoot) {
      projectRoot = findProjectRoot(ctx.cwd);
    }
    if (!projectRoot) return;

    const contextKey = deriveContextKey(ctx);
    const { taskDir } = resolveActiveTaskStatus(projectRoot, contextKey);
    if (!taskDir) return;

    const signature = taskContextSignature(projectRoot, taskDir, agentType);
    const taskCtx = getTaskContext(taskDir, projectRoot, agentType);
    if (taskCtx) {
      await pi.sendMessage({ customType: "task-context", content: taskCtx, display: false });
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!projectRoot) {
      projectRoot = findProjectRoot(ctx.cwd);
    }
    if (!projectRoot) return;

    const contextKey = deriveContextKey(ctx);
    const { status } = resolveActiveTaskStatus(projectRoot, contextKey);
    const workflowPath = join(projectRoot, ".myflow", "workflow.md");
    let workflowMd = "";
    try {
      workflowMd = readFileSync(workflowPath, "utf-8");
    } catch {
      return;
    }
    const blocks = parseWorkflowStateBlocks(workflowMd);
    const content = blocks.get(status) ?? "";
    if (!content) return;

    const result: BeforeAgentStartResult = {
      message: {
        customType: "workflow-state",
        content: `[workflow-state:${status}]\n${content}\n[/workflow-state:${status}]`,
        display: false,
      },
    };
    // The result is returned to the caller; in a real harness this would be
    // injected into the agent's system prompt.
  });

  pi.on("context", async (event, ctx) => {
    const contextEvent = event as ContextEvent;
    if (!projectRoot) {
      projectRoot = findProjectRoot(ctx.cwd);
    }
    if (!projectRoot) return;

    const contextKey = deriveContextKey(ctx);
    const { taskDir } = resolveActiveTaskStatus(projectRoot, contextKey);
    if (!taskDir) return;

    const inputPaths = taskContextInputPaths(projectRoot, taskDir, agentType);
    const budget = new ContextBudget(DEFAULT_CONTEXT_INJECTION_LIMITS.max_total_bytes);
    const messages: Message[] = [...contextEvent.messages];

    for (const filePath of inputPaths) {
      if (!existsSync(filePath)) continue;
      const displayPath = filePath.replace(projectRoot + "/", "");
      const materialized = materialize(
        filePath,
        displayPath,
        "context injection",
        DEFAULT_CONTEXT_INJECTION_LIMITS.max_file_bytes,
        "file",
      );
      if (materialized.block) {
        const emitted = budget.emit(materialized.block);
        if (emitted) {
          messages.push({
            role: "system",
            customType: "file-context",
            content: emitted,
            display: false,
          });
        }
      }
    }
  });

  pi.on("tool_call", async (event, _ctx) => {
    const toolEvent = event as ToolCallEvent;
    if (toolEvent.toolName !== "read") return;
    // In a real harness this would track file reads for context injection.
  });

  pi.on("compaction", async (_event, _ctx) => {
    lastCompactionTs = Date.now();
  });
}
