import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { resolveActiveTaskStatus } from "../.pi/extensions/myflow/turn-cache.ts";

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

test("task.py archive clears the active task pointer", () => {
  const root = makeProject();
  try {
    runTask(root, ["create", "Archived task", "--slug", "archived"], { PI_SESSION_ID: "arc" });
    runTask(root, ["start", ".myflow/tasks/archived"], { PI_SESSION_ID: "arc" });
    assert.equal(resolveActiveTaskStatus(root, "pi_arc").status, "in_progress");

    const archived = runTask(root, ["archive", ".myflow/tasks/archived"], { PI_SESSION_ID: "arc" });
    assert.match(archived, /^archived: .*archived/);
    assert.equal(resolveActiveTaskStatus(root, "pi_arc").status, "no_task");
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

test("get_context.py rejects unknown arguments instead of printing default output", () => {
  const root = makeProject();
  try {
    const rejected = spawnSync("python3", [GET_CONTEXT_PY, "--mode", "phase"], {
      cwd: root,
      encoding: "utf-8",
      env: { ...process.env, PI_SESSION_ID: "ctx-1" },
    });
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /unrecognized argument/);

    const accepted = spawnSync("python3", [GET_CONTEXT_PY, "--json"], {
      cwd: root,
      encoding: "utf-8",
      env: { ...process.env, PI_SESSION_ID: "ctx-1" },
    });
    assert.equal(accepted.status, 0);
    assert.ok(JSON.parse(accepted.stdout).blocks);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planning is reachable: task.py create points the session at the new task", () => {
  const root = makeProject();
  try {
    runTask(root, ["create", "Planning task", "--slug", "planning-task"], { PI_SESSION_ID: "plan-1" });

    // Before the fix the pointer stayed empty until `start`, so the extension
    // reported no_task for the whole planning phase and its block (jsonl gate
    // included) never reached the model.
    const sessionFile = join(root, ".myflow", ".runtime", "sessions", "pi_plan-1.json");
    assert.ok(existsSync(sessionFile), "create must materialize the session file");
    assert.ok(
      readFileSync(sessionFile, "utf-8").replaceAll("\\", "/").includes("tasks/planning-task"),
      "the session points at the new task",
    );

    const status = resolveActiveTaskStatus(root, "pi_plan-1");
    assert.equal(status.status, "planning");
    assert.equal(status.taskTitle, "Planning task");

    // Starting it moves the same session on to in_progress.
    runTask(root, ["start", ".myflow/tasks/planning-task"], { PI_SESSION_ID: "plan-1" });
    assert.equal(resolveActiveTaskStatus(root, "pi_plan-1").status, "in_progress");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task.py create never hijacks a session that is already on a task", () => {
  const root = makeProject();
  try {
    runTask(root, ["create", "First", "--slug", "first"], { PI_SESSION_ID: "plan-2" });
    runTask(root, ["start", ".myflow/tasks/first"], { PI_SESSION_ID: "plan-2" });
    runTask(root, ["create", "Second", "--slug", "second"], { PI_SESSION_ID: "plan-2" });

    const status = resolveActiveTaskStatus(root, "pi_plan-2");
    assert.equal(status.status, "in_progress");
    assert.ok(
      String(status.taskDir).replaceAll("\\", "/").endsWith("tasks/first"),
      "the active task stays the one being worked on",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// W2 / P0-4: the write side refuses to aim the session pointer outside
// `.myflow/tasks/`.
//
// The read side alone is not enough: myflow writes the pointer itself, so a
// poisoned ref (an absolute path, a `..` escape) would be re-created on every
// create/start/archive. `_relative()` no longer falls back to an absolute path
// and `_resolve_task_dir()` returns None outside the tasks tree, which every
// caller turns into a refusal. The invariant is containment, not "reject
// absolute paths": an absolute path that stays inside tasks/ is still valid.
// ---------------------------------------------------------------------------

function runTaskFailure(root: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("python3", [TASK_PY, ...args], {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  assert.notEqual(result.status, 0, `task.py ${args.join(" ")} must fail`);
  return result;
}

test("task.py start refuses a target outside .myflow/tasks/ and leaves the pointer alone", () => {
  const root = makeProject();
  const outside = mkdtempSync(join(tmpdir(), "myflow-outside-task-"));
  // A plausible task.json outside tasks/ (and one just above it) so a missing
  // containment check would resolve a real task instead of failing on absence.
  writeFileSync(join(outside, "task.json"), JSON.stringify({ status: "in_progress" }));
  mkdirSync(join(root, ".myflow", "escape"), { recursive: true });
  writeFileSync(join(root, ".myflow", "escape", "task.json"), JSON.stringify({ status: "in_progress" }));
  mkdirSync(join(root, "outside-root"), { recursive: true });
  writeFileSync(join(root, "outside-root", "task.json"), JSON.stringify({ status: "in_progress" }));
  try {
    runTask(root, ["create", "Guarded", "--slug", "guarded"], { PI_SESSION_ID: "guard-ptr" });
    const sessionFile = join(root, ".myflow", ".runtime", "sessions", "pi_guard-ptr.json");
    assert.equal(JSON.parse(readFileSync(sessionFile, "utf-8")).current_task, ".myflow/tasks/guarded");

    const escapes = [
      "..",
      "../..",
      ".myflow/tasks/../escape",
      ".myflow/tasks/../../outside-root",
      "../outside-project",
      outside,
    ];
    for (const target of escapes) {
      const result = runTaskFailure(root, ["start", target], { PI_SESSION_ID: "guard-ptr" });
      assert.match(result.stderr, /refusing to start/, `start ${target} must explain the refusal`);
    }

    // The escaped targets are refused, not written through; the pointer is
    // exactly where `create` left it and the task is still `planning`.
    assert.equal(JSON.parse(readFileSync(sessionFile, "utf-8")).current_task, ".myflow/tasks/guarded");
    assert.equal(resolveActiveTaskStatus(root, "pi_guard-ptr").status, "planning");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("task.py archive refuses a target outside .myflow/tasks/", () => {
  const root = makeProject();
  const outside = mkdtempSync(join(tmpdir(), "myflow-outside-archive-"));
  writeFileSync(join(outside, "task.json"), JSON.stringify({ status: "in_progress" }));
  try {
    const result = runTaskFailure(root, ["archive", outside]);
    assert.match(result.stderr, /refusing to archive/);
    assert.ok(existsSync(join(outside, "task.json")), "a refused archive must not move the dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("task.py start accepts an absolute target that stays inside .myflow/tasks/", () => {
  const root = makeProject();
  try {
    runTask(root, ["create", "Absolute task", "--slug", "abs-task"], { PI_SESSION_ID: "abs-ptr" });
    // Containment, not absolute-path rejection: this absolute path is inside
    // tasks/, so it is a legitimate target.
    runTask(root, ["start", join(root, ".myflow", "tasks", "abs-task")], { PI_SESSION_ID: "abs-ptr" });
    assert.equal(resolveActiveTaskStatus(root, "pi_abs-ptr").status, "in_progress");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task.py start with a case-varied target follows the platform filesystem", () => {
  const root = makeProject();
  try {
    runTask(root, ["create", "Case task", "--slug", "case-task"], { PI_SESSION_ID: "case-ptr" });
    const result = spawnSync("python3", [TASK_PY, "start", ".MYFLOW/TASKS/CASE-TASK"], {
      cwd: root,
      encoding: "utf-8",
      env: { ...process.env, PI_SESSION_ID: "case-ptr" },
    });
    const sessionFile = join(root, ".myflow", ".runtime", "sessions", "pi_case-ptr.json");
    if (process.platform === "win32") {
      // NTFS folds case: the same directory is reached, and the pointer stays
      // inside tasks/ whichever casing was typed.
      assert.equal(result.status, 0, result.stderr);
      const pointer = JSON.parse(readFileSync(sessionFile, "utf-8")).current_task as string;
      assert.equal(pointer.replaceAll("\\", "/").toLowerCase(), ".myflow/tasks/case-task");
    } else {
      // POSIX is case-sensitive: the case-varied path is a different, absent
      // directory, so the start is rejected.
      assert.notEqual(result.status, 0, "POSIX is case-sensitive: the target does not exist");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
