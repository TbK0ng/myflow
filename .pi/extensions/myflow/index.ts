import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isSafeWriteScope, isWithinWriteScope } from "./agents.ts";
import { findProjectRoot } from "./find-project-root.ts";
import { TurnContextCache, resolveActiveTaskStatus } from "./turn-cache.ts";
import { readPromptInjectionSkipKeyword, shouldSkipWorkflowState } from "./escape-hatch.ts";
import { type AgentType, buildTaskContext } from "./context-injection.ts";
import {
  MYFLOW_AGENT_ENV,
  MYFLOW_WRITES_UNDER_ENV,
  MYFLOW_VERIFY_GATE_ENV,
  registerMyflowSubagent,
  type SubagentPi,
} from "./subagent.ts";
import { buildStatusReport, formatStatusReport } from "./status.ts";
import { registerMyflowAsk } from "./ask.ts";
import { registerMyflowApproval } from "./approval.ts";
import {
  BG_TOOL_NAMES,
  backgroundDir,
  readEntry,
  registerMyflowBackground,
  resolveStatus,
  type BgPi,
} from "./background.ts";
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
/** Tools only the main session may call: they address the user directly. */
const ASK_TOOL_NAMES = new Set(["myflow_ask_user", "myflow_request_approval"]);
/** How much of a background command a shutdown notice shows. */
const SHUTDOWN_COMMAND_CHARS = 80;
const MAX_VERIFY_ATTEMPTS = 2;
/** Set for delegated processes (channel workers) that must not see the breadcrumb. */
export const SKIP_BREADCRUMB_ENV = "MYFLOW_SKIP_BREADCRUMB";

/** Tools whose target path is bounded by a declared `writesUnder` scope. */
const PATH_SCOPED_WRITE_TOOLS = new Set(["write", "edit"]);

/**
 * `normalizeWriterPath` / `isWithinWriteScope` moved to `./agents.ts` so
 * `background.ts` can run the same containment test for `cwd` (R5/ADR-9).
 * `background.ts` cannot import this module: `index.ts` already imports it, so
 * the reverse edge would be a cycle. These re-exports keep every existing
 * importer of `./index.ts` working unchanged.
 */
export { isWithinWriteScope, normalizeWriterPath } from "./agents.ts";

/**
 * Read the write target from a `write`/`edit` tool call.
 *
 * Pi's built-in `write` and `edit` schemas both name the target `path`
 * (`dist/core/tools/write.d.ts`, `edit.d.ts`). Anything else yields null, which
 * the guard treats as fail closed.
 */
export function getWriteTargetPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>).path;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Decide whether a scoped sub-agent's write/edit stays inside its declared
 * scope. Returns a block reason, or null when the write is allowed.
 *
 * Fail closed: a blank declaration, an unreadable target path, or no resolvable
 * active task all block instead of allowing.
 */
export function evaluateWriteScope(options: {
  declaredScope: string | undefined;
  path: string | null;
  taskDir: string | null;
  cwd: string;
}): string | null {
  const { declaredScope, path, taskDir, cwd } = options;
  const scope = declaredScope?.trim();
  if (!scope) {
    return "Write blocked: this sub-agent declares no `writesUnder` scope (fail closed).";
  }
  if (!isSafeWriteScope(scope)) {
    return (
      "Write blocked: the declared `writesUnder` scope must be a relative directory " +
      "under the active task (no `..`, no absolute path) (fail closed)."
    );
  }
  if (!path) {
    return "Write blocked: the write target path is missing or unreadable (fail closed).";
  }
  if (!taskDir) {
    return "Write blocked: no active myflow task resolves, so the write scope is unknown (fail closed).";
  }
  const scopeRoot = join(taskDir, scope);
  if (!isWithinWriteScope(path, scopeRoot, cwd)) {
    return (
      `Write blocked: ${path} is outside this sub-agent's write scope ` +
      `(<active task>/${scope}/). Scoped writers may only write there (one file per topic).`
    );
  }
  return null;
}

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

