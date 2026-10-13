import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../.pi/extensions/myflow/index.ts";
import type { ExtensionAPI, HookContext, Message } from "../.pi/extensions/myflow/index.ts";
import {
  CONFIG_DIR_NAME,
  discoverAgents,
  findNearestProjectAgentsDir,
  parseFrontmatter,
  parseToolList,
} from "../.pi/extensions/myflow/agents.ts";
import {
  MYFLOW_AGENT_ENV,
  PROGRESS_CHANNEL,
  getPiInvocation,
  isFailedResult,
  normalizeAgentName,
  registerMyflowSubagent,
  resolveRunConfig,
} from "../.pi/extensions/myflow/subagent.ts";

const ROOT = join(import.meta.dirname, "..");

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-subagent-"));
  mkdirSync(join(root, ".myflow"), { recursive: true });
  return root;
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
      { agent: "implement", mode: "parallel", prompts: ["one", "two"] },
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

test("subagent helpers: isFailedResult and getPiInvocation", () => {
  assert.equal(isFailedResult({ exitCode: 1 } as any), true);
  assert.equal(isFailedResult({ exitCode: 0, stopReason: "end" } as any), false);
  const invocation = getPiInvocation(["--version"]);
  assert.equal(typeof invocation.command, "string");
  assert.ok(invocation.args.includes("--version"));
});
