import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import extension, { SKIP_BREADCRUMB_ENV } from "../.pi/extensions/myflow/index.ts";
import type { ExtensionAPI, HookContext, Message } from "../.pi/extensions/myflow/index.ts";
import { MYFLOW_AGENT_ENV, MYFLOW_VERIFY_GATE_ENV } from "../.pi/extensions/myflow/subagent.ts";

/**
 * This suite builds isolated temp projects and expects `get_context.py` to use
 * the single `.myflow/.runtime/sessions/*.json` file (the mock ctx has no
 * sessionManager). A real `pi -p "npm test"` injects PI_SESSION_ID into every
 * shell command, which would make the helper look for a keyed session file that
 * does not exist and render `CURRENT TASK: none`. Scrub the Pi session identity
 * for this file and restore it afterwards; the production derivation is still
 * covered by the task.py/get_context.py tests that set it explicitly.
 */
const PI_ENV_KEYS = ["PI_SESSION_ID", "PI_SESSION_FILE", "MYFLOW_CONTEXT_ID"] as const;
const savedPiEnv = new Map<string, string | undefined>();

before(() => {
  for (const key of PI_ENV_KEYS) {
    savedPiEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

after(() => {
  for (const key of PI_ENV_KEYS) {
    const value = savedPiEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-ext-"));
  mkdirSync(join(root, ".myflow", ".runtime", "sessions"), { recursive: true });
  mkdirSync(join(root, ".myflow", "scripts"), { recursive: true });
  copyFileSync(join(fileURLToPath(new URL("..", import.meta.url)), ".myflow", "scripts", "get_context.py"), join(root, ".myflow", "scripts", "get_context.py"));
  // `gate-info` is the only approval read path; `/myflow-status` shells out to
  // it, so a project that exercises the command needs a task.py copy too.
  copyFileSync(join(fileURLToPath(new URL("..", import.meta.url)), ".myflow", "scripts", "task.py"), join(root, ".myflow", "scripts", "task.py"));
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
  const api = {
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
  } as unknown as ExtensionAPI;
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

test("context: refreshes session-context when the active task changes", async () => {
  const root = makeProject();
  const { api, sent } = makeMockAPI(root);
  extension(api);
  const handlers = getHandlers(api);
  const ctx = getCtx(api);
  await handlers.session_start({}, ctx);

  const original = sent.find((m) => m.customType === "session-context");
  assert.ok(original?.content?.includes("CURRENT TASK: .myflow/tasks/demo"), "startup context names the task");

  // Archive/finish clears the pointer; the next context pass must not keep the
  // startup snapshot's `CURRENT TASK: .myflow/tasks/demo` in front of the model.
  writeFileSync(
    join(root, ".myflow", ".runtime", "sessions", "pi_session_test.json"),
    JSON.stringify({ current_task: null }),
  );
  const result = await (handlers.context as (event: unknown, ctx: HookContext) => Promise<unknown>)(
    { messages: sent.slice() },
    ctx,
  );
  const projected = (result as { messages: Message[] } | undefined)?.messages ?? [];
  const refreshed = projected.filter((m) => m.customType === "session-context");
  assert.equal(refreshed.length, 1, "session-context must be replaced, not duplicated");
  assert.match(refreshed[0]!.content!, /CURRENT TASK: none/);
  assert.equal(
    projected.filter((m) => m.customType === "task-context").length,
    0,
    "task-context must disappear with the task",
  );
  rmSync(root, { recursive: true, force: true });
});

test("context: a sub-agent never receives session-context", async () => {
  const root = makeProject();
  const previous = process.env[MYFLOW_AGENT_ENV];
  process.env[MYFLOW_AGENT_ENV] = "myflow-implement";
  try {
    const { api } = makeMockAPI(root);
    extension(api);
    const handlers = getHandlers(api);
    const ctx = getCtx(api);
    await handlers.session_start({}, ctx);
    const result = await (handlers.context as (event: unknown, ctx: HookContext) => Promise<unknown>)(
      { messages: [] },
      ctx,
    );
    const projected = (result as { messages: Message[] } | undefined)?.messages ?? [];
    assert.equal(
      projected.filter((m) => m.customType === "session-context").length,
      0,
      "sub-agents get task-context only",
    );
  } finally {
    if (previous === undefined) delete process.env[MYFLOW_AGENT_ENV];
    else process.env[MYFLOW_AGENT_ENV] = previous;
    rmSync(root, { recursive: true, force: true });
  }
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

// ---------------------------------------------------------------------------
// G-1…G-4: the plan-approval gate's wiring (index.ts / status.ts).
// ---------------------------------------------------------------------------

const ASK_APPROVAL_TOOLS = ["myflow_ask_user", "myflow_request_approval"];

/** The demo task dir created by `makeProject`. */
function demoTaskDir(root: string): string {
  return join(root, ".myflow", "tasks", "demo");
}

/** Run the one authoritative hash implementation for the demo task. */
function planHashFor(root: string): string {
  return execFileSync(
    "python3",
    [join(root, ".myflow", "scripts", "task.py"), "plan-hash", join(root, ".myflow", "tasks", "demo")],
    { cwd: root, encoding: "utf-8" },
  ).trim();
}

/** Short (8 hex) form of a `sha256:<hex>` string, as `/myflow-status` prints. */
function short(hash: string): string {
  return hash.split(":", 2)[1].slice(0, 8);
}

function runStatusCommand(root: string): Promise<string> {
  const { api, sent, commands } = makeMockAPI(root);
  extension(api);
  return commands["myflow-status"]
    .handler("", getCtx(api))
    .then(() => sent.find((m) => m.customType === "myflow-status")!.content!);
}

test("G-1/G-2: a sub-agent is blocked from asking or requesting approval", async () => {
  const root = makeProject();
  const previous = process.env[MYFLOW_AGENT_ENV];
  process.env[MYFLOW_AGENT_ENV] = "myflow-implement";
  try {
    const { api } = makeMockAPI(root);
    extension(api);
    const handlers = getHandlers(api);
    const ctx = getCtx(api);
    for (const toolName of ASK_APPROVAL_TOOLS) {
      // Revert point: drop the ASK_TOOL_NAMES branch → both results become undefined.
      const result = (await handlers.tool_call({ toolName }, ctx)) as
        | { block?: boolean; reason?: string }
        | undefined;
      assert.equal(result?.block, true, `${toolName} must be blocked for a sub-agent`);
      assert.match(result!.reason ?? "", /main session/);
    }
    // The recursion guard this sits beside still fires, unchanged.
    const recursion = (await handlers.tool_call({ toolName: "myflow_subagent" }, ctx)) as
      | { block?: boolean; reason?: string }
      | undefined;
    assert.match(recursion!.reason ?? "", /Recursion guard/);
  } finally {
    if (previous === undefined) delete process.env[MYFLOW_AGENT_ENV];
    else process.env[MYFLOW_AGENT_ENV] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("G-1/G-2: the main session is not blocked from asking or requesting approval", async () => {
  const root = makeProject();
  try {
    const { api } = makeMockAPI(root);
    extension(api);
    const handlers = getHandlers(api);
    const ctx = getCtx(api);
    for (const toolName of ASK_APPROVAL_TOOLS) {
      const result = await handlers.tool_call({ toolName }, ctx);
      assert.equal(result, undefined, `${toolName} must pass through for the main session`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("G-3: /myflow-status reports approval: missing without approval.json", async () => {
  const root = makeProject();
  try {
    writeFileSync(join(demoTaskDir(root), "prd.md"), "# plan\n");
    const text = await runStatusCommand(root);
    assert.match(text, /Approval: missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("G-3: /myflow-status reports approval: approved when the hash matches", async () => {
  const root = makeProject();
  try {
    writeFileSync(join(demoTaskDir(root), "prd.md"), "# plan\n");
    const hash = planHashFor(root);
    writeFileSync(
      join(demoTaskDir(root), "approval.json"),
      JSON.stringify({ approved_by: "cli", plan_files: ["prd.md"], plan_hash: hash, questions_asked: 1 }),
    );
    const text = await runStatusCommand(root);
    assert.match(text, /Approval: approved/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("G-3: /myflow-status reports approval: stale with old -> new short hashes", async () => {
  const root = makeProject();
  try {
    const prd = join(demoTaskDir(root), "prd.md");
    writeFileSync(prd, "# plan\n");
    const oldHash = planHashFor(root);
    writeFileSync(
      join(demoTaskDir(root), "approval.json"),
      JSON.stringify({ approved_by: "cli", plan_files: ["prd.md"], plan_hash: oldHash, questions_asked: 1 }),
    );
    writeFileSync(prd, "# plan edited\n");
    const newHash = planHashFor(root);

    const text = await runStatusCommand(root);
    assert.notEqual(oldHash, newHash, "editing the plan must change the hash");
    assert.match(text, /Approval: stale \(/);
    assert.ok(
      text.includes(`${short(oldHash)} \u2192 ${short(newHash)}`),
      `stale line must show ${short(oldHash)} -> ${short(newHash)}:\n${text}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("G-3: the injected deriveContextKey resolves the active task (ambiguous sessions)", async () => {
  const root = makeProject();
  try {
    // Two extra session files make a null context key ambiguous (no_task); only
    // the deriver index.ts injects into the tool can pick the demo task.
    writeFileSync(
      join(root, ".myflow", ".runtime", "sessions", "pi_other.json"),
      JSON.stringify({ current_task: null }),
    );
    writeFileSync(
      join(root, ".myflow", ".runtime", "sessions", "pi_extg3.json"),
      JSON.stringify({ current_task: ".myflow/tasks/demo" }),
    );

    const { api, tools } = makeMockAPI(root);
    extension(api);
    const tool = tools.find((candidate) => candidate.name === "myflow_ask_user") as unknown as {
      execute: (
        id: string,
        params: Record<string, unknown>,
        signal: undefined,
        onUpdate: undefined,
        ctx: Record<string, unknown>,
      ) => Promise<{ details: Record<string, unknown>; isError?: boolean }>;
    };

    const result = await tool.execute(
      "id",
      { header: "h", question: "选哪个？", options: ["甲", "乙"] },
      undefined,
      undefined,
      {
        cwd: root,
        mode: "tui",
        hasUI: true,
        ui: { select: async (_title: string, options: string[]) => options[0] },
        sessionManager: { getSessionId: () => "extg3" },
      },
    );

    assert.ok(!result.isError, `the tool must resolve the active task: ${JSON.stringify(result.details)}`);
    assert.equal(result.details.answer, "甲");
    assert.ok(
      existsSync(join(demoTaskDir(root), "questions.jsonl")),
      "the answer must be audited in the resolved task dir",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
