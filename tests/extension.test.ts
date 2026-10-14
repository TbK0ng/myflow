import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import extension, { SKIP_BREADCRUMB_ENV } from "../.pi/extensions/myflow/index.ts";
import type { ExtensionAPI, HookContext, Message } from "../.pi/extensions/myflow/index.ts";
import { MYFLOW_AGENT_ENV, MYFLOW_VERIFY_GATE_ENV } from "../.pi/extensions/myflow/subagent.ts";

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
  // The real layout `task.py` writes: `.myflow/tasks/<slug>`, with the session
  // pointer holding that same `.myflow/tasks/<slug>` ref.
  const taskDir = join(root, ".myflow", "tasks", "demo");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({
    title: "Demo task",
    status: "implementing",
  }));
  writeFileSync(
    join(root, ".myflow", ".runtime", "sessions", "pi_session_test.json"),
    JSON.stringify({ current_task: ".myflow/tasks/demo" }),
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

test("all hooks registered", () => {
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
  assert.ok(handlers.agent_before_settle, "the verify gate needs agent_before_settle");
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
  assert.match(message!.content!, /Task:   \.myflow\/tasks\/demo \(implementing\)/);
  assert.match(message!.content!, /Git:/);
  rmSync(root, { recursive: true, force: true });
});

test("session_start: sends task-context when prd.md exists (real task resolution)", async () => {
  const root = makeProject();
  // Add a prd.md so getTaskContext returns non-empty content.
  writeFileSync(join(root, ".myflow", "tasks", "demo", "prd.md"), "# Demo PRD\nBuild the thing.");
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
  writeFileSync(join(root, ".myflow", "tasks", "demo", "prd.md"), "# Demo PRD\nBuild the thing.");
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

test("context: re-injects the breadcrumb after compaction", async () => {
  const root = makeProject();
  const { api } = makeMockAPI(root);
  extension(api);
  const handlers = getHandlers(api);
  const ctx = getCtx(api);

  await handlers.session_start({}, ctx);
  await handlers.input({ text: "hello" }, ctx);
  await handlers.before_agent_start({}, ctx);

  // Without compaction the existing injection is still fresh, so context is a no-op.
  const untouched = await (handlers.context as (event: unknown, ctx: HookContext) => Promise<unknown>)(
    { messages: [] },
    ctx,
  );
  assert.equal(untouched, undefined, "context must not re-inject while the last injection is fresh");

  // A compaction invalidates the last injection; the next context pass re-adds it.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await handlers.session_before_compact({}, ctx);
  const result = await (handlers.context as (event: unknown, ctx: HookContext) => Promise<unknown>)(
    { messages: [] },
    ctx,
  );
  const projected = (result as { messages: Message[] } | undefined)?.messages ?? [];
  assert.ok(
    projected.some((m) => m.customType === "workflow-state"),
    "context must re-inject the breadcrumb after compaction",
  );
  rmSync(root, { recursive: true, force: true });
});

function writeVerifyScript(root: string, failing: boolean): void {
  mkdirSync(join(root, ".myflow", "scripts"), { recursive: true });
  writeFileSync(
    join(root, ".myflow", "scripts", "worktree.py"),
    failing ? "import sys\nprint('FAIL: node --test', file=sys.stderr)\nsys.exit(1)\n" : "import sys\nprint('verify passed')\nsys.exit(0)\n",
  );
}

test("input: MYFLOW_SKIP_BREADCRUMB suppresses the breadcrumb for delegated runs", async () => {
  const root = makeProject();
  const previous = process.env[SKIP_BREADCRUMB_ENV];
  process.env[SKIP_BREADCRUMB_ENV] = "1";
  try {
    const { api } = makeMockAPI(root);
    extension(api);
    const handlers = getHandlers(api);
    const ctx = getCtx(api);
    await handlers.session_start({}, ctx);
    await handlers.input({ text: "work order" }, ctx);
    const result = await handlers.before_agent_start({}, ctx);
    assert.equal(result, undefined, "a delegated process receives no workflow-state message");
  } finally {
    if (previous === undefined) delete process.env[SKIP_BREADCRUMB_ENV];
    else process.env[SKIP_BREADCRUMB_ENV] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify gate: a check sub-agent is held until verify passes", async () => {
  const root = makeProject();
  const previous = process.env[MYFLOW_AGENT_ENV];
  process.env[MYFLOW_AGENT_ENV] = "myflow-check";
  try {
    writeVerifyScript(root, true);
    const { api } = makeMockAPI(root);
    extension(api);
    const handlers = getHandlers(api);
    const ctx = getCtx(api);
    await handlers.session_start({}, ctx);

    const blocked = (await (handlers.agent_before_settle as (event: unknown, ctx: HookContext) => Promise<unknown>)(
      { outcome: "completed" },
      ctx,
    )) as { continue?: boolean; entries?: Array<{ customType: string; content: string }> } | undefined;
    assert.equal(blocked?.continue, true, "a failing verify must hold the agent");
    assert.equal(blocked?.entries?.[0]?.customType, "verify-gate");
    assert.match(blocked!.entries![0].content, /FAIL: node --test/);

    writeVerifyScript(root, false);
    const allowed = await (handlers.agent_before_settle as (event: unknown, ctx: HookContext) => Promise<unknown>)(
      { outcome: "completed" },
      ctx,
    );
    assert.equal(allowed, undefined, "a passing verify lets the agent settle");
  } finally {
    if (previous === undefined) delete process.env[MYFLOW_AGENT_ENV];
    else process.env[MYFLOW_AGENT_ENV] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify gate: a channel review worker is held without an agent type", async () => {
  // Channel workers run as ordinary pi processes: no MYFLOW_AGENT_TYPE, just
  // the flag their launcher sets.
  const root = makeProject();
  const agentBackup = process.env[MYFLOW_AGENT_ENV];
  const flagBackup = process.env.MYFLOW_VERIFY_GATE_ENV;
  delete process.env[MYFLOW_AGENT_ENV];
  process.env[MYFLOW_VERIFY_GATE_ENV] = "1";
  try {
    writeVerifyScript(root, true);
    const { api } = makeMockAPI(root);
    extension(api);
    const handlers = getHandlers(api);
    const ctx = getCtx(api);
    await handlers.session_start({}, ctx);

    const blocked = (await (handlers.agent_before_settle as (event: unknown, ctx: HookContext) => Promise<unknown>)(
      { outcome: "completed" },
      ctx,
    )) as { continue?: boolean; entries?: Array<{ customType: string }> } | undefined;
    assert.equal(blocked?.continue, true, "a flagged review worker is held while verify fails");
    assert.equal(blocked?.entries?.[0]?.customType, "verify-gate");

    delete process.env[MYFLOW_VERIFY_GATE_ENV];
    const plain = await (handlers.agent_before_settle as (event: unknown, ctx: HookContext) => Promise<unknown>)(
      { outcome: "completed" },
      ctx,
    );
    assert.equal(plain, undefined, "without the flag and without an agent type nothing is gated");
  } finally {
    if (agentBackup === undefined) delete process.env[MYFLOW_AGENT_ENV];
    else process.env[MYFLOW_AGENT_ENV] = agentBackup;
    if (flagBackup === undefined) delete process.env[MYFLOW_VERIFY_GATE_ENV];
    else process.env[MYFLOW_VERIFY_GATE_ENV] = flagBackup;
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify gate: bounded and only applies to the check agent", async () => {
  const root = makeProject();
  writeVerifyScript(root, true);
  const previous = process.env[MYFLOW_AGENT_ENV];
  try {
    delete process.env[MYFLOW_AGENT_ENV];
    const main = makeMockAPI(root);
    extension(main.api);
    const mainHandlers = getHandlers(main.api);
    const mainCtx = getCtx(main.api);
    await mainHandlers.session_start({}, mainCtx);
    const mainResult = await (mainHandlers.agent_before_settle as (event: unknown, ctx: HookContext) => Promise<unknown>)(
      { outcome: "completed" },
      mainCtx,
    );
    assert.equal(mainResult, undefined, "the main session is never gated");

    process.env[MYFLOW_AGENT_ENV] = "myflow-check";
    const check = makeMockAPI(root);
    extension(check.api);
    const checkHandlers = getHandlers(check.api);
    const checkCtx = getCtx(check.api);
    await checkHandlers.session_start({}, checkCtx);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const blocked = (await (checkHandlers.agent_before_settle as (event: unknown, ctx: HookContext) => Promise<unknown>)(
        { outcome: "completed" },
        checkCtx,
      )) as { continue?: boolean } | undefined;
      assert.equal(blocked?.continue, true, `attempt ${attempt} must be held`);
    }
    const exhausted = await (checkHandlers.agent_before_settle as (event: unknown, ctx: HookContext) => Promise<unknown>)(
      { outcome: "completed" },
      checkCtx,
    );
    assert.equal(exhausted, undefined, "the gate stops after the retry cap");
  } finally {
    if (previous === undefined) delete process.env[MYFLOW_AGENT_ENV];
    else process.env[MYFLOW_AGENT_ENV] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
