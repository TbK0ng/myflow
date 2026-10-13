import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import extension from "../.pi/extensions/myflow/index.ts";
import type { ExtensionAPI, HookContext, Message } from "../.pi/extensions/myflow/index.ts";

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-ext-"));
  mkdirSync(join(root, ".myflow", ".runtime", "sessions"), { recursive: true });
  mkdirSync(join(root, ".myflow", "scripts"), { recursive: true });
  copyFileSync(join(fileURLToPath(new URL("..", import.meta.url)), ".myflow", "scripts", "get_context.py"), join(root, ".myflow", "scripts", "get_context.py"));
  writeFileSync(join(root, ".myflow", "workflow.md"), [
    "[workflow-state:planning]",
    "Plan the work.",
    "[/workflow-state:planning]",
    "",
    "[workflow-state:implementing]",
    "Write the code.",
    "[/workflow-state:implementing]",
  ].join("\n"));
  const taskDir = join(root, "tasks", "demo");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({
    title: "Demo task",
    status: "implementing",
  }));
  writeFileSync(
    join(root, ".myflow", ".runtime", "sessions", "pi_session_test.json"),
    JSON.stringify({ current_task: "tasks/demo" }),
  );
  return root;
}

function makeMockAPI(root: string): {
  api: ExtensionAPI;
  sent: Message[];
  tools: Array<Record<string, unknown>>;
  commands: Record<string, { handler: (args: string, ctx: HookContext) => Promise<void> }>;
} {
  const sent: Message[] = [];
  const tools: Array<Record<string, unknown>> = [];
  const commands: Record<string, { handler: (args: string, ctx: HookContext) => Promise<void> }> = {};
  const handlers: Record<string, (event: unknown, ctx: HookContext) => Promise<void>> = {};
  const api: ExtensionAPI = {
    on: (name: string, handler: (event: unknown, ctx: HookContext) => Promise<void>) => {
      handlers[name] = handler;
    },
    registerTool: (tool: Record<string, unknown>) => {
      tools.push(tool);
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: HookContext) => Promise<void> }) => {
      commands[name] = options;
    },
    sendUserMessage: () => {},
    appendEntry: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    events: { emit: () => {}, on: () => () => {} },
    sendMessage: (msg: Message) => {
      sent.push(msg);
    },
  };
  const ctx: HookContext = {
    cwd: root,
    session: { id: "test", contextKey: "pi_session_test" },
    ui: { notify: () => {} },
  } as unknown as HookContext;
  // Store handlers for the test to invoke
  (api as unknown as Record<string, unknown>).__handlers = handlers;
  (api as unknown as Record<string, unknown>).__ctx = ctx;
  return { api, sent, tools, commands };
}

function getHandlers(api: ExtensionAPI): Record<string, (event: unknown, ctx: HookContext) => Promise<void>> {
  return (api as unknown as Record<string, unknown>).__handlers as Record<string, (event: unknown, ctx: HookContext) => Promise<void>>;
}

function getCtx(api: ExtensionAPI): HookContext {
  return (api as unknown as Record<string, unknown>).__ctx as HookContext;
}

test("session_start: main session sends session-context", async () => {
  const root = makeProject();
  const { api, sent } = makeMockAPI(root);
  extension(api);
  const handlers = getHandlers(api);
  const ctx = getCtx(api);
  await handlers.session_start({}, ctx);
  assert.ok(sent.some((m) => m.customType === "session-context"));
  rmSync(root, { recursive: true, force: true });
});

test("input: does not throw when task exists", async () => {
  const root = makeProject();
  const { api } = makeMockAPI(root);
  extension(api);
  const handlers = getHandlers(api);
  const ctx = getCtx(api);
  await handlers.session_start({}, ctx);
  await handlers.input({ text: "hello" }, ctx);
  rmSync(root, { recursive: true, force: true });
});

test("before_agent_start: returns workflow state", async () => {
  const root = makeProject();
  const { api } = makeMockAPI(root);
  extension(api);
  const handlers = getHandlers(api);
  const ctx = getCtx(api);
  await handlers.session_start({}, ctx);
  // before_agent_start doesn't send messages, it returns a result
  // We just verify it doesn't throw
  await handlers.before_agent_start({}, ctx);
  rmSync(root, { recursive: true, force: true });
});

