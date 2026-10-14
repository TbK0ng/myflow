import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// W2 / P0-4: the read side refuses a `current_task` that leaves `.myflow/tasks/`.
//
// A pointer is not always user input: a stale or poisoned session file can name
// an absolute path, a `..` escape, or a symlink out of the tasks tree. The
// resolver must treat each as "no active task" rather than resolving it (and
// rather than reporting a bogus "stale" task, which would hide the escape).
// ---------------------------------------------------------------------------

/** Write a raw session pointer without going through task.py. */
function writePointer(dir: string, contextKey: string, pointer: string): void {
  const sessionsDir = join(dir, ".myflow", ".runtime", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${contextKey}.json`), JSON.stringify({ current_task: pointer }));
}

/** Create a real task directory with a task.json. */
function makeTask(dir: string, slug: string): string {
  const taskDir = join(dir, ".myflow", "tasks", slug);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ status: "in_progress", title: slug }));
  return taskDir;
}

test("resolveActiveTaskStatus: an absolute current_task outside the tasks dir is not an active task", () => {
  const dir = makeProject();
  const outside = mkdtempSync(join(tmpdir(), "myflow-outside-"));
  writeFileSync(join(outside, "task.json"), JSON.stringify({ status: "in_progress", title: "Outside" }));
  try {
    writePointer(dir, "ctx-abs", outside);
    const result = resolveActiveTaskStatus(dir, "ctx-abs");
    assert.equal(result.status, "no_task");
    assert.equal(result.taskDir, null);
    assert.equal(result.taskTitle, null);
    assert.notEqual(result.status, "stale", "an escape must not be reported as a stale task");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveActiveTaskStatus: a `..` escape in current_task is not an active task", () => {
  const dir = makeProject();
  // A real task.json one level above tasks/, so a missing containment check
  // would actually resolve it instead of merely failing on a missing file.
  const escaped = join(dir, ".myflow", "escape");
  mkdirSync(escaped, { recursive: true });
  writeFileSync(join(escaped, "task.json"), JSON.stringify({ status: "in_progress", title: "Escaped" }));
  try {
    writePointer(dir, "ctx-dotdot", ".myflow/tasks/../escape");
    const result = resolveActiveTaskStatus(dir, "ctx-dotdot");
    assert.equal(result.status, "no_task");
    assert.equal(result.taskDir, null);
    assert.notEqual(result.status, "stale");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveActiveTaskStatus: a symlinked task dir that leaves tasks/ is not an active task", () => {
  const dir = makeProject();
  const outside = mkdtempSync(join(tmpdir(), "myflow-link-outside-"));
  writeFileSync(join(outside, "task.json"), JSON.stringify({ status: "in_progress", title: "Linked" }));
  const link = join(dir, ".myflow", "tasks", "linked");
  mkdirSync(join(dir, ".myflow", "tasks"), { recursive: true });
  try {
    try {
      symlinkSync(outside, link, "junction");
    } catch (error) {
      // Creating a symlink needs privileges that may be absent; the containment
      // invariant is still covered by the absolute and `..` cases above.
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") {
        return;
      }
      throw error;
    }
    writePointer(dir, "ctx-link", ".myflow/tasks/linked");
    const result = resolveActiveTaskStatus(dir, "ctx-link");
    assert.equal(result.status, "no_task", "a symlink out of tasks/ must be refused after realpath");
    assert.equal(result.taskDir, null);
    assert.notEqual(result.status, "stale");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveActiveTaskStatus: case-varied current_task follows the platform filesystem", () => {
  const dir = makeProject();
  makeTask(dir, "test-task");
  try {
    writePointer(dir, "ctx-case", ".MYFLOW/TASKS/TEST-TASK");
    const result = resolveActiveTaskStatus(dir, "ctx-case");
    if (process.platform === "win32") {
      // NTFS folds case, so the same directory is reached and is inside tasks/.
      assert.equal(result.status, "in_progress");
      assert.ok(result.taskDir);
    } else {
      // POSIX is case-sensitive: the path names a different, absent directory.
      assert.equal(result.status, "no_task");
      assert.equal(result.taskDir, null);
    }
    assert.notEqual(result.status, "stale");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TurnContextCache: a poisoned current_task yields the no_task block, not a stale task", () => {
  const dir = makeProject();
  writePointer(dir, "ctx-poisoned", "../outside-task");
  try {
    const cache = new TurnContextCache();
    cache.beginTurn(false);
    const result = cache.get(dir, "ctx-poisoned");
    assert.ok(result.workflowMsg.includes("[workflow-state:no_task]"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
