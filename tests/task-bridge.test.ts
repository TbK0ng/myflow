import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { resolveActiveTaskStatus } from "../src/turn-cache.ts";

const ROOT = join(import.meta.dirname, "..");
const TASK_PY = join(ROOT, ".myflow", "scripts", "task.py");

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-bridge-"));
  mkdirSync(join(root, ".myflow"), { recursive: true });
  return root;
}

function runTask(root: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("python3", [TASK_PY, ...args], {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  }).trim();
}

test("shell/session bridge: PI_SESSION_ID names the session file", () => {
  const root = makeProject();
  try {
    runTask(root, ["create", "Demo task", "--slug", "demo"], { PI_SESSION_ID: "abc-123" });
    runTask(root, ["start", ".myflow/tasks/demo"], { PI_SESSION_ID: "abc-123" });

    const sessionFile = join(root, ".myflow", ".runtime", "sessions", "pi_abc-123.json");
    assert.ok(existsSync(sessionFile), "session file must be named pi_<PI_SESSION_ID>.json");
    const session = JSON.parse(readFileSync(sessionFile, "utf-8"));
    assert.match(session.current_task, /tasks[\\/]demo$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell/session bridge: extension resolves the task written by task.py", () => {
  const root = makeProject();
  try {
    runTask(root, ["create", "Bridge task", "--slug", "bridge"], { PI_SESSION_ID: "session-xyz" });
    runTask(root, ["start", ".myflow/tasks/bridge"], { PI_SESSION_ID: "session-xyz" });

    // This is exactly what deriveContextKey produces for that Pi session.
    const result = resolveActiveTaskStatus(root, "pi_session-xyz");
    assert.equal(result.status, "in_progress");
    assert.equal(result.taskTitle, "Bridge task");
    assert.ok(result.taskDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell/session bridge: MYFLOW_CONTEXT_ID overrides PI_SESSION_ID", () => {
  const root = makeProject();
  try {
    runTask(root, ["create", "Override task", "--slug", "override"]);
    runTask(root, ["start", ".myflow/tasks/override"], {
      PI_SESSION_ID: "should-be-ignored",
      MYFLOW_CONTEXT_ID: "pi_explicit",
    });
    const sessionFile = join(root, ".myflow", ".runtime", "sessions", "pi_explicit.json");
    assert.ok(existsSync(sessionFile));
    assert.ok(!existsSync(join(root, ".myflow", ".runtime", "sessions", "pi_should-be-ignored.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task.py finish clears the active task", () => {
  const root = makeProject();
  try {
    runTask(root, ["create", "Finish task", "--slug", "finish"], { PI_SESSION_ID: "fin" });
    runTask(root, ["start", ".myflow/tasks/finish"], { PI_SESSION_ID: "fin" });
    const finished = runTask(root, ["finish"], { PI_SESSION_ID: "fin" });
    assert.equal(finished, "finished");
    const result = resolveActiveTaskStatus(root, "pi_fin");
    assert.equal(result.status, "no_task");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
