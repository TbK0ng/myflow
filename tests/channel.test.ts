import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn, spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
const CHANNEL_PY = join(ROOT, ".myflow", "scripts", "channel.py");

interface Sandbox {
  project: string;
  home: string;
}

function makeSandbox(config?: string): Sandbox {
  const base = mkdtempSync(join(tmpdir(), "myflow-channel-"));
  const project = join(base, "project");
  const home = join(base, "home");
  mkdirSync(join(project, ".myflow", "scripts"), { recursive: true });
  mkdirSync(join(project, ".myflow", "agents"), { recursive: true });
  mkdirSync(home, { recursive: true });
  cpSync(CHANNEL_PY, join(project, ".myflow", "scripts", "channel.py"));
  cpSync(join(ROOT, ".myflow", "agents"), join(project, ".myflow", "agents"), { recursive: true });
  if (config) writeFileSync(join(project, ".myflow", "config.yaml"), config, "utf-8");
  return { project, home };
}

function channel(sandbox: Sandbox, args: string[], expectFailure = false): string {
  try {
    return execFileSync("python3", [join(sandbox.project, ".myflow", "scripts", "channel.py"), ...args], {
      cwd: sandbox.project,
      encoding: "utf-8",
      env: { ...process.env, USERPROFILE: sandbox.home, HOME: sandbox.home },
      timeout: 60_000,
    }).trim();
  } catch (error) {
    if (!expectFailure) throw error;
    const failure = error as { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim();
  }
}

function channelRoot(sandbox: Sandbox): string {
  return join(sandbox.home, ".pi", "myflow", "channels");
}

function projectStore(sandbox: Sandbox): string {
  const root = channelRoot(sandbox);
  const bucket = readdirSync(root).find((entry) => entry !== "__global__");
  assert.ok(bucket, "project bucket must exist");
  return join(root, bucket);
}

function cleanup(sandbox: Sandbox): void {
  rmSync(join(sandbox.project, ".."), { recursive: true, force: true });
}

test("channel create and list keep project and global buckets apart", () => {
  const sandbox = makeSandbox();
  try {
    channel(sandbox, ["create", "alpha"]);
    assert.match(channel(sandbox, ["create", "alpha"], true), /already exists/);
    channel(sandbox, ["create", "shared", "--scope", "global"]);

    const projectList = channel(sandbox, ["list"]);
    assert.match(projectList, /^alpha\tproject\t0 event\(s\)$/m);
    assert.ok(!projectList.includes("shared"), "global channels stay out of project listings");

    const all = channel(sandbox, ["list", "--all"]);
    assert.match(all, /^shared\tglobal\t0 event\(s\)$/m);
  } finally {
    cleanup(sandbox);
  }
});

test("channel send and messages: ordering, since, json, and empty rejection", () => {
  const sandbox = makeSandbox();
  try {
    channel(sandbox, ["create", "chat"]);
    assert.match(channel(sandbox, ["send", "chat", "--as", "me", "hello"]), /^#1 message me$/);
    channel(sandbox, ["send", "chat", "--as", "me", "--to", "worker", "--tag", "question", "second"]);

    const text = channel(sandbox, ["messages", "chat"]);
    assert.match(text, /#1 .* me -> all: hello/);
    assert.match(text, /#2 .* \[question\] me -> worker: second/);

    const since = channel(sandbox, ["messages", "chat", "--since", "1"]);
    assert.ok(!since.includes("hello"), "--since skips older events");
    assert.match(since, /second/);

    const json = JSON.parse(channel(sandbox, ["messages", "chat", "--json"]));
    assert.equal(json.events.length, 2);
    assert.equal(json.events[1].to, "worker");

    assert.match(channel(sandbox, ["send", "chat", "--as", "me"], true), /empty message/);
    assert.match(channel(sandbox, ["messages", "missing"], true), /unknown channel/);
  } finally {
    cleanup(sandbox);
  }
});

test("channel send: idempotency key appends once", () => {
  const sandbox = makeSandbox();
  try {
    channel(sandbox, ["create", "chat"]);
    const first = channel(sandbox, ["send", "chat", "--as", "me", "--idempotency-key", "k1", "once"]);
    const second = channel(sandbox, ["send", "chat", "--as", "me", "--idempotency-key", "k1", "once"]);
    assert.equal(first, second, "the same key returns the recorded event");
    const json = JSON.parse(channel(sandbox, ["messages", "chat", "--json"]));
    assert.equal(json.events.length, 1);
  } finally {
    cleanup(sandbox);
  }
});

test("channel wait: returns a matching completion and times out otherwise", () => {
  const sandbox = makeSandbox();
  try {
    channel(sandbox, ["create", "chat"]);
    channel(sandbox, ["send", "chat", "--as", "worker", "--kind", "done", "all green"]);
    const waited = channel(sandbox, ["wait", "chat", "--from", "worker", "--kind", "done", "--timeout", "5"]);
    assert.match(waited, /done worker -> all: all green/);

    assert.match(
      channel(sandbox, ["wait", "chat", "--from", "nobody", "--timeout", "0.2", "--poll", "0.05"], true),
      /timeout waiting/,
    );
  } finally {
    cleanup(sandbox);
  }
});

test("channel spawn --dry-run: builds a worker command from the runtime agent", () => {
  const sandbox = makeSandbox();
  try {
    channel(sandbox, ["create", "review"]);
    const planned = JSON.parse(
      channel(sandbox, [
        "spawn",
        "review",
        "--agent",
        "reviewer",
        "--task",
        ".myflow/tasks/demo",
        "--handle",
        "checker",
        "--dry-run",
      ]),
    );
    assert.equal(planned.handle, "checker");
    assert.ok(planned.command.includes("--append-system-prompt"));
    assert.ok(
      planned.command.some((part: string) => part.endsWith(join(".myflow", "agents", "reviewer.md"))),
      "the runtime agent definition is attached",
    );
    const prompt = planned.command[planned.command.length - 1];
    assert.match(prompt, /Active task: \.myflow\/tasks\/demo/);
    assert.match(prompt, /--as checker/);

    assert.equal(planned.env.MYFLOW_VERIFY_GATE, "1", "a review worker carries the verify-gate flag");
    assert.equal(planned.env.MYFLOW_SKIP_BREADCRUMB, "1");

    // The flag is the launcher standing in for an agent type: without it a peer
    // check would settle without the verify gate ever running.
    channel(sandbox, ["create", "peer"]);
    const peer = JSON.parse(
      channel(sandbox, ["spawn", "peer", "--agent", "architect", "--dry-run"]),
    );
    assert.ok(!("MYFLOW_VERIFY_GATE" in peer.env), "a non-review worker stays ungated");

    assert.match(channel(sandbox, ["spawn", "review", "--agent", "nope", "--dry-run"], true), /no runtime agent definition/);
  } finally {
    cleanup(sandbox);
  }
});

test("channel worker guard: refuses to exceed max_live_workers", () => {
  const sandbox = makeSandbox("channel:\n  worker_guard:\n    max_live_workers: 1\n");
  try {
    channel(sandbox, ["create", "review"]);
    const store = projectStore(sandbox);
    writeFileSync(
      join(store, "workers.json"),
      JSON.stringify({
        workers: [
          {
            handle: "busy",
            channel: "review",
            scope: "project",
            agent: "check",
            pid: process.pid,
            started_at: "2026-01-01T00:00:00Z",
            log: "x.log",
          },
        ],
      }),
      "utf-8",
    );

    const workers = JSON.parse(channel(sandbox, ["workers", "--json"]));
    assert.equal(workers.workers[0].alive, true);
    assert.equal(workers.guard.max_live_workers, 1);

    assert.match(
      channel(sandbox, ["spawn", "review", "--agent", "reviewer", "--prompt", "go"], true),
      /worker guard: 1 live worker\(s\) >= max_live_workers=1/,
    );
  } finally {
    cleanup(sandbox);
  }
});

test("channel rm and prune: remove a channel and drop dead worker records", () => {
  const sandbox = makeSandbox();
  try {
    channel(sandbox, ["create", "chat"]);
    assert.match(channel(sandbox, ["rm", "chat"]), /removed: chat/);
    assert.match(channel(sandbox, ["rm", "chat"], true), /unknown channel/);

    channel(sandbox, ["create", "chat"]);
    const store = projectStore(sandbox);
    writeFileSync(
      join(store, "workers.json"),
      JSON.stringify({
        workers: [{ handle: "dead", channel: "chat", scope: "project", agent: "check", pid: 999999999, started_at: "x", log: "x" }],
      }),
      "utf-8",
    );
    assert.match(channel(sandbox, ["prune"]), /pruned: 1 worker record/);
    assert.equal(JSON.parse(readFileSync(join(store, "workers.json"), "utf-8")).workers.length, 0);
  } finally {
    cleanup(sandbox);
  }
});

test("channel rm: refuses live workers and --force stops them first", () => {
  const sandbox = makeSandbox();
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
  sleeper.unref();
  try {
    channel(sandbox, ["create", "guarded"]);
    const store = projectStore(sandbox);
    writeFileSync(
      join(store, "workers.json"),
      JSON.stringify({
        workers: [
          { handle: "w1", channel: "guarded", scope: "project", agent: "research", pid: sleeper.pid, started_at: "x", log: "x" },
        ],
      }),
      "utf-8",
    );

    assert.match(channel(sandbox, ["rm", "guarded"], true), /still has live worker\(s\): w1/);
    assert.ok(existsSync(join(store, "guarded", "events.jsonl")), "a refused rm leaves the channel alone");

    assert.match(channel(sandbox, ["rm", "guarded", "--force"]), /removed: guarded/);
    assert.ok(!existsSync(join(store, "guarded")), "the forced rm deletes the channel");
    assert.equal(JSON.parse(readFileSync(join(store, "workers.json"), "utf-8")).workers.length, 0);
    let stopped = false;
    try {
      process.kill(sleeper.pid!, 0);
    } catch {
      stopped = true;
    }
    assert.ok(stopped, "the forced rm stopped the live worker");
  } finally {
    try {
      process.kill(sleeper.pid!, "SIGKILL");
    } catch {
      /* already gone */
    }
    cleanup(sandbox);
  }
});

test("channel rm --force waits out a log handle that is still open", () => {
  const sandbox = makeSandbox();
  channel(sandbox, ["create", "held"]);
  const store = projectStore(sandbox);
  const log = join(store, "held", "logs", "w1.log");
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, "x");
  const holder = spawn(
    process.execPath,
    ["-e", "require('fs').openSync(process.argv[1], 'a'); setTimeout(() => {}, 3000)", log],
    { detached: true, stdio: "ignore" },
  );
  holder.unref();
  try {
    writeFileSync(
      join(store, "workers.json"),
      JSON.stringify({ workers: [{ handle: "w1", channel: "held", pid: holder.pid, started_at: "x", log }] }),
      "utf-8",
    );
    assert.match(channel(sandbox, ["rm", "held", "--force"]), /removed: held/);
    assert.ok(!existsSync(join(store, "held")), "the channel is gone once the handle is released");
  } finally {
    try {
      process.kill(holder.pid!, "SIGKILL");
    } catch {
      /* already gone */
    }
    cleanup(sandbox);
  }
});

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("channel rm --force stops the worker together with its children", async () => {
  const sandbox = makeSandbox();
  channel(sandbox, ["create", "tree"]);
  const store = projectStore(sandbox);
  const log = join(store, "tree", "logs", "w1.log");
  const pidFile = join(store, "tree", "child.pid");
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, "x");
  // A worker that leaves a child holding its log handle open: the case that used
  // to keep the channel undeletable, because only the worker itself was stopped.
  // A real worker leaves MCP servers behind in exactly the same way.
  // A worker that leaves a child holding its log handle open: the case that used
  // to keep the channel undeletable, because only the worker itself was stopped.
  // A real worker leaves MCP servers behind in exactly the same way. The holder is
  // Python on purpose: Python opens files without FILE_SHARE_DELETE, so its handle
  // really blocks the delete (Node's handles do not).
  const holder = join(store, "tree", "holder.py");
  writeFileSync(
    holder,
    [
      'import os',
      'import subprocess',
      'import sys',
      'import time',
      '',
      'mode, log, pidfile = sys.argv[1], sys.argv[2], sys.argv[3]',
      'if mode == "child":',
      '    handle = open(log, "ab")',
      '    time.sleep(120)',
      'else:',
      '    child = subprocess.Popen(',
      '        [sys.executable, __file__, "child", log, pidfile],',
      '        stdin=subprocess.DEVNULL,',
      '        stdout=subprocess.DEVNULL,',
      '        stderr=subprocess.DEVNULL,',
      '    )',
      '    with open(pidfile, "w", encoding="utf-8") as out:',
      '        out.write(str(child.pid))',
      '    handle = open(log, "ab")',
      '    time.sleep(120)',
    ].join(String.fromCharCode(10)),
    "utf-8",
  );
  const worker = spawn("python3", [holder, "parent", log, pidFile], { stdio: "ignore" });
  try {
    writeFileSync(
      join(store, "workers.json"),
      JSON.stringify({ workers: [{ handle: "w1", channel: "tree", scope: "project", agent: "research", pid: worker.pid, started_at: "x", log }] }),
      "utf-8",
    );
    await waitForFile(pidFile);
    const childPid = Number(readFileSync(pidFile, "utf-8"));

    assert.match(channel(sandbox, ["rm", "tree", "--force"]), /removed: tree/);
    assert.ok(!existsSync(join(store, "tree")), "the log is deletable, so nothing holds it");
    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "the worker process is stopped with its children");
  } finally {
    try {
      process.kill(worker.pid!, "SIGKILL");
    } catch {
      /* already gone */
    }
    cleanup(sandbox);
  }
});

test("channel store never creates a .myflow directory in the home directory", () => {
  const sandbox = makeSandbox();
  try {
    channel(sandbox, ["create", "chat"]);
    assert.ok(existsSync(channelRoot(sandbox)), "the store lives under the user channel root");
    assert.ok(
      !existsSync(join(sandbox.home, ".myflow")),
      ".myflow is the project-root marker; a store of that name would capture every project under it",
    );
  } finally {
    cleanup(sandbox);
  }
});

test("channel store stays under the user channel root", () => {
  const sandbox = makeSandbox();
  try {
    channel(sandbox, ["create", "chat"]);
    assert.ok(existsSync(join(projectStore(sandbox), "chat", "events.jsonl")));
    assert.ok(!existsSync(join(sandbox.project, ".myflow", "channels")), "channels never live inside the project");
  } finally {
    cleanup(sandbox);
  }
});
