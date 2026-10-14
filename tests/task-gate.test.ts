import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { resolveActiveTaskStatus } from "../.pi/extensions/myflow/turn-cache.ts";

/**
 * W3 / P0-1: the empty-context gate.
 *
 * `create` seeds empty `implement.jsonl` / `check.jsonl`, then `validate`
 * treats "0 curated entries" as a failure, and `start` refuses a
 * seeded-but-uncurated task unless `--allow-empty-context` is passed. An absent
 * manifest is *not* gated — that asymmetry is what this suite pins,
 * because gating absence would strand every pre-seed task in this repository.
 *
 * `add-context` is the write side without which the gate would be impossible
 * to satisfy: it appends `{file, reason}` rows, the same shape the injection
 * materializes.
 */

const ROOT = join(import.meta.dirname, "..");
const TASK_PY = join(ROOT, ".myflow", "scripts", "task.py");

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-gate-"));
  mkdirSync(join(root, ".myflow"), { recursive: true });
  writeFileSync(
    join(root, ".myflow", "workflow.md"),
    "[workflow-state:no_task]\nnone\n[/workflow-state:no_task]\n",
  );
  return root;
}

/**
 * A per-call env with the harness's own context identity removed, so
 * `PI_SESSION_ID` (not a leaked `MYFLOW_CONTEXT_ID`) names the session file.
 */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.MYFLOW_CONTEXT_ID;
  delete env.MYFLOW_AGENT_TYPE;
  return env;
}

function run(root: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("python3", [TASK_PY, ...args], {
    cwd: root,
    encoding: "utf-8",
    env: cleanEnv(env),
  }).trim();
}

function runResult(root: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync("python3", [TASK_PY, ...args], {
    cwd: root,
    encoding: "utf-8",
    env: cleanEnv(env),
  });
}

function sessionFile(root: string, key: string): string {
  return join(root, ".myflow", ".runtime", "sessions", `pi_${key}.json`);
}

