import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { resolveActiveTaskStatus } from "../src/turn-cache.ts";

const ROOT = join(import.meta.dirname, "..");
const TASK_PY = join(ROOT, ".myflow", "scripts", "task.py");
const GET_CONTEXT_PY = join(ROOT, ".myflow", "scripts", "get_context.py");

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

test("task.py current --source and --json", () => {
  const root = makeProject();
  try {
    runTask(root, ["create", "Source task", "--slug", "src"], { PI_SESSION_ID: "src-1" });
    runTask(root, ["start", ".myflow/tasks/src"], { PI_SESSION_ID: "src-1" });

    const text = runTask(root, ["current", "--source"], { PI_SESSION_ID: "src-1" });
    assert.match(text, /^\.myflow\/tasks\/src\tin_progress\tSource task\tsource:context:pi_src-1$/);

    const json = JSON.parse(runTask(root, ["current", "--json"], { PI_SESSION_ID: "src-1" }));
    assert.equal(json.current_task, ".myflow/tasks/src");
    assert.equal(json.status, "in_progress");
    assert.equal(json.title, "Source task");
    assert.equal(json.source, "context:pi_src-1");
    assert.equal(json.stale, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task.py list --status filters tasks", () => {
  const root = makeProject();
  try {
    runTask(root, ["create", "Active", "--slug", "active"], { PI_SESSION_ID: "list-1" });
    runTask(root, ["create", "Planned", "--slug", "planned"], { PI_SESSION_ID: "list-1" });
    runTask(root, ["start", ".myflow/tasks/active"], { PI_SESSION_ID: "list-1" });

    const inProgress = runTask(root, ["list", "--status", "in_progress"], { PI_SESSION_ID: "list-1" });
    assert.match(inProgress, /^active\tin_progress\tActive$/m);
    assert.ok(!inProgress.includes("planned"));

    const planning = runTask(root, ["list", "--status", "planning"], { PI_SESSION_ID: "list-1" });
    assert.match(planning, /^planned\tplanning\tPlanned$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task.py archive moves the task and clears the session pointer", () => {
  const root = makeProject();
  try {
    runTask(root, ["create", "Archive me", "--slug", "arch"], { PI_SESSION_ID: "arch-1" });
    runTask(root, ["start", ".myflow/tasks/arch"], { PI_SESSION_ID: "arch-1" });

    const output = runTask(root, ["archive", ".myflow/tasks/arch"], { PI_SESSION_ID: "arch-1" });
    assert.match(output, /^archived: \.myflow\/archive\/\d{4}-\d{2}\/arch/);
    assert.ok(!existsSync(join(root, ".myflow", "tasks", "arch")), "task must leave tasks/");

    const archivedJson = readdirSync(join(root, ".myflow", "archive"))
      .map((month) => join(root, ".myflow", "archive", month, "arch", "task.json"))
      .find((file) => existsSync(file));
    assert.ok(archivedJson, "archived task.json must exist");
    assert.equal(JSON.parse(readFileSync(archivedJson!, "utf-8")).status, "completed");

    assert.equal(resolveActiveTaskStatus(root, "pi_arch-1").status, "no_task");
    assert.match(runTask(root, ["list-archive"], { PI_SESSION_ID: "arch-1" }), /arch\tcompleted\tArchive me/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("get_context.py reports session runtime context and the active task", () => {
  const root = makeProject();
  try {
    writeFileSync(
      join(root, ".myflow", "workflow.md"),
      [
        "[workflow-state:no_task]",
        "No active task.",
        "[/workflow-state:no_task]",
        "",
        "[workflow-state:in_progress]",
        "Write the code.",
        "[/workflow-state:in_progress]",
      ].join("\n"),
    );
    runTask(root, ["create", "Ctx task", "--slug", "ctx"], { PI_SESSION_ID: "ctx-1" });
    runTask(root, ["start", ".myflow/tasks/ctx"], { PI_SESSION_ID: "ctx-1" });

    const env = { ...process.env, PI_SESSION_ID: "ctx-1" };
    const text = execFileSync("python3", [GET_CONTEXT_PY], { cwd: root, encoding: "utf-8", env });
    assert.match(text, /\[workflow-state:in_progress\]/);
    assert.match(text, /## Session Runtime Context/);
    assert.match(text, /CURRENT TASK: \.myflow\/tasks\/ctx \(in_progress\) — Ctx task/);
    assert.match(text, /GIT: not a repository \(or git unavailable\)/);

    const json = JSON.parse(execFileSync("python3", [GET_CONTEXT_PY, "--json"], { cwd: root, encoding: "utf-8", env }));
    assert.equal(json.current_task.status, "in_progress");
    assert.equal(json.current_task.source, "context:pi_ctx-1");
    assert.equal(json.blocks.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("get_context.py rejects unsupported modes instead of returning unrelated output", () => {
  const root = makeProject();
  try {
    const rejected = spawnSync("python3", [GET_CONTEXT_PY, "--mode", "phase"], {
      cwd: root,
      encoding: "utf-8",
      env: { ...process.env },
    });
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /unsupported --mode 'phase'/);
    assert.equal(rejected.stdout.trim(), "");

    const accepted = spawnSync("python3", [GET_CONTEXT_PY, "--mode", "default"], {
      cwd: root,
      encoding: "utf-8",
      env: { ...process.env },
    });
    assert.equal(accepted.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
