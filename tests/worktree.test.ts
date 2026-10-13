import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";
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
  rmSync(join(project.root, ".."), { recursive: true, force: true });
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
    assert.equal(planned.session_id, "myflow-zeta");
    assert.equal(planned.env.MYFLOW_SKIP_BREADCRUMB, "1");
    assert.ok(planned.command.includes("--session-id"));
    assert.match(planned.command[planned.command.length - 1], /^Active task: \.myflow\/tasks\/demo\n\ndo the work$/);
    assert.ok(!existsSync(join(project.worktrees, "zeta")), "dry-run must not create the worktree");
    assert.ok(!existsSync(join(project.root, ".myflow", ".runtime", "worktrees.json")), "dry-run must not register a session");
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
