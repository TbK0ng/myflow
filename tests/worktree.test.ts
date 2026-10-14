import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn, spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
const WORKTREE_PY = join(ROOT, ".myflow", "scripts", "worktree.py");

interface Project {
  root: string;
  worktrees: string;
}

function makeRepo(config?: string): Project {
  const base = mkdtempSync(join(tmpdir(), "myflow-wt-"));
  const root = join(base, "project");
  const worktrees = join(base, "worktrees");
  mkdirSync(join(root, ".myflow", "scripts"), { recursive: true });
  cpSync(WORKTREE_PY, join(root, ".myflow", "scripts", "worktree.py"));
  writeFileSync(join(root, "app.txt"), "hello\n");
  writeFileSync(join(root, ".myflow", "keep.txt"), "copied\n");
  if (config) writeFileSync(join(root, ".myflow", "worktree.yaml"), config, "utf-8");
  execFileSync("git", ["init", "-q"], { cwd: root, encoding: "utf-8" });
  execFileSync("git", ["add", "-A"], { cwd: root, encoding: "utf-8" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@l", "commit", "-qm", "init"], {
    cwd: root,
    encoding: "utf-8",
  });
  return { root, worktrees };
}

function worktree(project: Project, args: string[], expectFailure = false): string {
  try {
    return execFileSync("python3", [join(project.root, ".myflow", "scripts", "worktree.py"), ...args], {
      cwd: project.root,
      encoding: "utf-8",
      env: { ...process.env, PI_SESSION_ID: "" },
    }).trim();
  } catch (error) {
    if (!expectFailure) throw error;
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim();
  }
}

function cleanup(project: Project): void {
  // A detached launch can still hold the worktree directory as its cwd for a
  // moment on Windows, so retry instead of failing the test in teardown.
  rmSync(join(project.root, ".."), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test("worktree config: defaults and file values", () => {
  const plain = makeRepo();
  try {
    assert.match(worktree(plain, ["config"]), /worktree_dir: \.\.\/worktrees/);
    assert.match(worktree(plain, ["config"]), /verify: \(none\)/);
  } finally {
    cleanup(plain);
  }

  const configured = makeRepo(
    [
      "worktree_dir: ../worktrees",
      "copy:",
      "  - .myflow/keep.txt",
      "post_create:",
      "  - node --version",
      "verify:",
      "  - node --version",
    ].join("\n") + "\n",
  );
  try {
    const json = JSON.parse(worktree(configured, ["config", "--json"]));
    assert.equal(json.worktree_dir, "../worktrees");
    assert.deepEqual(json.copy, [".myflow/keep.txt"]);
    assert.deepEqual(json.post_create, ["node --version"]);
    assert.deepEqual(json.verify, ["node --version"]);
  } finally {
    cleanup(configured);
  }
});

test("worktree create: branch, copied files, and registry record", () => {
  const project = makeRepo(
    ["worktree_dir: ../worktrees", "copy:", "  - .myflow/keep.txt", "post_create:", "  - node --version"].join("\n") + "\n",
  );
  try {
    const output = worktree(project, ["create", "alpha"]);
    assert.match(output, /created: /);
    assert.match(output, /branch:  myflow\/alpha/);
    assert.match(output, /copied:  \.myflow\/keep\.txt/);

    const target = join(project.worktrees, "alpha");
    assert.ok(existsSync(join(target, "app.txt")), "the branch checkout is present");
    assert.ok(existsSync(join(target, ".myflow", "keep.txt")), "configured files are copied");
    const branches = execFileSync("git", ["branch", "--list", "myflow/alpha"], { cwd: project.root, encoding: "utf-8" });
    assert.match(branches, /myflow\/alpha/);

    const listed = worktree(project, ["list", "--json"]);
    const sessions = JSON.parse(listed).sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].name, "alpha");
    assert.equal(sessions[0].exists, true);
  } finally {
    cleanup(project);
  }
});

