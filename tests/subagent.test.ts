import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import extension from "../.pi/extensions/myflow/index.ts";
import type { ExtensionAPI, HookContext, Message } from "../.pi/extensions/myflow/index.ts";
import {
  CONFIG_DIR_NAME,
  discoverAgents,
  findNearestProjectAgentsDir,
  isSafeWriteScope,
  parseFrontmatter,
  parseToolList,
} from "../.pi/extensions/myflow/agents.ts";
import {
  MYFLOW_AGENT_ENV,
  MYFLOW_WRITES_UNDER_ENV,
  PROGRESS_CHANNEL,
  getPiInvocation,
  hasWriteScope,
  isFailedResult,
  normalizeAgentName,
  registerMyflowSubagent,
  resolveRunConfig,
  isWriteCapable,
} from "../.pi/extensions/myflow/subagent.ts";

const ROOT = join(import.meta.dirname, "..");

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-subagent-"));
  mkdirSync(join(root, ".myflow"), { recursive: true });
  return root;
}

/** A project with one active task and a session pointing at it. */
function makeScopedProject(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-guard-"));
  mkdirSync(join(root, ".myflow", ".runtime", "sessions"), { recursive: true });
  writeFileSync(join(root, ".myflow", "workflow.md"), "[workflow-state:in_progress]\nWork.\n[/workflow-state:in_progress]\n");
  const taskDir = join(root, "tasks", "demo");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ title: "Demo", status: "in_progress" }));
  writeFileSync(
    join(root, ".myflow", ".runtime", "sessions", "pi_guard.json"),
    JSON.stringify({ current_task: "tasks/demo" }),
  );
  return root;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

interface MockExtension {
  api: ExtensionAPI;
  handlers: Record<string, (event: unknown, ctx: HookContext) => unknown>;
  tools: Array<Record<string, any>>;
  events: Array<{ channel: string; data: unknown }>;
}

function makeMockAPI(): MockExtension {
  const handlers: Record<string, (event: unknown, ctx: HookContext) => unknown> = {};
  const tools: Array<Record<string, any>> = [];
  const events: Array<{ channel: string; data: unknown }> = [];
  const api = {
    on: (name: string, handler: (event: unknown, ctx: HookContext) => unknown) => {
      handlers[name] = handler;
    },
    registerTool: (tool: Record<string, unknown>) => {
      tools.push(tool);
    },
    registerCommand: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    sendMessage: (_msg: Message) => {},
    events: {
      emit: (channel: string, data: unknown) => {
        events.push({ channel, data });
      },
      on: () => () => {},
    },
  } as unknown as ExtensionAPI;
  return { api, handlers, tools, events };
}

test("parseFrontmatter: block scalar description and comma tools", () => {
  const content = [
    "---",
    "name: myflow-implement",
    "description: |",
    "  Implementation expert.",
    "  Reads the PRD.",
    "tools: read, write, edit, bash",
    "---",
    "Body text",
  ].join("\n");
  const { frontmatter, body } = parseFrontmatter(content);
  assert.equal(frontmatter.name, "myflow-implement");
  assert.equal(frontmatter.description, "Implementation expert.\nReads the PRD.");
  assert.equal(frontmatter.tools, "read, write, edit, bash");
  assert.equal(body, "Body text");
});

test("parseFrontmatter: inline list tools", () => {
  const content = ["---", "name: agent", "description: d", "tools: [read, grep]", "---", "x"].join("\n");
  const { frontmatter } = parseFrontmatter(content);
  assert.deepEqual(frontmatter.tools, ["read", "grep"]);
});

test("parseToolList: string, array, and empty", () => {
  assert.deepEqual(parseToolList("read, bash"), ["read", "bash"]);
  assert.deepEqual(parseToolList(["read", " bash "]), ["read", "bash"]);
  assert.equal(parseToolList(42), undefined);
  assert.equal(parseToolList([]), undefined);
});

