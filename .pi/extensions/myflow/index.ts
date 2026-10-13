import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { findProjectRoot } from "./find-project-root.ts";
import { TurnContextCache, resolveActiveTaskStatus } from "./turn-cache.ts";
import { readPromptInjectionSkipKeyword, shouldSkipWorkflowState } from "./escape-hatch.ts";
import { type AgentType, buildTaskContext } from "./context-injection.ts";
import {
  MYFLOW_AGENT_ENV,
  registerMyflowSubagent,
  type SubagentPi,
} from "./subagent.ts";
import { buildStatusReport, formatStatusReport } from "./status.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export type { ExtensionAPI };

/**
 * Platform name used when building myflow context keys. Every session file in
 * `.myflow/.runtime/sessions/` on this harness is named `<platform>_*.json`.
 */
export const PLATFORM_NAME = "pi";

/** Message shape used by the Pi event system. */
export interface Message {
  role: string;
  customType?: string;
  content?: string;
  display?: boolean;
  timestamp?: number;
}

/** Context passed to event hooks (subset of Pi's `ExtensionContext`). */
export interface HookContext {
  cwd: string;
  sessionManager?: {
    getSessionId?: () => string | undefined;
    getSessionFile?: () => string | undefined;
  };
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  ui?: { notify: (msg: string, level?: string) => void };
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
  input?: Record<string, unknown>;
}

const SUBAGENT_TOOL_NAME = "myflow_subagent";
const MAX_VERIFY_ATTEMPTS = 2;
/** Set for delegated processes (channel workers) that must not see the breadcrumb. */
export const SKIP_BREADCRUMB_ENV = "MYFLOW_SKIP_BREADCRUMB";

/**
 * Detect whether the current process is a sub-agent.
 *
 * `myflow_subagent` sets `MYFLOW_AGENT_TYPE` to the dispatched agent's name
 * when it spawns a child `pi`. Any name counts, so custom agents under
 * `.pi/agents/` count exactly like the ones shipped here.
 */
export function detectAgentType(env: NodeJS.ProcessEnv = process.env): AgentType {
  const declared = env[MYFLOW_AGENT_ENV]?.trim();
  return declared ? declared : null;
}

export function sanitizeKey(raw: string): string {
  const safe = raw.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "");
  return safe ? safe.slice(0, 160) : "";
}

