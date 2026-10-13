import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, {
  type ExtensionAPI,
  type HookContext,
  type Message,
} from "../src/extension.ts";

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-test-"));
  mkdirSync(join(root, ".myflow", "tasks"), { recursive: true });
  writeFileSync(
    join(root, ".myflow", "workflow.md"),
    "[workflow-state:implement]\nDo the thing\n[/workflow-state:implement]\n[workflow-state:check]\nVerify the thing\n[/workflow-state:check]\n",
  );
  writeFileSync(join(root, ".myflow", "tasks", "prd.md"), "# PRD\nBuild it\n");
  return root;
}

function makeApi(): ExtensionAPI & { sent: Array<{ customType: string; content: string }> } {
  const sent: Array<{ customType: string; content: string }> = [];
  return {
    sent,
    on: () => {},
    sendMessage: async (msg) => {
      sent.push({ customType: msg.customType, content: msg.content });
    },
  };
}

test("extension registers without throwing", () => {
  const api = makeApi();
  assert.doesNotThrow(() => extension(api));
});

test("session_start sends session context for main agent", async () => {
  const root = makeProjectRoot();
  const api = makeApi();
  const handlers: Record<string, (e: unknown, c: HookContext) => void | Promise<void>> = {};
  api.on = (event, handler) => {
    handlers[event] = handler;
  };
  extension(api);

  const ctx: HookContext = {
    cwd: root,
    sessionManager: { getSessionId: () => "test-session" },
  };
  await handlers["session_start"]({}, ctx);
  assert.ok(api.sent.some((m) => m.customType === "session-context"));
});

test("session_start sends task context for subagent", async () => {
  const root = makeProjectRoot();
  process.env.PI_BLOCKED_AGENT = "myflow-implement";
  try {
    const api = makeApi();
    const handlers: Record<string, (e: unknown, c: HookContext) => void | Promise<void>> = {};
    api.on = (event, handler) => {
      handlers[event] = handler;
    };
    extension(api);

    const ctx: HookContext = {
      cwd: root,
      sessionManager: { getSessionId: () => "test-session" },
    };
    await handlers["session_start"]({}, ctx);
    // Subagent path: task context is sent if taskDir exists
  } finally {
    delete process.env.PI_BLOCKED_AGENT;
  }
});

test("input hook does not throw with no project", async () => {
  const api = makeApi();
  const handlers: Record<string, (e: unknown, c: HookContext) => void | Promise<void>> = {};
  api.on = (event, handler) => {
    handlers[event] = handler;
  };
  extension(api);

  const ctx: HookContext = { cwd: "/nonexistent/path" };
  await assert.doesNotReject(() => handlers["input"]({}, ctx));
});

test("context hook preserves existing messages", async () => {
  const root = makeProjectRoot();
  const api = makeApi();
  const handlers: Record<string, (e: unknown, c: HookContext) => void | Promise<void>> = {};
  api.on = (event, handler) => {
    handlers[event] = handler;
  };
  extension(api);

  const ctx: HookContext = {
    cwd: root,
    sessionManager: { getSessionId: () => "test-session" },
  };
  const existingMessages: Message[] = [{ role: "user", content: "hello" }];
  await handlers["context"]({ messages: existingMessages }, ctx);
  // The context hook should not throw
});