test("task.py create seeds empty implement.jsonl and check.jsonl", () => {
  const root = makeProject();
  try {
    run(root, ["create", "Seeded", "--slug", "seeded"], { PI_SESSION_ID: "gate-seed" });
    const taskDir = join(root, ".myflow", "tasks", "seeded");
    for (const name of ["implement.jsonl", "check.jsonl"]) {
      assert.ok(existsSync(join(taskDir, name)), `${name} must be seeded by create`);
      assert.equal(readFileSync(join(taskDir, name), "utf-8"), "", `${name} must start empty`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task.py start refuses a seeded-but-uncurated task with an actionable hint", () => {
  const root = makeProject();
  try {
    run(root, ["create", "Uncurated", "--slug", "uncurated"], { PI_SESSION_ID: "gate-1" });

    const result = runResult(root, ["start", ".myflow/tasks/uncurated"], { PI_SESSION_ID: "gate-1" });
    assert.notEqual(result.status, 0, "a seeded-but-uncurated task must not start");
    assert.match(result.stderr, /no curated entries/);
    assert.match(result.stderr, /add-context/, "the hint must name the write entry");
    assert.match(result.stderr, /--allow-empty-context/, "the hint must name the escape hatch");

    // Refused, not half-started: status and pointer are untouched.
    const task = JSON.parse(readFileSync(join(root, ".myflow", "tasks", "uncurated", "task.json"), "utf-8"));
    assert.equal(task.status, "planning");
    const session = JSON.parse(readFileSync(sessionFile(root, "gate-1"), "utf-8"));
    assert.equal(String(session.current_task).replaceAll("\\", "/"), ".myflow/tasks/uncurated");
    assert.equal(resolveActiveTaskStatus(root, "pi_gate-1").status, "planning");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--allow-empty-context bypasses the empty-manifest gate", () => {
  const root = makeProject();
  try {
    run(root, ["create", "Bypassed", "--slug", "bypassed"], { PI_SESSION_ID: "gate-2" });
    const result = runResult(
      root,
      ["start", ".myflow/tasks/bypassed", "--allow-empty-context"],
      { PI_SESSION_ID: "gate-2" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(resolveActiveTaskStatus(root, "pi_gate-2").status, "in_progress");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing manifest is not gated; only seeded-but-uncurated is", () => {
  const root = makeProject();
  try {
    // The pre-seed layout: task.json with no jsonl at all.
    const taskDir = join(root, ".myflow", "tasks", "legacy");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "task.json"), JSON.stringify({ title: "Legacy", status: "planning" }));

    const result = runResult(root, ["start", ".myflow/tasks/legacy"], { PI_SESSION_ID: "gate-missing" });
    assert.equal(result.status, 0, `an absent manifest must not gate: ${result.stderr}`);
    assert.equal(resolveActiveTaskStatus(root, "pi_gate-missing").status, "in_progress");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add-context writes a reason-bearing entry and does not duplicate it", () => {
  const root = makeProject();
  try {
    run(root, ["create", "Curated", "--slug", "curated"], { PI_SESSION_ID: "gate-3" });
    writeFileSync(join(root, "spec-notes.md"), "notes\n");

    run(root, ["add-context", ".myflow/tasks/curated", "implement", "spec-notes.md", "why it matters"], {
      PI_SESSION_ID: "gate-3",
    });
    const manifest = join(root, ".myflow", "tasks", "curated", "implement.jsonl");
    const row = JSON.parse(readFileSync(manifest, "utf-8").trim());
    assert.deepEqual(row, { file: "spec-notes.md", reason: "why it matters" });

    run(root, ["add-context", ".myflow/tasks/curated", "implement", "spec-notes.md", "again"], {
      PI_SESSION_ID: "gate-3",
    });
    assert.equal(readFileSync(manifest, "utf-8").trim().split(/\r?\n/).length, 1, "the entry is not duplicated");

    // Curate the second manifest too: a directory entry round-trips.
    mkdirSync(join(root, "specs"), { recursive: true });
    run(root, ["add-context", ".myflow/tasks/curated", "check", "specs", "the specs dir"], {
      PI_SESSION_ID: "gate-3",
    });
    const checkRow = JSON.parse(readFileSync(join(root, ".myflow", "tasks", "curated", "check.jsonl"), "utf-8").trim());
    assert.deepEqual(checkRow, { file: "specs/", type: "directory", reason: "the specs dir" });

    // With both manifests curated, `start` succeeds without the escape hatch.
    const started = runResult(root, ["start", ".myflow/tasks/curated"], { PI_SESSION_ID: "gate-3" });
    assert.equal(started.status, 0, started.stderr);
    assert.equal(resolveActiveTaskStatus(root, "pi_gate-3").status, "in_progress");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task.py add-context refuses an entry that escapes the manifest name or path", () => {
  const root = makeProject();
  try {
    run(root, ["create", "Guarded", "--slug", "guarded"], { PI_SESSION_ID: "gate-4" });
    const badAction = runResult(root, ["add-context", ".myflow/tasks/guarded", "../escape", "spec-notes.md"], {
      PI_SESSION_ID: "gate-4",
    });
    assert.notEqual(badAction.status, 0);
    assert.match(badAction.stderr, /must be 'implement' or 'check'/);

    const missing = runResult(root, ["add-context", ".myflow/tasks/guarded", "implement", "does-not-exist.md"], {
      PI_SESSION_ID: "gate-4",
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /path not found/);
    assert.equal(readFileSync(join(root, ".myflow", "tasks", "guarded", "implement.jsonl"), "utf-8"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task.py validate fails a seeded empty manifest and a missing referenced file", () => {
  const root = makeProject();
  try {
    run(root, ["create", "Validate me", "--slug", "validate-me"], { PI_SESSION_ID: "gate-5" });
    const taskDir = join(root, ".myflow", "tasks", "validate-me");

    const empty = runResult(root, ["validate", ".myflow/tasks/validate-me"], { PI_SESSION_ID: "gate-5" });
    assert.equal(empty.status, 1, "0 curated entries must fail validation");
    assert.match(empty.stdout, /no curated entries/);

    // A curated row whose file does not exist is a hard error, not a pass.
    writeFileSync(join(taskDir, "implement.jsonl"), '{"file": "gone.md", "reason": "x"}\n');
    const broken = runResult(root, ["validate", ".myflow/tasks/validate-me"], { PI_SESSION_ID: "gate-5" });
    assert.equal(broken.status, 1);
    assert.match(broken.stdout, /file not found/);

    // A curated row whose file exists passes.
    writeFileSync(join(root, "real.md"), "real\n");
    writeFileSync(join(taskDir, "implement.jsonl"), '{"file": "real.md", "reason": "x"}\n');
    writeFileSync(join(taskDir, "check.jsonl"), '{"file": "real.md", "reason": "x"}\n');
    const ok = runResult(root, ["validate", ".myflow/tasks/validate-me"], { PI_SESSION_ID: "gate-5" });
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /all validations passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task.py finish clears the pointer without changing status or location", () => {
  const root = makeProject();
  try {
    run(root, ["create", "Finishable", "--slug", "finishable"], { PI_SESSION_ID: "gate-fin" });
    run(root, ["start", ".myflow/tasks/finishable", "--allow-empty-context"], { PI_SESSION_ID: "gate-fin" });
    const taskDir = join(root, ".myflow", "tasks", "finishable");

    const result = runResult(root, ["finish"], { PI_SESSION_ID: "gate-fin" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cleared active task/);
    assert.equal(resolveActiveTaskStatus(root, "pi_gate-fin").status, "no_task");

    // The task itself is untouched: same place, still in_progress.
    assert.ok(existsSync(taskDir), "finish must not move the task");
    assert.equal(JSON.parse(readFileSync(join(taskDir, "task.json"), "utf-8")).status, "in_progress");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task.py finish with no active task reports it and exits 0", () => {
  const root = makeProject();
  try {
    const result = runResult(root, ["finish"], { PI_SESSION_ID: "gate-none" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no active task/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
