import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension, {
  type ExtensionAPI,
  type HookContext,
} from "../src/extension.ts";

/** Build a mock ExtensionAPI that records hook registrations and sent messages. */
function makeMockAPI() {
  const handlers: Record<string, Function> = {};
  const sentMessages: Array<{ customType: string; content: string; display: boolean }> = [];
  const api: ExtensionAPI = {
    on: (event: string, handler: Function) => { handlers[event] = handler; },
    sendMessage: async (msg: { customType: string; content: string; display: boolean }) => {
      sentMessages.push(msg);
    },
  };
  return { api, handlers, sentMessages };
}

/** Create a temporary project with .myflow/ structure. */
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-test-"));
  mkdirSync(join(root, ".myflow", "specs"), { recursive: true });
  mkdirSync(join(root, ".myflow", "tasks"), { recursive: true });
  mkdirSync(join(root, ".myflow", "memory"), { recursive: true });
  writeFileSync(
    join(root, ".myflow", "workflow.md"),
    [
      "[workflow-state:no_task]",
      "No active task.",
      "[/workflow-state:no_task]",
      "",
      "[workflow-state:planning]",
      "Plan the task.",
      "[/workflow-state:planning]",
      "",
      "[workflow-state:in_progress]",
      "Implement the task.",
      "[/workflow-state:in_progress]",
      "",
      "[workflow-state:completed]",
      "Task done.",
      "[/workflow-state:completed]",
    ].join("\n"),
  );
  return root;
}

function makeCtx(root: string): HookContext {
  return {
    cwd: root,
    projectRoot: root,
    agentType: null,
    sessionManager: { getSessionId: () => "test-session" },
  } as HookContext;
}

test("extension registers all 6 hooks", () => {
  const { api, handlers } = makeMockAPI();
  extension(api);
  assert.ok(handlers.session_start, "session_start registered");
  assert.ok(handlers.input, "input registered");
  assert.ok(handlers.before_agent_start, "before_agent_start registered");
  assert.ok(handlers.context, "context registered");
  assert.ok(handlers.tool_call, "tool_call registered");
  assert.ok(handlers.compaction, "compaction registered");
});

test("session_start discovers project root and sends session context", async () => {
  const root = makeProject();
  try {
    const { api, handlers, sentMessages } = makeMockAPI();
    extension(api);
    const ctx = makeCtx(root);
    await handlers.session_start({}, ctx);
    const sessionMsg = sentMessages.find((m) => m.customType === "session-context");
    assert.ok(sessionMsg, "session-context message sent");
    assert.ok(sessionMsg.content.includes("workflow-state"), "contains workflow state blocks");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("input hook runs without error", async () => {
  const root = makeProject();
  try {
    const { api, handlers } = makeMockAPI();
    extension(api);
    const ctx = makeCtx(root);
    await handlers.input({ text: "hello" }, ctx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("input hook with escape keyword runs without error", async () => {
  const root = makeProject();
  try {
    const { api, handlers } = makeMockAPI();
    extension(api);
    const ctx = makeCtx(root);
    await handlers.input({ text: "no-myflow" }, ctx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context hook runs without error", async () => {
  const root = makeProject();
  try {
    const { api, handlers } = makeMockAPI();
    extension(api);
    const ctx = makeCtx(root);
    await handlers.context(
      { messages: [{ role: "user", content: "hello" }] },
      ctx,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("before_agent_start runs without error for main agent", async () => {
  const root = makeProject();
  try {
    const { api, handlers } = makeMockAPI();
    extension(api);
    const ctx = makeCtx(root);
    await handlers.before_agent_start({}, ctx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool_call hook runs without error", async () => {
  const root = makeProject();
  try {
    const { api, handlers } = makeMockAPI();
    extension(api);
    const ctx = makeCtx(root);
    await handlers.tool_call({ toolName: "bash", args: {} }, ctx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction hook runs without error", async () => {
  const root = makeProject();
  try {
    const { api, handlers } = makeMockAPI();
    extension(api);
    const ctx = makeCtx(root);
    await handlers.compaction({}, ctx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
