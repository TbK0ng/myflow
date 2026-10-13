import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TurnContextCache, resolveActiveTaskStatus, SESSION_OVERVIEW_TEXT } from "../src/turn-cache.ts";

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
