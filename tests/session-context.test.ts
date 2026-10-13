import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TurnContextCache, resolveActiveTaskStatus, SESSION_OVERVIEW_TEXT } from "../src/turn-cache.ts";
import { sanitizeKey, hashValue, buildContextKey, deriveContextKey } from "../.omp/extensions/myflow/index.ts";

function makeProject(withTask: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-session-"));
  mkdirSync(join(root, ".myflow", ".runtime", "sessions"), { recursive: true });
  writeFileSync(join(root, ".myflow", "workflow.md"), [
    "[workflow-state:planning]",
    "Plan the work.",
    "[/workflow-state:planning]",
    "",
    "[workflow-state:implementing]",
    "Write the code.",
    "[/workflow-state:implementing]",
  ].join("\n"));
  if (withTask) {
    const taskDir = join(root, "tasks", "demo");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "task.json"), JSON.stringify({
      title: "Demo task",
      status: "implementing",
    }));
    writeFileSync(
      join(root, ".myflow", ".runtime", "sessions", "omp_session_test.json"),
      JSON.stringify({ current_task: "tasks/demo" }),
    );
  }
  return root;
}

test("SESSION_OVERVIEW_TEXT is non-empty", () => {
  assert.ok(SESSION_OVERVIEW_TEXT.length > 0);
});

test("sanitizeKey: strips non-alphanumeric except dot and dash", () => {
  assert.equal(sanitizeKey("hello world!"), "hello_world");
  assert.equal(sanitizeKey("  leading-trailing  "), "leading-trailing");
  assert.equal(sanitizeKey("a.b-c_d"), "a.b-c_d");
});

test("hashValue: returns 24-char hex prefix", () => {
  const h = hashValue("test");
  assert.equal(h.length, 24);
  assert.match(h, /^[0-9a-f]{24}$/);
});

test("buildContextKey: session kind", () => {
  assert.equal(buildContextKey("omp", "session", "abc123"), "omp_abc123");
});

test("buildContextKey: transcript kind uses hash", () => {
  const result = buildContextKey("omp", "transcript", "/path/to/file");
  assert.match(result, /^omp_transcript_[0-9a-f]{24}$/);
});

test("deriveContextKey: with session ID", () => {
  const ctx = { cwd: "/", sessionManager: { getSessionId: () => "abc123" } };
  assert.equal(deriveContextKey(ctx), "omp_abc123");
});

test("deriveContextKey: with session file", () => {
  const ctx = { cwd: "/", sessionManager: { getSessionFile: () => "/path/to/file" } };
  assert.match(deriveContextKey(ctx)!, /^omp_transcript_[0-9a-f]{24}$/);
});

test("deriveContextKey: with MYFLOW_CONTEXT_ID override", () => {
  const original = process.env.MYFLOW_CONTEXT_ID;
  process.env.MYFLOW_CONTEXT_ID = "my-override";
  try {
    const ctx = { cwd: "/" };
    assert.equal(deriveContextKey(ctx), "my-override");
  } finally {
    if (original === undefined) delete process.env.MYFLOW_CONTEXT_ID;
    else process.env.MYFLOW_CONTEXT_ID = original;
  }
});

test("deriveContextKey: no session, no file, no override returns null", () => {
  const original = process.env.MYFLOW_CONTEXT_ID;
  delete process.env.MYFLOW_CONTEXT_ID;
  try {
    const ctx = { cwd: "/" };
    assert.equal(deriveContextKey(ctx), null);
  } finally {
    if (original !== undefined) process.env.MYFLOW_CONTEXT_ID = original;
  }
});

test("resolveActiveTaskStatus: no sessions dir", () => {
  const root = mkdtempSync(join(tmpdir(), "myflow-nosess-"));
  const result = resolveActiveTaskStatus(root, "omp_session_test");
  assert.equal(result.status, "no_task");
  assert.equal(result.taskDir, null);
  rmSync(root, { recursive: true, force: true });
});

test("resolveActiveTaskStatus: with task", () => {
  const root = makeProject(true);
  const result = resolveActiveTaskStatus(root, "omp_session_test");
  assert.equal(result.status, "implementing");
  assert.ok(result.taskDir);
  assert.equal(result.taskTitle, "Demo task");
  rmSync(root, { recursive: true, force: true });
});

test("resolveActiveTaskStatus: no context key, single session", () => {
  const root = makeProject(true);
  const result = resolveActiveTaskStatus(root, null);
  assert.equal(result.status, "implementing");
  rmSync(root, { recursive: true, force: true });
});

test("TurnContextCache: returns workflow state", () => {
  const root = makeProject(true);
  const cache = new TurnContextCache();
  cache.beginTurn(false);
  const result = cache.get(root, "omp_session_test");
  assert.ok(result.workflowMsg.includes("[workflow-state:implementing]"));
  assert.ok(result.workflowMsg.includes("Write the code."));
  assert.ok(result.workflowMsg.includes(SESSION_OVERVIEW_TEXT));
  rmSync(root, { recursive: true, force: true });
});

test("TurnContextCache: skip turn returns empty", () => {
  const root = makeProject(true);
  const cache = new TurnContextCache();
  cache.beginTurn(true);
  const result = cache.get(root, "omp_session_test");
  assert.equal(result.workflowMsg, "");
  rmSync(root, { recursive: true, force: true });
});

test("TurnContextCache: no task returns fallback", () => {
  const root = makeProject(false);
  const cache = new TurnContextCache();
  cache.beginTurn(false);
  const result = cache.get(root, "omp_session_test");
  assert.ok(result.workflowMsg.includes("Refer to workflow.md"));
  rmSync(root, { recursive: true, force: true });
});

test("TurnContextCache: caching works", () => {
  const root = makeProject(true);
  const cache = new TurnContextCache();
  cache.beginTurn(false);
  const r1 = cache.get(root, "omp_session_test");
  const r2 = cache.get(root, "omp_session_test");
  assert.equal(r1.workflowMsg, r2.workflowMsg);
  rmSync(root, { recursive: true, force: true });
});