test("discoverAgents: finds the three myflow agents in .pi/agents", () => {
  const discovery = discoverAgents(ROOT);
  const names = discovery.agents.map((agent) => agent.name).sort();
  assert.deepEqual(names, ["myflow-check", "myflow-implement", "myflow-research"]);
  const implement = discovery.agents.find((agent) => agent.name === "myflow-implement")!;
  assert.ok(implement.systemPrompt.includes("Implement Agent"));
  assert.ok((implement.tools ?? []).includes("write"));
  assert.ok(discovery.agentsDir?.endsWith("agents"));
});

test("findNearestProjectAgentsDir: walks up from a nested directory", () => {
  const root = makeProject();
  try {
    mkdirSync(join(root, CONFIG_DIR_NAME, "agents"), { recursive: true });
    const nested = join(root, "src", "deep");
    mkdirSync(nested, { recursive: true });
    assert.equal(findNearestProjectAgentsDir(nested), join(root, CONFIG_DIR_NAME, "agents"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registerMyflowSubagent: registers the myflow_subagent tool", () => {
  const { api, tools } = makeMockAPI();
  registerMyflowSubagent(api as any);
  const tool = tools.find((candidate) => candidate.name === "myflow_subagent");
  assert.ok(tool, "myflow_subagent must be registered");
  assert.equal(tool!.label, "Myflow Subagent");
  const properties = tool!.parameters.properties;
  assert.ok(properties.agent, "agent is required");
  assert.ok(properties.prompt, "prompt is required");
  assert.deepEqual(properties.mode.enum, ["single", "parallel", "chain"]);
  assert.ok(properties.prompts, "prompts drives parallel/chain");
  assert.ok(properties.model && properties.thinking, "per-call model and thinking overrides");
  assert.ok(!properties.tasks, "parallel takes prompts for one agent, not task objects");
  assert.ok(!properties.cwd, "sub-agents share the working tree; there is no per-task cwd");
});

test("normalizeAgentName: prefixes the myflow namespace and defaults", () => {
  assert.equal(normalizeAgentName(undefined), "myflow-implement");
  assert.equal(normalizeAgentName("implement"), "myflow-implement");
  assert.equal(normalizeAgentName("myflow-check"), "myflow-check");
  assert.equal(normalizeAgentName(" my-custom "), "myflow-my-custom");
});

test("resolveRunConfig: parameters beat the agent definition beat the caller", () => {
  const agent = { name: "myflow-implement", description: "", systemPrompt: "", model: "agent/model", thinking: "low", tools: ["read"], filePath: "" };
  const fromCaller = resolveRunConfig({}, agent, { model: "inherit/model", thinking: "off" });
  assert.equal(fromCaller.model, "agent/model");
  assert.equal(fromCaller.thinking, "low");
  assert.deepEqual(fromCaller.tools, ["read"]);

  const fromParams = resolveRunConfig({ model: "param/model", thinking: "high" }, agent, { model: "inherit/model" });
  assert.equal(fromParams.model, "param/model");
  assert.equal(fromParams.thinking, "high");

  const suffix = resolveRunConfig({ model: "param/model:xhigh" }, agent);
  assert.equal(suffix.model, "param/model");
  assert.equal(suffix.thinking, "xhigh");

  const inherited = resolveRunConfig({}, { ...agent, model: undefined, thinking: undefined }, { model: "inherit/model", thinking: "medium" });
  assert.equal(inherited.model, "inherit/model");
  assert.equal(inherited.thinking, "medium");
});

test("myflow_subagent: unknown agent reports the missing definition", async () => {
  const { api, tools } = makeMockAPI();
  registerMyflowSubagent(api as any);
  const tool = tools.find((candidate) => candidate.name === "myflow_subagent")!;
  const result = await tool.execute("id", { agent: "does-not-exist", prompt: "do it" }, undefined, undefined, {
    cwd: ROOT,
  });
  assert.ok(result.content[0].text.includes("No definition found for: myflow-does-not-exist"));
  assert.ok(result.content[0].text.includes("myflow-implement"));
});

test("myflow_subagent: missing prompt for single mode is rejected", async () => {
  const { api, tools } = makeMockAPI();
  registerMyflowSubagent(api as any);
  const tool = tools.find((candidate) => candidate.name === "myflow_subagent")!;
  await assert.rejects(
    () => tool.execute("id", { agent: "myflow-implement", mode: "single" }, undefined, undefined, { cwd: ROOT }),
    /prompt is required/,
  );
});

test("myflow_subagent: a run past its cap is stopped, reported, and logged", async () => {
  const root = makeProject();
  mkdirSync(join(root, ".pi", "agents"), { recursive: true });
  for (const name of ["myflow-research", "myflow-implement", "myflow-check"]) {
    cpSync(join(ROOT, ".pi", "agents", `${name}.md`), join(root, ".pi", "agents", `${name}.md`));
  }
  // A child that never finishes, with a known pid, so the cap and the tree
  // kill can both be checked without a model call.
  const childScript = join(root, "slow-child.js");
  const pidFile = join(root, "child.pid");
  writeFileSync(
    childScript,
    [
      'const fs = require("fs");',
      'process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working" }] } }) + String.fromCharCode(10));',
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setTimeout(() => {}, 60000);",
    ].join(String.fromCharCode(10)),
    "utf-8",
  );

  const argv1 = process.argv[1];
  process.argv[1] = childScript;
  try {
    const { api, tools } = makeMockAPI();
    registerMyflowSubagent(api as any);
    const tool = tools.find((candidate) => candidate.name === "myflow_subagent")!;
    const result = (await tool.execute(
      "id",
      { agent: "myflow-research", prompt: "probe", timeoutMs: 1200 },
      undefined,
      undefined,
      { cwd: root },
    )) as { content: Array<{ text: string }>; details: { runs: Array<Record<string, unknown>> }; isError?: boolean };

    const run = result.details.runs[0];
    assert.equal(result.isError, true, "a stopped run is an error result");
    assert.equal(run.timedOut, true);
    assert.equal(run.exitCode, 124, "124 mirrors timeout(1)");
    assert.match(result.content[0].text, /was stopped after \d+s/);
    assert.match(result.content[0].text, /timeoutMs/);

    const logPath = String(run.logPath);
    assert.ok(existsSync(logPath), "the raw stream must be kept");
    assert.match(readFileSync(logPath, "utf-8"), /"working"/, "the log holds what the run produced");

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const childPid = Number(readFileSync(pidFile, "utf-8"));
    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "the stopped run is killed, not orphaned");
  } finally {
    process.argv[1] = argv1;
    rmSync(root, { recursive: true, force: true });
  }
});

test("myflow_subagent: a run inside its cap is unaffected", async () => {
  const root = makeProject();
  mkdirSync(join(root, ".pi", "agents"), { recursive: true });
  cpSync(join(ROOT, ".pi", "agents", "myflow-research.md"), join(root, ".pi", "agents", "myflow-research.md"));

  const childScript = join(root, "fast-child.js");
  writeFileSync(
    childScript,
    [
      'process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done early" }] } }) + String.fromCharCode(10));',
      "process.exit(0);",
    ].join(String.fromCharCode(10)),
    "utf-8",
  );

  const argv1 = process.argv[1];
  process.argv[1] = childScript;
  try {
    const { api, tools } = makeMockAPI();
    registerMyflowSubagent(api as any);
    const tool = tools.find((candidate) => candidate.name === "myflow_subagent")!;
    const result = (await tool.execute(
      "id",
      { agent: "myflow-research", prompt: "quick", timeoutMs: 30_000 },
      undefined,
      undefined,
      { cwd: root },
    )) as { content: Array<{ text: string }>; details: { runs: Array<Record<string, unknown>> }; isError?: boolean };

    assert.equal(result.content[0].text, "done early");
    assert.ok(!result.isError);
    assert.ok(!result.details.runs[0].timedOut);
    assert.ok(existsSync(String(result.details.runs[0].logPath)));
  } finally {
    process.argv[1] = argv1;
    rmSync(root, { recursive: true, force: true });
  }
});

test("myflow_subagent: parallel dispatch is rejected for an unbounded write-capable agent", async () => {
  const { api, tools } = makeMockAPI();
  registerMyflowSubagent(api as any);
  const tool = tools.find((candidate) => candidate.name === "myflow_subagent")!;

  // Two writers without a declared scope in one working tree is the case the
  // protocol forbids, so it fails before any child process is spawned.
  for (const agent of ["implement", "check", "myflow-implement", "myflow-check"]) {
    await assert.rejects(
      () => tool.execute("id", { agent, mode: "parallel", prompts: ["one", "two"] }, undefined, undefined, { cwd: ROOT }),
      (error: Error) => {
        assert.match(error.message, /bounded writer/);
        assert.match(error.message, /writesUnder/, "the error names the declaration that would fix it");
        return true;
      },
    );
  }

  // The same agents stay available one at a time.
  await assert.rejects(
    () => tool.execute("id", { agent: "implement", mode: "single" }, undefined, undefined, { cwd: ROOT }),
    /prompt is required/,
    "single mode is a prompt check, not a writer rejection",
  );
});

test("myflow_subagent: a declared writesUnder scope allows parallel dispatch", async () => {
  const { api, tools } = makeMockAPI();
  registerMyflowSubagent(api as any);
  const tool = tools.find((candidate) => candidate.name === "myflow_subagent")!;
  // Force the "pi" fallback and an empty PATH so the spawn fails immediately.
  // A bounded writer must reach the spawn instead of being rejected by the
  // writer guard: both runs are dispatched, then both fail to spawn.
  const argv1 = process.argv[1];
  const pathEnv = process.env.PATH;
  process.argv[1] = "/nonexistent/not-a-script";
  process.env.PATH = mkdtempSync(join(tmpdir(), "myflow-no-path-"));
  try {
    const result = (await tool.execute(
      "id",
      { agent: "research", mode: "parallel", prompts: ["one", "two"] },
      undefined,
      undefined,
      { cwd: ROOT },
    )) as { isError?: boolean; details: { runs: unknown[] } };
    assert.equal(result.details.runs.length, 2, "both parallel prompts were dispatched");
    assert.equal(result.isError, true, "the spawn failed, not the writer guard");
  } finally {
    process.argv[1] = argv1;
    process.env.PATH = pathEnv;
  }
});

test("isWriteCapable/hasWriteScope: research is a bounded writer", () => {
  const implement = discoverAgents(ROOT).agents.find((agent) => agent.name === "myflow-implement")!;
  const research = discoverAgents(ROOT).agents.find((agent) => agent.name === "myflow-research")!;
  assert.equal(isWriteCapable(implement), true);
  assert.equal(isWriteCapable(research), true, "research now declares write");
  assert.equal(hasWriteScope(implement), false, "implement has no bounded scope");
  assert.equal(hasWriteScope(research), true, "research declares writesUnder: research");
  assert.equal(hasWriteScope({ ...research, writesUnder: "   " }), false, "a blank scope is no scope");
  // An escaping declaration must not earn parallel mode, and the child blocks it.
  assert.equal(hasWriteScope({ ...research, writesUnder: "../.." }), false, "a .. scope is not bounded");
  assert.equal(hasWriteScope({ ...research, writesUnder: "/tmp" }), false, "an absolute scope is not bounded");
  assert.equal(isSafeWriteScope("research"), true);
  assert.equal(isSafeWriteScope("research/nested"), true);
  assert.equal(isSafeWriteScope(""), false);
  assert.equal(isSafeWriteScope("   "), false);
  assert.equal(isSafeWriteScope(".."), false);
  assert.equal(isSafeWriteScope("research/../.."), false);
  assert.equal(isSafeWriteScope("research/.."), false);
  assert.equal(isSafeWriteScope("..\\escape"), false, "a backslash traversal is caught too");
  assert.equal(isSafeWriteScope("/abs/path"), false);
  assert.equal(isSafeWriteScope("C:\\abs"), false, "a drive-letter path is caught on every platform");
  assert.equal(isWriteCapable({ name: "custom", systemPrompt: "", source: "project", filePath: "" }), true);
  assert.equal(
    isWriteCapable({ name: "reader", systemPrompt: "", source: "project", filePath: "", tools: ["read", "grep"] }),
    false,
  );
});

test("myflow_subagent: emits progress before the child starts", async () => {
  const { api, tools, events } = makeMockAPI();
  registerMyflowSubagent(api as any);
  const tool = tools.find((candidate) => candidate.name === "myflow_subagent")!;
  // Force the "pi" fallback and an empty PATH so spawning fails immediately:
  // this exercises the progress event without a model call or a child process.
  const argv1 = process.argv[1];
  const pathEnv = process.env.PATH;
  process.argv[1] = "/nonexistent/not-a-script";
  process.env.PATH = mkdtempSync(join(tmpdir(), "myflow-no-path-"));
  try {
    const result = await tool.execute(
      "id",
      { agent: "research", mode: "parallel", prompts: ["one", "two"] },
      undefined,
      undefined,
      { cwd: ROOT },
    );
    assert.equal(result.isError, true);
    assert.ok(events.some((event) => event.channel === PROGRESS_CHANNEL), "progress must be emitted");
  } finally {
    process.argv[1] = argv1;
    process.env.PATH = pathEnv;
  }
});

test("extension registers myflow_subagent and all 6 hooks", () => {
  const { api, handlers, tools } = makeMockAPI();
  extension(api);
  assert.ok(handlers.session_start);
  assert.ok(handlers.input);
  assert.ok(handlers.before_agent_start);
  assert.ok(handlers.context);
  assert.ok(handlers.tool_call);
  assert.ok(handlers.session_before_compact);
  assert.ok(tools.some((tool) => tool.name === "myflow_subagent"));
});

test("tool_call: main session does not block myflow_subagent", async () => {
  const { api, handlers } = makeMockAPI();
  extension(api);
  const result = await handlers.tool_call({ toolName: "myflow_subagent" }, { cwd: ROOT });
  assert.equal(result, undefined);
});

test("tool_call: sub-agent blocks myflow_subagent (recursion guard)", async () => {
  const previous = process.env[MYFLOW_AGENT_ENV];
  try {
    // Any dispatched agent name counts, including custom ones.
    for (const agentName of ["myflow-implement", "my-custom-agent"]) {
      process.env[MYFLOW_AGENT_ENV] = agentName;
      const { api, handlers } = makeMockAPI();
      extension(api);
      const result = (await handlers.tool_call(
        { toolName: "myflow_subagent" },
        { cwd: ROOT },
      )) as { block?: boolean; reason?: string } | undefined;
      assert.equal(result?.block, true, `${agentName} must be blocked`);
      assert.ok(result?.reason?.includes("Recursion guard"), `${agentName}: ${result?.reason}`);
      assert.ok(result?.reason?.includes(agentName), "the reason names the agent");
    }
  } finally {
    if (previous === undefined) delete process.env[MYFLOW_AGENT_ENV];
    else process.env[MYFLOW_AGENT_ENV] = previous;
  }
});

test("tool_call: a scoped sub-agent may only write inside <active task>/<writesUnder>/", async () => {
  const previousAgent = process.env[MYFLOW_AGENT_ENV];
  const previousScope = process.env[MYFLOW_WRITES_UNDER_ENV];
  const previousContext = process.env.MYFLOW_CONTEXT_ID;
  const root = makeScopedProject();
  try {
    process.env[MYFLOW_AGENT_ENV] = "myflow-research";
    process.env[MYFLOW_WRITES_UNDER_ENV] = "research";
    process.env.MYFLOW_CONTEXT_ID = "pi_guard";
    const { api, handlers } = makeMockAPI();
    extension(api);
    const ctx = { cwd: root } as HookContext;
    await handlers.session_start({}, ctx);
    const call = (toolName: string, path: string) =>
      handlers.tool_call({ toolName, input: { path } }, ctx) as Promise<
        { block?: boolean; reason?: string } | undefined
      >;

    // Inside the scope: allowed through `/`, `\`, and nested directories, for
    // both tools the guard covers.
    for (const path of ["tasks/demo/research/note.md", "tasks\\demo\\research\\sub\\note.md"]) {
      assert.equal(await call("write", path), undefined, `write ${path} must be allowed`);
      assert.equal(await call("edit", path), undefined, `edit ${path} must be allowed`);
    }

    // Case: Windows folds case, so a case-varied scope directory is the same
    // directory; a case-sensitive filesystem treats it as outside.
    const caseVariant = await call("write", "tasks/demo/RESEARCH/note.md");
    if (process.platform === "win32") {
      assert.equal(caseVariant, undefined, "Windows is case-insensitive: RESEARCH is research");
    } else {
      assert.equal(caseVariant?.block, true, "POSIX is case-sensitive: RESEARCH is a different directory");
    }

    // Outside the scope: blocked, with a reason naming the scope.
    for (const path of [
      "tasks/demo/other/note.md",
      "tasks/demo/research/../escape.md",
      "tasks/demo/research/../../prd.md",
      // A sibling that only shares the scope's prefix must not match it: the
      // containment test appends a separator, so `researchX` != `research/`.
      "tasks/demo/researchX/note.md",
      "tasks/demo/researchevil.md",
      "tasks/demo/research-notes/note.md",
      "tasks/demo/RESEARCH-NOTES/note.md",
      "../outside.md",
      resolve(root, "..", "outside.md"),
      "/etc/passwd",
      "C:\\Windows\\x.md",
    ]) {
      const result = await call("write", path);
      assert.equal(result?.block, true, `${path} must be blocked`);
      assert.match(result?.reason ?? "", /Write blocked/, `${path} needs a reason`);
      assert.match(result?.reason ?? "", /research/, `${path} names the scope`);
    }

    // A missing target path fails closed.
    const missing = (await handlers.tool_call({ toolName: "write", input: {} }, ctx)) as
      | { block?: boolean; reason?: string }
      | undefined;
    assert.equal(missing?.block, true, "an unreadable target fails closed");
  } finally {
    restoreEnv(MYFLOW_AGENT_ENV, previousAgent);
    restoreEnv(MYFLOW_WRITES_UNDER_ENV, previousScope);
    restoreEnv("MYFLOW_CONTEXT_ID", previousContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool_call: a scoped sub-agent fails closed when no active task resolves", async () => {
  const previousAgent = process.env[MYFLOW_AGENT_ENV];
  const previousScope = process.env[MYFLOW_WRITES_UNDER_ENV];
  const previousContext = process.env.MYFLOW_CONTEXT_ID;
  const root = mkdtempSync(join(tmpdir(), "myflow-guard-notask-"));
  mkdirSync(join(root, ".myflow", ".runtime", "sessions"), { recursive: true });
  writeFileSync(join(root, ".myflow", "workflow.md"), "[workflow-state:no_task]\nNo task.\n[/workflow-state:no_task]\n");
  try {
    process.env[MYFLOW_AGENT_ENV] = "myflow-research";
    process.env[MYFLOW_WRITES_UNDER_ENV] = "research";
    process.env.MYFLOW_CONTEXT_ID = "pi_guard_none";
    const { api, handlers } = makeMockAPI();
    extension(api);
    const ctx = { cwd: root } as HookContext;
    await handlers.session_start({}, ctx);
    const result = (await handlers.tool_call(
      { toolName: "write", input: { path: "tasks/demo/research/note.md" } },
      ctx,
    )) as { block?: boolean; reason?: string } | undefined;
    assert.equal(result?.block, true, "no active task must fail closed");
    assert.match(result?.reason ?? "", /no active myflow task/i);
  } finally {
    restoreEnv(MYFLOW_AGENT_ENV, previousAgent);
    restoreEnv(MYFLOW_WRITES_UNDER_ENV, previousScope);
    restoreEnv("MYFLOW_CONTEXT_ID", previousContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool_call: a blank writesUnder declaration fails closed", async () => {
  const previousAgent = process.env[MYFLOW_AGENT_ENV];
  const previousScope = process.env[MYFLOW_WRITES_UNDER_ENV];
  const previousContext = process.env.MYFLOW_CONTEXT_ID;
  const root = makeScopedProject();
  try {
    process.env[MYFLOW_AGENT_ENV] = "myflow-research";
    process.env[MYFLOW_WRITES_UNDER_ENV] = "";
    process.env.MYFLOW_CONTEXT_ID = "pi_guard";
    const { api, handlers } = makeMockAPI();
    extension(api);
    const ctx = { cwd: root } as HookContext;
    await handlers.session_start({}, ctx);
    const result = (await handlers.tool_call(
      { toolName: "write", input: { path: "tasks/demo/research/note.md" } },
      ctx,
    )) as { block?: boolean; reason?: string } | undefined;
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /writesUnder/);
  } finally {
    restoreEnv(MYFLOW_AGENT_ENV, previousAgent);
    restoreEnv(MYFLOW_WRITES_UNDER_ENV, previousScope);
    restoreEnv("MYFLOW_CONTEXT_ID", previousContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool_call: an escaping writesUnder scope fails closed", async () => {
  const previousAgent = process.env[MYFLOW_AGENT_ENV];
  const previousScope = process.env[MYFLOW_WRITES_UNDER_ENV];
  const previousContext = process.env.MYFLOW_CONTEXT_ID;
  const root = makeScopedProject();
  try {
    process.env[MYFLOW_AGENT_ENV] = "myflow-research";
    process.env.MYFLOW_CONTEXT_ID = "pi_guard";
    const { api, handlers } = makeMockAPI();
    extension(api);
    const ctx = { cwd: root } as HookContext;
    await handlers.session_start({}, ctx);
    // A declaration that would silently widen the boundary to the project root
    // must not grant it: every write is blocked instead of being allowed.
    for (const scope of ["../..", "..", "research/../../..", "/tmp", "C:\\Windows"]) {
      process.env[MYFLOW_WRITES_UNDER_ENV] = scope;
      const result = (await handlers.tool_call(
        { toolName: "write", input: { path: "tasks/demo/research/note.md" } },
        ctx,
      )) as { block?: boolean; reason?: string } | undefined;
      assert.equal(result?.block, true, `scope ${scope} must fail closed`);
      assert.match(result?.reason ?? "", /relative directory/);
    }
  } finally {
    restoreEnv(MYFLOW_AGENT_ENV, previousAgent);
    restoreEnv(MYFLOW_WRITES_UNDER_ENV, previousScope);
    restoreEnv("MYFLOW_CONTEXT_ID", previousContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool_call: an unscoped writer keeps full-tree access (implement/check unchanged)", async () => {
  const previousAgent = process.env[MYFLOW_AGENT_ENV];
  const previousScope = process.env[MYFLOW_WRITES_UNDER_ENV];
  const previousContext = process.env.MYFLOW_CONTEXT_ID;
  const root = makeScopedProject();
  try {
    process.env[MYFLOW_AGENT_ENV] = "myflow-implement";
    delete process.env[MYFLOW_WRITES_UNDER_ENV];
    process.env.MYFLOW_CONTEXT_ID = "pi_guard";
    const { api, handlers } = makeMockAPI();
    extension(api);
    const ctx = { cwd: root } as HookContext;
    await handlers.session_start({}, ctx);
    // A serial writer that declares no scope must not be path-bounded: it has
    // to keep editing the whole tree (implement/check behavior is unchanged).
    const result = await handlers.tool_call({ toolName: "write", input: { path: "src/app.ts" } }, ctx);
    assert.equal(result, undefined, "an unscoped serial writer is not path-bounded");
  } finally {
    restoreEnv(MYFLOW_AGENT_ENV, previousAgent);
    restoreEnv(MYFLOW_WRITES_UNDER_ENV, previousScope);
    restoreEnv("MYFLOW_CONTEXT_ID", previousContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("subagent helpers: isFailedResult and getPiInvocation", () => {
  assert.equal(isFailedResult({ exitCode: 1 } as any), true);
  assert.equal(isFailedResult({ exitCode: 0, stopReason: "end" } as any), false);
  const invocation = getPiInvocation(["--version"]);
  assert.equal(typeof invocation.command, "string");
  assert.ok(invocation.args.includes("--version"));
});
