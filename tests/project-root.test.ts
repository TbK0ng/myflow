import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
const SCRIPTS = join(ROOT, ".myflow", "scripts");

interface Project {
  root: string;
  home: string;
}

function makeProject(): Project {
  const base = mkdtempSync(join(tmpdir(), "myflow-root-"));
  const root = join(base, "project");
  mkdirSync(join(root, ".myflow"), { recursive: true });
  mkdirSync(join(base, "home"), { recursive: true });
  writeFileSync(join(root, ".myflow", "workflow.md"), "[workflow-state:no_task]\nnone\n[/workflow-state:no_task]\n");
  return { root, home: join(base, "home") };
}

function cleanup(project: Project): void {
  rmSync(join(project.root, ".."), { recursive: true, force: true });
}

function run(project: Project, script: string, args: string[], cwd = project.root): string {
  // start calls in this suite exercise project-root resolution, not the
  // plan-approval gate (tests/plan-approval-gate.test.ts), so they pass
  // --allow-empty-context --allow-unapproved to reach `start` itself.
  return execFileSync("python3", [join(SCRIPTS, script), ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, USERPROFILE: project.home, HOME: project.home, PI_SESSION_ID: "root-probe" },
    timeout: 60_000,
  }).trim();
}

function deep(root: string): string {
  const dir = join(root, "src", "nested", "deep");
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("task.py resolves the project root from a subdirectory", () => {
  const project = makeProject();
  try {
    run(project, "task.py", ["create", "Rooted task", "--slug", "rooted"]);
    run(project, "task.py", ["start", ".myflow/tasks/rooted", "--allow-empty-context", "--allow-unapproved"]);

    const fromDeep = run(project, "task.py", ["current"], deep(project.root));
    assert.match(fromDeep, /rooted|Rooted task/);
    assert.ok(
      existsSync(join(project.root, ".myflow", "tasks", "rooted")),
      "the task belongs to the project root, not to the subdirectory",
    );
    assert.ok(!existsSync(join(project.root, "src", ".myflow")), "no .myflow is created in the subdirectory");
  } finally {
    cleanup(project);
  }
});

test("get_context.py reads the same state from a subdirectory", () => {
  const project = makeProject();
  try {
    run(project, "task.py", ["create", "Context task", "--slug", "contextual"]);
    run(project, "task.py", ["start", ".myflow/tasks/contextual", "--allow-empty-context", "--allow-unapproved"]);

    const atRoot = JSON.parse(run(project, "get_context.py", ["--json"]));
    const atDeep = JSON.parse(run(project, "get_context.py", ["--json"], deep(project.root)));

    assert.equal(atDeep.current_task?.title, "Context task");
    assert.deepEqual(atDeep.blocks, atRoot.blocks);
  } finally {
    cleanup(project);
  }
});

test("channel.py keys the store by the project root, not the cwd", () => {
  const project = makeProject();
  try {
    run(project, "channel.py", ["create", "rooted-channel"]);
    const buckets = readdirSync(join(project.home, ".pi", "myflow", "channels"));
    assert.equal(buckets.length, 1, "exactly one project bucket exists");

    // A second create from a subdirectory must land in that same bucket, which
    // it can only do if both runs resolved one project root.
    const fromDeep = run(project, "channel.py", ["list"], deep(project.root));
    assert.match(fromDeep, /^rooted-channel\tproject\t0 event\(s\)$/m);
    assert.equal(readdirSync(join(project.home, ".pi", "myflow", "channels")).length, 1);
  } finally {
    cleanup(project);
  }
});

test("worktree.py reads the root config from a subdirectory", () => {
  const project = makeProject();
  try {
    writeFileSync(join(project.root, ".myflow", "worktree.yaml"), "worktree_dir: ../trees\n");
    const atRoot = run(project, "worktree.py", ["config"]);
    const atDeep = run(project, "worktree.py", ["config"], deep(project.root));

    assert.equal(atDeep, atRoot);
    assert.match(atDeep, /trees/);
    assert.ok(!existsSync(join(project.root, "src", ".myflow", "worktree.yaml")), "no config is read from the subdirectory");
  } finally {
    cleanup(project);
  }
});

test("a bare .myflow above the cwd does not capture the project root", () => {
  const base = mkdtempSync(join(tmpdir(), "myflow-stray-"));
  const parent = join(base, "parent");
  const child = join(parent, "child");
  const home = join(base, "home");
  // The parent carries a .myflow without workflow.md: a stray directory, not a
  // harness project, and there is no project above it either.
  mkdirSync(join(parent, ".myflow", "channels"), { recursive: true });
  mkdirSync(child, { recursive: true });
  mkdirSync(home, { recursive: true });
  try {
    run({ root: child, home }, "task.py", ["create", "Child task", "--slug", "child-task"], child);
    assert.ok(existsSync(join(child, ".myflow", "tasks", "child-task")), "the task lands in the cwd");
    assert.ok(
      !existsSync(join(parent, ".myflow", "tasks")),
      "the stray .myflow must not receive the task",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the nearest project above wins over a further one", () => {
  const project = makeProject();
  try {
    const inner = join(project.root, "inner");
    mkdirSync(join(inner, ".myflow"), { recursive: true });
    writeFileSync(join(inner, ".myflow", "workflow.md"), "[workflow-state:no_task]\nnone\n[/workflow-state:no_task]\n");

    run(project, "task.py", ["create", "Inner task", "--slug", "inner-task"], inner);
    assert.ok(existsSync(join(inner, ".myflow", "tasks", "inner-task")), "the inner project wins");
    assert.ok(!existsSync(join(project.root, ".myflow", "tasks")), "the outer project is untouched");
    assert.match(readFileSync(join(inner, ".myflow", "tasks", "inner-task", "task.json"), "utf-8"), /Inner task/);
  } finally {
    cleanup(project);
  }
});