/**
 * Replace every custom message of one type with a single fresh copy, preserving
 * its position. Empty content removes the type entirely. Used for the two
 * session-scoped projections (`session-context`, `task-context`) so a refresh
 * cannot leave duplicates behind.
 */
function projectCustomMessage(messages: Message[], customType: string, content: string): Message[] {
  const replacement: Message | null = content
    ? { role: "custom", customType, content, display: false, timestamp: Date.now() }
    : null;
  let replaced = false;
  const projected = messages.flatMap((message) => {
    if (message.customType !== customType) return [message];
    if (replaced || !replacement) return [];
    replaced = true;
    return [replacement];
  });
  if (replacement && !replaced) projected.push(replacement);
  return projected;
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
  // Identity of the task snapshot the last session-context was built from
  // (`<taskDir>|<status>`). `session-context` is sent once at session_start;
  // when the active task is created, switched, archived, or changes phase, the
  // context hook refreshes it instead of leaving a stale "no_task" snapshot.
  let lastSessionSnapshot: string | null = null;
  let verifyAttempts = 0;
  // Background tasks this session started, by id. Ids only: the registry on
  // disk stays the source of truth and is read on demand — a session start
  // never scans `.myflow/.runtime/background/` (design.md §5).
  const startedBackgroundIds = new Set<string>();
  // `session_shutdown` can be reached more than once (cancel, reload, session
  // replacement, process exit), so the handler must run its body exactly once.
  let shutdownDone = false;

  // Native Pi sub-agent dispatch (single / parallel / chain). Registered in
  // both main sessions and sub-agents; the recursion guard below prevents a
  // sub-agent from dispatching more sub-agents.
  registerMyflowSubagent(pi as unknown as SubagentPi, {
    deriveContextKey: (ctx) => deriveContextKey((ctx ?? {}) as HookContext),
  });

  // Plan-approval gate tools. They resolve the active task through the injected
  // deriver and refuse to run in a sub-agent process (both checked in the
  // `tool_call` guard below as the second line).
  registerMyflowAsk(pi, {
    deriveContextKey: (ctx) => deriveContextKey((ctx ?? {}) as HookContext),
    isSubAgent,
  });
  registerMyflowApproval(pi, {
    deriveContextKey: (ctx) => deriveContextKey((ctx ?? {}) as HookContext),
    isSubAgent,
  });

  // Background-task tools. Registered in both main sessions and sub-agents so
  // the `tool_call` guard below can refuse a sub-agent explicitly (with a
  // reason) instead of the tool simply being absent; each tool's own
  // `execute` refuses too. `onStarted` is the session's own bookkeeping, used
  // only by the shutdown notice — the project registry is never scanned here.
  registerMyflowBackground(pi as unknown as BgPi, {
    deriveContextKey: (ctx) => deriveContextKey((ctx ?? {}) as HookContext),
    isSubAgent,
    onStarted: (id) => startedBackgroundIds.add(id),
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

    const { taskDir, status } = resolveActiveTaskStatus(projectRoot, contextKey);
    lastSessionSnapshot = `${taskDir ?? ""}|${status}`;
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
    const { taskDir, status } = resolveActiveTaskStatus(projectRoot, contextKey);
    const currentTaskContext = taskDir ? getTaskContext(taskDir, projectRoot, agentType) : "";
    const sessionSnapshot = `${taskDir ?? ""}|${status}`;
    // Sub-agents get only the task context (session_start returns before the
    // session-context injection); do not project it into their requests.
    const sessionContextChanged = !isSubAgent && sessionSnapshot !== lastSessionSnapshot;
    const currentSessionContext = sessionContextChanged
      ? buildSessionContext(projectRoot, contextKey)
      : "";
    if (sessionContextChanged) lastSessionSnapshot = sessionSnapshot;

    const taskContextIndexes = messages
      .map((message, index) => (message.customType === "task-context" ? index : -1))
      .filter((index) => index >= 0);
    const existingTaskContext =
      taskContextIndexes.length > 0 ? (messages[taskContextIndexes[0]]?.content ?? "") : "";
    const taskContextChanged =
      existingTaskContext !== currentTaskContext || taskContextIndexes.length > 1;

    let projectedMessages = messages;
    if (taskContextChanged) {
      projectedMessages = projectCustomMessage(projectedMessages, "task-context", currentTaskContext);
    }
    if (sessionContextChanged) {
      projectedMessages = projectCustomMessage(projectedMessages, "session-context", currentSessionContext);
    }

    const cached = turnCache.get(projectRoot, contextKey);
    const skipping = !cached.workflowMsg;

    if (!taskContextChanged && !sessionContextChanged && !skipping && lastInjectionTs > lastCompactionTs) return;

    if (skipping) {
      const withoutBreadcrumb = projectedMessages.filter(
        (message) => !(message.role === "custom" && message.customType === "workflow-state"),
      );
      if (
        withoutBreadcrumb.length === projectedMessages.length &&
        !taskContextChanged &&
        !sessionContextChanged
      ) {
        return;
      }
      lastInjectionTs = Date.now();
      return { messages: withoutBreadcrumb };
    }

    for (let i = projectedMessages.length - 1; i >= 0; i -= 1) {
      if (
        projectedMessages[i].role === "custom" &&
        projectedMessages[i].customType === "workflow-state"
      ) {
        lastInjectionTs = Date.now();
        return taskContextChanged || sessionContextChanged ? { messages: projectedMessages } : undefined;
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

    // Recursion guard: only the main session may dispatch sub-agents.
    if (toolEvent.toolName === SUBAGENT_TOOL_NAME) {
      if (!isSubAgent) return;
      return {
        block: true,
        reason:
          `Recursion guard: this process is the sub-agent "${agentType}" and must not ` +
          `dispatch ${SUBAGENT_TOOL_NAME}. Report the recommended next step to the main session instead.`,
      };
    }

    // Ask/approval guard: only the main session may address the user. A
    // sub-agent runs non-interactively and must not express the user's intent
    // on their behalf; this mirrors the recursion guard and is the second line
    // after each tool's own `execute` check.
    if (ASK_TOOL_NAMES.has(toolEvent.toolName) && isSubAgent) {
      return {
        block: true,
        reason:
          `Only the main session may ask the user a question or request plan approval. ` +
          `This process is the sub-agent "${agentType}" and must not address the user; ` +
          `report the recommendation to the main session instead.`,
      };
    }

    // Background guard: only the main session may manage background tasks. A
    // sub-agent runs non-interactively and registers its work in the shared,
    // project-wide registry, where it would outlive the child and belong to
    // nobody; this is the second line after each tool's own `execute` check.
    if (BG_TOOL_NAMES.has(toolEvent.toolName) && isSubAgent) {
      return {
        block: true,
        reason:
          `Only the main session may manage background tasks. This process is the sub-agent ` +
          `"${agentType}"; background tasks register in the shared project registry and ` +
          `outlive the process, so a sub-agent must not create or control them. ` +
          `Report the recommendation to the main session instead.`,
      };
    }

    // Path guard: a sub-agent that declared `writesUnder` may only write inside
    // `<active task>/<writesUnder>/`. An agent with no declaration (implement,
    // check) is the serial writer `subagent.ts` already keeps out of parallel
    // mode, so it keeps full-tree access — do not break it. A *declared* scope
    // fails closed on every ambiguity.
    if (!isSubAgent || !PATH_SCOPED_WRITE_TOOLS.has(toolEvent.toolName)) return;
    const declaredScope = process.env[MYFLOW_WRITES_UNDER_ENV];
    if (declaredScope === undefined) return;

    const root = projectRoot ?? findProjectRoot(ctx.cwd) ?? ctx.cwd;
    const { taskDir } = resolveActiveTaskStatus(root, deriveContextKey(ctx));
    const reason = evaluateWriteScope({
      declaredScope,
      path: getWriteTargetPath(toolEvent.input),
      taskDir,
      cwd: ctx.cwd,
    });
    if (reason) return { block: true, reason };
    return;
  });

  pi.on("session_before_compact", async (_event, _ctx) => {
    lastCompactionTs = Date.now();
  });

  /**
   * The session is going away.
   *
   * Background tasks are **project-level**, not session-level (PRD Q1: the
   * whole point is that a task survives the session). So this handler
   * deliberately kills nothing: no `terminateTree`, no `taskkill`, no
   * `process.kill`. What it does instead is (a) release this session's own
   * resources and (b) tell the user which tasks this session started that are
   * still running, so a leftover process is never invisible.
   *
   * Session-scoped resources: this extension holds **no timer and no child
   * handle**. `myflow_bg_start` spawns the wrapper detached and immediately
   * `unref()`s it, and the read/wait loops in `myflow_bg_output` are per-call
   * and finish before the tool returns. The only session state is the id set
   * below, which dies with the session object; there is nothing else to
   * release.
   *
   * Idempotent by contract (`docs/extensions.md`: cancellation, reload,
   * session replacement and process exit all converge here): a second call
   * returns immediately, and nothing thrown ever escapes — a shutdown hook
   * that throws can block or corrupt the exit.
   */
  pi.on("session_shutdown", async (_event, ctx) => {
    // Claim the run before doing anything: cancellation, reload, session
    // replacement and process exit all converge here, and this body must run
    // exactly once. Claiming first makes a second call a no-op even if the
    // first one throws halfway.
    if (shutdownDone) return;
    shutdownDone = true;
    try {
      const root = projectRoot ?? findProjectRoot(ctx.cwd) ?? ctx.cwd;
      const dir = backgroundDir(root);
      const running: Array<{ id: string; command: string }> = [];

      for (const id of startedBackgroundIds) {
        try {
          const entry = readEntry(dir, id);
          if (!entry) continue;
          // Same precedence the tools use: a `.exit` record outranks pid
          // liveness, so a finished task is never reported as running.
          if (resolveStatus(dir, entry).status !== "running") continue;
          running.push({ id, command: entry.command });
        } catch {
          // One unreadable entry must not silence the others.
        }
      }

      // No UI means no one to notify: skip silently rather than log. The
      // predicate is an explicit `hasUI === false`, not "is a notify function
      // present": a headless host may still hand us `ui.notify` (it becomes a
      // no-op or lands in a log nobody reads), so presence alone does not prove
      // an audience. `hasUI` on the adapter's own `HookContext` is optional and
      // an older host/stub that omits it is read as "has UI" — only an explicit
      // `false` silences the notice.
      const ui = ctx.ui;
      const hasUI = (ctx as { hasUI?: boolean }).hasUI !== false;
      if (running.length > 0 && hasUI && ui && typeof ui.notify === "function") {
        const lines = running.map(({ id, command }) => {
          const shown =
            command.length > SHUTDOWN_COMMAND_CHARS
              ? `${command.slice(0, SHUTDOWN_COMMAND_CHARS)}...`
              : command;
          return `  ${id}  ${shown}`;
        });
        ui.notify(
          [
            `${running.length} background task(s) started by this session are still running:`,
            ...lines,
            "They outlive this session on purpose. Read one with myflow_bg_output, stop one with myflow_bg_stop.",
          ].join("\n"),
          "warning",
        );
      }

      // The id set is deliberately NOT cleared here. It is the only session
      // state this extension owns (no timer, no child handle), it dies with the
      // session object, and keeping it is what makes `shutdownDone` — not a
      // side effect of clearing — the thing that guarantees one run per
      // session. Clearing it would make the flag unobservable and untestable.
    } catch {
      // A shutdown hook that throws can block or corrupt the exit.
    }
  });

  // Verify gate: a check sub-agent does not settle while the configured verify
  // commands fail. Mirrors the "block the checker until verification passes"
  // loop, bounded so a broken command cannot loop forever. Channel review
  // workers carry no agent type, so their launcher flags them with
  // MYFLOW_VERIFY_GATE instead — otherwise a peer check would skip the gate.
  pi.on("agent_before_settle", async (event, ctx) => {
    if (!projectRoot) {
      projectRoot = findProjectRoot(ctx.cwd);
    }
    if (!projectRoot) return;
    const flagged = process.env[MYFLOW_VERIFY_GATE_ENV] === "1";
    if (agentType !== "myflow-check" && !flagged) return;

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
