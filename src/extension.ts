import { findProjectRoot } from "./find-project-root.ts";
import { TurnContextCache, resolveActiveTaskStatus } from "./turn-cache.ts";
import { readPromptInjectionSkipKeyword, shouldSkipWorkflowState } from "./escape-hatch.ts";
import { type AgentType, buildTaskContext } from "./context-injection.ts";
import { parseWorkflowStateBlocks } from "./parse-workflow-state.ts";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
export type { ExtensionAPI };

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


function buildSessionContext(
  projectRoot: string,
  contextKey: string | null,
): string {
  const scriptPath = join(projectRoot, ".myflow", "scripts", "get_context.py");
  if (!existsSync(scriptPath)) return "";
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (contextKey) env.MYFLOW_CONTEXT_ID = contextKey;
  try {
    const output = execFileSync("python3", [scriptPath], {
      cwd: projectRoot,
      env,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const trimmed = output.trim();
    if (!trimmed) return "";
    return `<session-context>\n${trimmed}\n</session-context>`;
  } catch {
    return "";
  }
}

function getTaskContext(
  taskDir: string,
  projectRoot: string,
  agentType?: AgentType,
): string {
  return buildTaskContext(projectRoot, taskDir, agentType);
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

    const { taskDir } = resolveActiveTaskStatus(projectRoot, contextKey);
    if (taskDir) {
      const taskCtx = getTaskContext(taskDir, projectRoot, agentType);
      if (taskCtx) await pi.sendMessage({ customType: "task-context", content: taskCtx, display: false });
    }

    ctx.ui?.notify("myflow workflow system available", "info");
  });

  pi.on("input", async (event, ctx) => {
    const inputEvent = event as InputEvent;
    if (!projectRoot) {
      projectRoot = findProjectRoot(ctx.cwd);
    }
    if (!projectRoot) return;

    const contextKey = deriveContextKey(ctx);
    const skipKeyword = readPromptInjectionSkipKeyword(projectRoot);
    const skipThisTurn = shouldSkipWorkflowState(inputEvent.text ?? "", skipKeyword);
    turnCache.beginTurn(skipThisTurn);
    turnCache.get(projectRoot, contextKey);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!projectRoot) {
      projectRoot = findProjectRoot(ctx.cwd);
    }
    if (!projectRoot) return;

    const contextKey = deriveContextKey(ctx);
    const cached = turnCache.get(projectRoot, contextKey);
    lastInjectionTs = Date.now();

    if (!cached.workflowMsg) return;

    return {
      message: {
        customType: "workflow-state",
        content: cached.workflowMsg,
        display: false,
      },
    };
  });

  pi.on("context", async (event, ctx) => {
    const contextEvent = event as ContextEvent;
    if (!projectRoot) {
      projectRoot = findProjectRoot(ctx.cwd);
    }
    if (!projectRoot) return;

    const contextKey = deriveContextKey(ctx);
    const messages = contextEvent.messages as Message[];
    const { taskDir } = resolveActiveTaskStatus(projectRoot, contextKey);
    const currentTaskContext = taskDir ? getTaskContext(taskDir, projectRoot, agentType) : "";

    const taskContextIndexes = messages
      .map((message, index) => (message.customType === "task-context" ? index : -1))
      .filter((index) => index >= 0);
    const existingTaskContext =
      taskContextIndexes.length > 0 ? (messages[taskContextIndexes[0]]?.content ?? "") : "";
    const taskContextChanged =
      existingTaskContext !== currentTaskContext || taskContextIndexes.length > 1;

    let projectedMessages = messages;
    if (taskContextChanged) {
      const replacement = currentTaskContext
        ? {
            role: "custom",
            customType: "task-context",
            content: currentTaskContext,
            display: false,
            timestamp: Date.now(),
          }
        : null;
      let replaced = false;
      projectedMessages = messages.flatMap((message) => {
        if (message.customType !== "task-context") return [message];
        if (replaced || !replacement) return [];
        replaced = true;
        return [replacement];
      });
      if (replacement && !replaced) projectedMessages.push(replacement);
    }

    const cached = turnCache.get(projectRoot, contextKey);
    const skipping = !cached.workflowMsg;

    if (!taskContextChanged && !skipping && lastInjectionTs > lastCompactionTs) return;

    if (skipping) {
      const withoutBreadcrumb = projectedMessages.filter(
        (message) => !(message.role === "custom" && message.customType === "workflow-state"),
      );
      if (withoutBreadcrumb.length === projectedMessages.length && !taskContextChanged) return;
      lastInjectionTs = Date.now();
      return { messages: withoutBreadcrumb };
    }

    for (let i = projectedMessages.length - 1; i >= 0; i--) {
      if (
        projectedMessages[i].role === "custom" &&
        projectedMessages[i].customType === "workflow-state"
      ) {
        lastInjectionTs = Date.now();
        return taskContextChanged ? { messages: projectedMessages } : undefined;
      }
    }

    lastInjectionTs = Date.now();
    return {
      messages: [
        ...projectedMessages,
        {
          role: "custom",
          customType: "workflow-state",
          content: cached.workflowMsg,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolEvent = event as ToolCallEvent;
    if (toolEvent.toolName !== "bash") return;
    const contextKey = deriveContextKey(ctx);
    if (!contextKey) return;
    const input = toolEvent.input as { env?: Record<string, string> };
    input.env = {
      MYFLOW_CONTEXT_ID: contextKey,
      ...input.env,
    };
  });

  pi.on("session_before_compact", async (_event, _ctx) => {
    lastCompactionTs = Date.now();
  });
}