test("worktree create: refuses an existing path and outside a repository", () => {
  const project = makeRepo("worktree_dir: ../worktrees\n");
  try {
    worktree(project, ["create", "dup"]);
    assert.match(worktree(project, ["create", "dup"], true), /already exists/);
  } finally {
    cleanup(project);
  }

  const outside = mkdtempSync(join(tmpdir(), "myflow-nowt-"));
  mkdirSync(join(outside, ".myflow", "scripts"), { recursive: true });
  cpSync(WORKTREE_PY, join(outside, ".myflow", "scripts", "worktree.py"));
  try {
    assert.match(worktree({ root: outside, worktrees: outside }, ["create", "x"], true), /not inside a git repository/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("worktree verify: exit code follows the configured commands", () => {
  const failing = makeRepo("verify:\n  - node --version\n  - node -e \"process.exit(1)\"\n");
  try {
    const output = worktree(failing, ["verify"], true);
    assert.match(output, /FAIL: node -e/);
    const json = JSON.parse(worktree(failing, ["verify", "--json"], true));
    assert.equal(json.failed, true);
    assert.deepEqual(
      json.verify.map((entry: { exit_code: number }) => entry.exit_code),
      [0, 1],
    );
  } finally {
    cleanup(failing);
  }

  const passing = makeRepo("verify:\n  - node --version\n");
  try {
    assert.match(worktree(passing, ["verify"]), /verify passed/);
  } finally {
    cleanup(passing);
  }

  const none = makeRepo();
  try {
    assert.match(worktree(none, ["verify"]), /no verify commands configured/);
  } finally {
    cleanup(none);
  }
});

test("worktree remove and prune: clean up the worktree and the registry", () => {
  const project = makeRepo("worktree_dir: ../worktrees\n");
  try {
    worktree(project, ["create", "beta"]);
    const target = join(project.worktrees, "beta");
    assert.ok(existsSync(target));

    const removed = worktree(project, ["remove", "beta", "--force"]);
    assert.match(removed, /removed: /);
    assert.ok(!existsSync(target), "the worktree directory is gone");
    assert.match(worktree(project, ["list"]), /no worktree sessions/);

    // A session whose directory vanished is dropped by prune.
    worktree(project, ["create", "gamma"]);
    rmSync(join(project.worktrees, "gamma"), { recursive: true, force: true });
    assert.match(worktree(project, ["prune"]), /pruned: 1 stale session/);
  } finally {
    cleanup(project);
  }
});

test("worktree start: rejects a missing prompt before touching git", () => {
  const project = makeRepo("worktree_dir: ../worktrees\n");
  try {
    const result = spawnSync("python3", [WORKTREE_PY, "start", "delta"], {
      cwd: project.root,
      encoding: "utf-8",
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}`, /--prompt/);
  } finally {
    cleanup(project);
  }
});

test("worktree registry lives under .myflow/.runtime and survives reads", () => {
  const project = makeRepo("worktree_dir: ../worktrees\n");
  try {
    worktree(project, ["create", "epsilon"]);
    const registry = JSON.parse(
      readFileSync(join(project.root, ".myflow", ".runtime", "worktrees.json"), "utf-8"),
    );
    assert.equal(registry.sessions[0].name, "epsilon");
    assert.equal(registry.sessions[0].branch, "myflow/epsilon");
  } finally {
    cleanup(project);
  }
});

test("worktree start --dry-run: plans a delegated session without touching git", () => {
  const project = makeRepo("worktree_dir: ../worktrees\n");
  try {
    const planned = JSON.parse(
      worktree(project, [
        "start",
        "zeta",
        "--prompt",
        "do the work",
        "--task",
        ".myflow/tasks/demo",
        "--dry-run",
      ]),
    );
    assert.match(planned.session_id, /^myflow-zeta-\d{4}-\d{6}-\d{3}$/, "each plan carries a fresh session id");
    assert.equal(planned.env.MYFLOW_SKIP_BREADCRUMB, "1");
    assert.ok(planned.command.includes("--session-id"));
    const plannedPrompt = String(planned.command[planned.command.length - 1]);
    assert.match(plannedPrompt, /^Active task: \.myflow\/tasks\/demo/);
    // Nobody is watching a detached session, so the work order says who owns the
    // task lifecycle; without it the session stops to ask for task consent.
    assert.match(plannedPrompt, /Delegated work order: nobody is watching/);
    assert.match(plannedPrompt, /Do not create or\nmanage myflow tasks/);
    assert.match(plannedPrompt, /do the work$/);
    assert.ok(!existsSync(join(project.worktrees, "zeta")), "dry-run must not create the worktree");
    assert.ok(!existsSync(join(project.root, ".myflow", ".runtime", "worktrees.json")), "dry-run must not register a session");
  } finally {
    cleanup(project);
  }
});

function fakePi(binDir: string): string {
  // A stand-in for the pi binary: it records its own command line, so the
  // launch path can be tested without a model call.
  const capture = join(binDir, "args.txt");
  writeFileSync(join(binDir, "pi"), '#!/bin/sh\nprintf "%s\\n" "$*" > "$FAKE_PI_ARGS"\n', { mode: 0o755 });
  writeFileSync(join(binDir, "pi.cmd"), '@echo off\r\necho %* > "%FAKE_PI_ARGS%"\r\n');
  return capture;
}

function startWithFakePi(project: Project, args: string[], binDir: string, capture: string): string {
  return execFileSync("python3", [join(project.root, ".myflow", "scripts", "worktree.py"), ...args], {
    cwd: project.root,
    encoding: "utf-8",
    env: {
      ...process.env,
      PI_SESSION_ID: "",
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_PI_ARGS: capture,
    },
    timeout: 60_000,
  }).trim();
}

test("worktree create: copied inputs stay out of the worktree git status", () => {
  const project = makeRepo("worktree_dir: ../worktrees\ncopy:\n  - .myflow/tasks\n");
  try {
    mkdirSync(join(project.root, ".myflow", "tasks", "t"), { recursive: true });
    writeFileSync(join(project.root, ".myflow", "tasks", "t", "note.md"), "work order\n");
    worktree(project, ["create", "copied"]);
    const target = join(project.worktrees, "copied");
    assert.ok(existsSync(join(target, ".myflow", "tasks", "t", "note.md")), "the copy lands in the worktree");

    // Inputs for the session, not part of its branch: without this, git add -A
    // stages them and merging the branch into the main tree aborts because the
    // same paths exist there untracked.
    const status = execFileSync("git", ["status", "--short"], { cwd: target, encoding: "utf-8" }).trim();
    assert.ok(!status.includes(".myflow/tasks"), `copied inputs must not appear in git status, got: ${status}`);
    const addDryRun = execFileSync("git", ["add", "-A", "--dry-run"], { cwd: target, encoding: "utf-8" }).trim();
    assert.ok(!addDryRun.includes(".myflow/tasks"), `git add -A must not stage copied inputs, got: ${addDryRun}`);
  } finally {
    cleanup(project);
  }
});

test("worktree start: every launch mints a fresh session id", () => {
  const project = makeRepo("worktree_dir: ../worktrees\n");
  const binDir = join(project.root, "..", "bin");
  mkdirSync(binDir, { recursive: true });
  const capture = fakePi(binDir);
  try {
    // The id is asserted through the registry and the printed plan rather than
    // through the child argv: a .cmd shim cannot observe a multi-line argument
    // (cmd splits on the newline), and the delegated work order is multi-line.
    const first = startWithFakePi(project, ["start", "real", "--prompt", "do the work"], binDir, capture);
    const firstId = first.match(/session (\S+)\)/)?.[1] ?? "";
    assert.match(firstId, /^myflow-real-\d{4}-\d{6}-\d{3}$/);
    assert.ok(first.includes(`resume:   pi --resume ${firstId}`), "the resume command is printed");
    assert.equal(
      JSON.parse(worktree(project, ["list", "--json"])).sessions[0].session_id,
      firstId,
      "the session id is recorded in the registry",
    );

    // Same name in a new worktree: the path that used to resume the old
    // conversation instead of starting a new one.
    worktree(project, ["remove", "real", "--force"]);
    const second = startWithFakePi(
      project,
      ["start", "real", "--branch", "myflow/real-2", "--prompt", "do the work"],
      binDir,
      capture,
    );
    const secondId = second.match(/session (\S+)\)/)?.[1] ?? "";
    assert.notEqual(secondId, firstId, "a second launch must not resume the first session");

    // Continuing one on purpose is still explicit, and the plan shows the id
    // handed to pi.
    worktree(project, ["remove", "real", "--force"]);
    const planned = JSON.parse(
      worktree(project, ["start", "real", "--branch", "myflow/real-3", "--prompt", "again", "--session-id", firstId, "--dry-run"]),
    );
    assert.equal(planned.session_id, firstId, "--session-id is honoured verbatim");
    const plannedCommand = planned.command.join(" ");
    assert.ok(plannedCommand.includes(`--session-id ${firstId}`), "pi is launched with that id");
    assert.match(plannedCommand, /Delegated work order: nobody is watching/);
    const third = startWithFakePi(
      project,
      ["start", "real", "--branch", "myflow/real-3", "--prompt", "again", "--session-id", firstId],
      binDir,
      capture,
    );
    assert.equal(third.match(/session (\S+)\)/)?.[1], firstId, "--session-id is honoured on a real launch");
  } finally {
    cleanup(project);
  }
});

test("worktree create: copied inputs stay out of the worktree git status", () => {
  const project = makeRepo("worktree_dir: ../worktrees\ncopy:\n  - .myflow/tasks\n");
  try {
    mkdirSync(join(project.root, ".myflow", "tasks", "t"), { recursive: true });
    writeFileSync(join(project.root, ".myflow", "tasks", "t", "note.md"), "work order\n");
    worktree(project, ["create", "copied"]);
    const target = join(project.worktrees, "copied");
    assert.ok(existsSync(join(target, ".myflow", "tasks", "t", "note.md")), "the copy lands in the worktree");

    // Inputs for the session, not part of its branch: without this, git add -A
    // stages them and merging the branch into the main tree aborts because the
    // same paths exist there untracked.
    const status = execFileSync("git", ["status", "--short"], { cwd: target, encoding: "utf-8" }).trim();
    assert.ok(!status.includes(".myflow/tasks"), `copied inputs must not appear in git status, got: ${status}`);
    const addDryRun = execFileSync("git", ["add", "-A", "--dry-run"], { cwd: target, encoding: "utf-8" }).trim();
    assert.ok(!addDryRun.includes(".myflow/tasks"), `git add -A must not stage copied inputs, got: ${addDryRun}`);
  } finally {
    cleanup(project);
  }
});


test("is_alive: a detached child is reported alive from another process", () => {
  const project = makeRepo("worktree_dir: ../worktrees\n");
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    detached: true,
    stdio: "ignore",
  });
  sleeper.unref();
  try {
    mkdirSync(join(project.root, ".myflow", ".runtime"), { recursive: true });
    writeFileSync(
      join(project.root, ".myflow", ".runtime", "worktrees.json"),
      JSON.stringify({
        sessions: [
          { name: "sleeper", path: project.root, branch: "myflow/sleeper", created_at: "x", pid: sleeper.pid },
        ],
      }),
      "utf-8",
    );
    const listed = JSON.parse(worktree(project, ["list", "--json"])).sessions[0];
    assert.equal(listed.alive, true, "a live detached process must not read as dead");
  } finally {
    try {
      process.kill(sleeper.pid!, "SIGKILL");
    } catch {
      /* already gone */
    }
    cleanup(project);
  }
});
