import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TurnContextCache, SESSION_OVERVIEW_TEXT, resolveActiveTaskStatus } from "../.pi/extensions/myflow/turn-cache.ts";

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "myflow-"));
  mkdirSync(join(dir, ".myflow"));
  writeFileSync(
    join(dir, ".myflow", "workflow.md"),
    [
      "[workflow-state:no_task]",
      "No active task.",
      "[/workflow-state:no_task]",
      "",
      "[workflow-state:planning]",
      "Stay in planning.",
      "[/workflow-state:planning]",
      "",
      "[workflow-state:in_progress]",
      "Tools: implement / check.",
      "[/workflow-state:in_progress]",
    ].join("\n"),
  );
  return dir;
}

function makeSession(dir: string, contextKey: string, taskStatus: string): void {
  const sessionsDir = join(dir, ".myflow", ".runtime", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `${contextKey}.json`),
    JSON.stringify({ current_task: ".myflow/tasks/test-task" }),
  );
  const taskDir = join(dir, ".myflow", "tasks", "test-task");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({ status: taskStatus, title: "Test Task" }),
  );
}

test("resolveActiveTaskStatus: no sessions dir returns no_task", () => {
  const dir = makeProject();
  try {
    const result = resolveActiveTaskStatus(dir, null);
    assert.equal(result.status, "no_task");
    assert.equal(result.taskDir, null);
    assert.equal(result.taskTitle, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveActiveTaskStatus: reads task.json status", () => {
  const dir = makeProject();
  makeSession(dir, "ctx1", "planning");
  try {
    const result = resolveActiveTaskStatus(dir, "ctx1");
    assert.equal(result.status, "planning");
    assert.ok(result.taskDir);
    assert.equal(result.taskTitle, "Test Task");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveActiveTaskStatus: single session fallback", () => {
  const dir = makeProject();
  makeSession(dir, "only-session", "in_progress");
  try {
    const result = resolveActiveTaskStatus(dir, null);
    assert.equal(result.status, "in_progress");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveActiveTaskStatus: multiple sessions without contextKey returns no_task", () => {
  const dir = makeProject();
  makeSession(dir, "session1", "planning");
  makeSession(dir, "session2", "in_progress");
  try {
    const result = resolveActiveTaskStatus(dir, null);
    assert.equal(result.status, "no_task");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TurnContextCache: injects correct workflow state", () => {
  const dir = makeProject();
  makeSession(dir, "ctx1", "planning");
  try {
    const cache = new TurnContextCache();
    cache.beginTurn(false);
    const result = cache.get(dir, "ctx1");
    assert.ok(result.workflowMsg.includes("[workflow-state:planning]"));
    assert.ok(result.workflowMsg.includes("Stay in planning."));
    assert.ok(result.workflowMsg.includes(SESSION_OVERVIEW_TEXT));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TurnContextCache: skip keyword suppresses workflow state", () => {
  const dir = makeProject();
  makeSession(dir, "ctx1", "planning");
  try {
    const cache = new TurnContextCache();
    cache.beginTurn(true);
    const result = cache.get(dir, "ctx1");
    assert.equal(result.workflowMsg, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TurnContextCache: no_task status injects no_task block", () => {
  const dir = makeProject();
  try {
    const cache = new TurnContextCache();
    cache.beginTurn(false);
    const result = cache.get(dir, null);
    assert.ok(result.workflowMsg.includes("[workflow-state:no_task]"));
    assert.ok(result.workflowMsg.includes("No active task."));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TurnContextCache: caches within TTL", () => {
  const dir = makeProject();
  makeSession(dir, "ctx1", "planning");
  try {
    const cache = new TurnContextCache();
    cache.beginTurn(false);
    const r1 = cache.get(dir, "ctx1");
    const r2 = cache.get(dir, "ctx1");
    assert.equal(r1.workflowMsg, r2.workflowMsg);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
