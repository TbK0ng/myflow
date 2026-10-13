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
  registerMyflowSubagent,
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
  const discovery = discoverAgents(ROOT, "project");
  const names = discovery.agents.map((agent) => agent.name).sort();
  assert.deepEqual(names, ["myflow-check", "myflow-implement", "myflow-research"]);
  const implement = discovery.agents.find((agent) => agent.name === "myflow-implement")!;
  assert.ok(implement.systemPrompt.includes("Implement Agent"));
  assert.ok((implement.tools ?? []).includes("write"));
  assert.equal(implement.source, "project");
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
  assert.ok(tool!.parameters.properties.tasks);
});

test("myflow_subagent: invalid parameters reports available agents", async () => {
  const { api, tools } = makeMockAPI();
  registerMyflowSubagent(api as any);
  const tool = tools.find((candidate) => candidate.name === "myflow_subagent")!;
  const result = await tool.execute("id", {}, undefined, undefined, { cwd: ROOT });
  assert.ok(result.content[0].text.includes("Invalid parameters"));
  assert.ok(result.content[0].text.includes("myflow-implement"));
});

test("myflow_subagent: unknown agent fails without spawning", async () => {
  const { api, tools } = makeMockAPI();
  registerMyflowSubagent(api as any);
  const tool = tools.find((candidate) => candidate.name === "myflow_subagent")!;
  const result = await tool.execute(
    "id",
    { agent: "does-not-exist", task: "do it" },
    undefined,
    undefined,
    { cwd: ROOT },
  );
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("Unknown agent"));
});

test("myflow_subagent: emits myflow-subagent-progress on dispatch", async () => {
  const { api, tools, events } = makeMockAPI();
  registerMyflowSubagent(api as any);
  const tool = tools.find((candidate) => candidate.name === "myflow_subagent")!;
  // Parallel progress is emitted even when every dispatched agent is unknown,
  // so this never invokes a real model.
  await tool.execute(
    "id",
    { tasks: [{ agent: "does-not-exist", task: "review" }] },
    undefined,
    undefined,
    { cwd: ROOT },
  );
  assert.ok(events.some((event) => event.channel === PROGRESS_CHANNEL));
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
  process.env[MYFLOW_AGENT_ENV] = "myflow-implement";
  try {
    const { api, handlers } = makeMockAPI();
    extension(api);
    const result = (await handlers.tool_call(
      { toolName: "myflow_subagent" },
      { cwd: ROOT },
    )) as { block?: boolean; reason?: string } | undefined;
    assert.equal(result?.block, true);
    assert.ok(result?.reason?.includes("Recursion guard"));
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