export function hashValue(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

export function buildContextKey(platformName: string, kind: string, value: string): string {
  if (kind === "transcript") {
    return `${platformName}_transcript_${hashValue(value)}`;
  }
  const safeValue = sanitizeKey(value);
  return safeValue ? `${platformName}_${safeValue}` : `${platformName}_${hashValue(value)}`;
}

export function deriveContextKey(ctx: HookContext): string | null {
  // An explicit override wins so a dispatched sub-agent resolves the parent
  // session's active task instead of its own isolated session file.
  const override = process.env.MYFLOW_CONTEXT_ID?.trim();
  if (override) return sanitizeKey(override) || hashValue(override);

  const sessionId = ctx.sessionManager?.getSessionId?.();
  if (sessionId) {
    return buildContextKey(PLATFORM_NAME, "session", sessionId);
  }
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (sessionFile) {
    return buildContextKey(PLATFORM_NAME, "transcript", sessionFile);
  }
  return null;
}

function buildSessionContext(projectRoot: string, contextKey: string | null): string {
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

function getTaskContext(taskDir: string, projectRoot: string, agentType?: AgentType): string {
  return buildTaskContext(projectRoot, taskDir, agentType);
}

function runVerifyCommands(projectRoot: string): string | null {
  const script = join(projectRoot, ".myflow", "scripts", "worktree.py");
  if (!existsSync(script)) return null;
  try {
    execFileSync("python3", [script, "verify"], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 300_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return null;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim() || "verify failed";
  }
}

export default function extension(pi: ExtensionAPI): void {
  let projectRoot: string | null = null;
  const turnCache = new TurnContextCache();
  const agentType = detectAgentType();
  const isSubAgent = agentType !== null;
  let lastCompactionTs = 0;
  let lastInjectionTs = 0;
  let verifyAttempts = 0;

  // Native Pi sub-agent dispatch (single / parallel / chain). Registered in
  // both main sessions and sub-agents; the recursion guard below prevents a
  // sub-agent from dispatching more sub-agents.
  registerMyflowSubagent(pi as unknown as SubagentPi, {
    deriveContextKey: (ctx) => deriveContextKey((ctx ?? {}) as HookContext),
  });

  // `/myflow-status` answers "where am I?" without a model call.
  pi.registerCommand("myflow-status", {
    description: "Show the active myflow task, workflow phase, and git state",
    handler: async (_args: string, ctx: HookContext & { mode?: string; hasUI?: boolean }) => {
      const root = projectRoot ?? findProjectRoot(ctx.cwd) ?? ctx.cwd;
      const contextKey = deriveContextKey(ctx);
      const text = formatStatusReport(buildStatusReport(root, contextKey));
      if (ctx.mode === "print") {
        // Pi routes extension console output to stderr in print mode and keeps
        // stdout for the model's answer, so this stays visible without
        // corrupting a piped answer. Never use console in json mode, where
        // stdout is a JSONL event stream.
        console.log(text);
      } else {
        pi.sendMessage({ customType: "myflow-status", content: text, display: true });
      }
      if (ctx.hasUI) ctx.ui?.notify(text.split("\n")[0] ?? "myflow status", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    projectRoot = findProjectRoot(ctx.cwd);
    verifyAttempts = 0;
    const contextKey = deriveContextKey(ctx);
    if (!projectRoot) return;

    if (isSubAgent) {
      const { taskDir } = resolveActiveTaskStatus(projectRoot, contextKey);
      if (taskDir) {
        const taskCtx = getTaskContext(taskDir, projectRoot, agentType);
        if (taskCtx) pi.sendMessage({ customType: "task-context", content: taskCtx, display: false });
      }
      return;
    }

    const sessionCtx = buildSessionContext(projectRoot, contextKey);
    if (sessionCtx) {
      pi.sendMessage({ customType: "session-context", content: sessionCtx, display: false });
    }

    const { taskDir } = resolveActiveTaskStatus(projectRoot, contextKey);
    if (taskDir) {
      const taskCtx = getTaskContext(taskDir, projectRoot, agentType);
      if (taskCtx) pi.sendMessage({ customType: "task-context", content: taskCtx, display: false });
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
    // Delegated processes (channel workers) run with this set: their input is a
    // work order, not a user turn, so the per-turn breadcrumb would derail them.
    const skipThisTurn =
      process.env[SKIP_BREADCRUMB_ENV] === "1" || shouldSkipWorkflowState(inputEvent.text ?? "", skipKeyword);
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

    for (let i = projectedMessages.length - 1; i >= 0; i -= 1) {
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

  pi.on("tool_call", async (event, _ctx) => {
    const toolEvent = event as ToolCallEvent;
    if (toolEvent.toolName !== SUBAGENT_TOOL_NAME) return;
    if (!isSubAgent) return;
    // Recursion guard: only the main session may dispatch sub-agents.
    return {
      block: true,
      reason:
        `Recursion guard: this process is the sub-agent "${agentType}" and must not ` +
        `dispatch ${SUBAGENT_TOOL_NAME}. Report the recommended next step to the main session instead.`,
    };
  });

  pi.on("session_before_compact", async (_event, _ctx) => {
    lastCompactionTs = Date.now();
  });

  // Verify gate: a check sub-agent does not settle while the configured verify
  // commands fail. Mirrors the "block the checker until verification passes"
  // loop, bounded so a broken command cannot loop forever.
  pi.on("agent_before_settle", async (event, ctx) => {
    if (!projectRoot) {
      projectRoot = findProjectRoot(ctx.cwd);
    }
    if (!projectRoot) return;
    if (agentType !== "myflow-check") return;

    const settle = event as { outcome?: string };
    if (settle.outcome && settle.outcome !== "completed") return;
    if (verifyAttempts >= MAX_VERIFY_ATTEMPTS) return;

    const failure = runVerifyCommands(projectRoot);
    if (!failure) return;

    verifyAttempts += 1;
    return {
      continue: true,
      entries: [
        {
          type: "custom_message",
          customType: "verify-gate",
          content:
            `<verify-gate attempt="${verifyAttempts}/${MAX_VERIFY_ATTEMPTS}">\n` +
            "The configured verify commands did not pass. Fix the failures before finishing.\n\n" +
            `${failure}\n</verify-gate>`,
          display: false,
        },
      ],
    };
  });
}