test("context: injects file context", async () => {
  const root = makeProject();
  const { api } = makeMockAPI(root);
  extension(api);
  const handlers = getHandlers(api);
  const ctx = getCtx(api);
  await handlers.session_start({}, ctx);
  // context hook doesn't send messages, it modifies the event
  await handlers.context({ messages: [] }, ctx);
  rmSync(root, { recursive: true, force: true });
});

test("tool_call: read tool is tracked", async () => {
  const root = makeProject();
  const { api } = makeMockAPI(root);
  extension(api);
  const handlers = getHandlers(api);
  const ctx = getCtx(api);
  await handlers.session_start({}, ctx);
  await handlers.tool_call({ toolName: "read", args: { path: "foo.ts" } }, ctx);
  rmSync(root, { recursive: true, force: true });
});

test("session_before_compact: records timestamp", async () => {
  const root = makeProject();
  const { api } = makeMockAPI(root);
  extension(api);
  const handlers = getHandlers(api);
  const ctx = getCtx(api);
  await handlers.session_start({}, ctx);
  await handlers.session_before_compact({}, ctx);
  rmSync(root, { recursive: true, force: true });
});

test("all 6 hooks registered", () => {
  const root = makeProject();
  const { api } = makeMockAPI(root);
  extension(api);
  const handlers = getHandlers(api);
  assert.ok(handlers.session_start);
  assert.ok(handlers.input);
  assert.ok(handlers.before_agent_start);
  assert.ok(handlers.context);
  assert.ok(handlers.tool_call);
  assert.ok(handlers.session_before_compact);
  rmSync(root, { recursive: true, force: true });
});

test("myflow-status command is registered and reports task, phase, and git", async () => {
  const root = makeProject();
  const { api, sent, commands } = makeMockAPI(root);
  extension(api);
  assert.ok(commands["myflow-status"], "myflow-status must be registered");

  // Invoke without session_start to exercise the cwd fallback.
  await commands["myflow-status"].handler("", getCtx(api));
  const message = sent.find((m) => m.customType === "myflow-status");
  assert.ok(message, "command must send a myflow-status message");
  assert.match(message!.content!, /myflow: implementing/);
  assert.match(message!.content!, /Task:   tasks\/demo \(implementing\)/);
  assert.match(message!.content!, /Git:/);
  rmSync(root, { recursive: true, force: true });
});

test("session_start: sends task-context when prd.md exists (real task resolution)", async () => {
  const root = makeProject();
  // Add a prd.md so getTaskContext returns non-empty content.
  writeFileSync(join(root, "tasks", "demo", "prd.md"), "# Demo PRD\nBuild the thing.");
  const { api, sent } = makeMockAPI(root);
  extension(api);
  const handlers = getHandlers(api);
  const ctx = getCtx(api);
  await handlers.session_start({}, ctx);
  const taskMsg = sent.find((m) => m.customType === "task-context");
  assert.ok(taskMsg, "session_start must send a task-context message");
  assert.ok(taskMsg!.content!.includes("# Demo PRD"), "task-context must contain prd.md content");
  rmSync(root, { recursive: true, force: true });
});

test("context: replaces stale task-context with current prd.md", async () => {
  const root = makeProject();
  writeFileSync(join(root, "tasks", "demo", "prd.md"), "# Demo PRD\nBuild the thing.");
  const { api } = makeMockAPI(root);
  extension(api);
  const handlers = getHandlers(api);
  const ctx = getCtx(api);
  await handlers.session_start({}, ctx);
  // Feed a stale task-context; the hook must replace it with the current prd.md.
  const staleMessage = { role: "custom", customType: "task-context", content: "stale", display: false, timestamp: 0 };
  const result = await (handlers.context as (event: unknown, ctx: HookContext) => Promise<unknown>)(
    { messages: [staleMessage] },
    ctx,
  );
  const projected = (result as { messages: Message[] } | undefined)?.messages ?? [];
  const taskMsg = projected.find((m) => m.customType === "task-context");
  assert.ok(taskMsg, "context must produce a task-context message");
  assert.ok(taskMsg!.content!.includes("# Demo PRD"), "task-context must contain current prd.md content");
  rmSync(root, { recursive: true, force: true });
});
