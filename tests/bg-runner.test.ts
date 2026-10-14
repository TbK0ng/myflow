import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { runCommand } from "../.myflow/scripts/bg_runner.mjs";

// F1 — the background-task wrapper (`.myflow/scripts/bg_runner.mjs`).
//
// These tests drive the runner as a real child process, exactly as
// `myflow_bg_start` will (F3). They deliberately do not import it: the wrapper
// must stay runnable on its own, decoupled from the Pi extension. Each case
// creates and removes its own temp directory and waits for every command it
// starts, so no orphan process is left behind.
//
// The H1b cases are the exception: they import `runCommand` on purpose, because
// the only way to exercise a *transient* OS refusal without provoking one is to
// inject a stub spawn. That import is the whole point of the export.

const ROOT = join(import.meta.dirname, "..");
const RUNNER = join(ROOT, ".myflow", "scripts", "bg_runner.mjs");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the wrapper to completion and capture its own exit code and streams. */
function runRunner(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): RunResult {
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "myflow-bg-runner-"));
}

test("bg runner -1: command output lands in the log and exit_code 0 is recorded", () => {
  const dir = makeDir();
  try {
    const log = join(dir, "task.log");
    const exit = join(dir, "task.exit");

    const result = runRunner([
      "--id",
      "bg-test",
      "--log",
      log,
      "--exit",
      exit,
      "--",
      "echo hello-bg-runner",
    ]);

    // The wrapper itself is contractually silent: the command's output goes to
    // the log file via the shell, not to the wrapper's stdout.
    assert.equal(result.stdout, "", "the wrapper writes nothing to stdout");
    assert.equal(result.stderr, "", "the wrapper writes nothing to stderr");
    assert.equal(result.status, 0, "a successful command makes the wrapper exit 0");

    // The command's output is in the log.
    assert.match(readFileSync(log, "utf-8"), /hello-bg-runner/);

    // The exit record exists and reports the real outcome.
    const record = JSON.parse(readFileSync(exit, "utf-8"));
    assert.equal(record.exit_code, 0);
    assert.equal(record.signal, null);
    assert.equal(typeof record.at, "string");
    assert.ok(!Number.isNaN(Date.parse(record.at)), "`at` must be a valid ISO timestamp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bg runner -2: a non-zero command exit is recorded and propagated", () => {
  const dir = makeDir();
  try {
    const log = join(dir, "task.log");
    const exit = join(dir, "task.exit");
    for (const command of ["exit 3", "exit 7"]) {
      rmSync(exit, { force: true });
      const expected = Number(command.slice("exit ".length));
      const result = runRunner(["--id", "bg-test", "--log", log, "--exit", exit, "--", command]);
      const record = JSON.parse(readFileSync(exit, "utf-8"));
      assert.equal(record.exit_code, expected, `\`${command}\` must record exit_code ${expected}`);
      assert.equal(result.status, expected, `\`${command}\` must make the wrapper exit ${expected}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bg runner -3: the .exit record is written atomically", async () => {
  const dir = makeDir();
  const readers: Promise<void>[] = [];
  let stop = false;
  try {
    const log = join(dir, "task.log");
    const exit = join(dir, "task.exit");

    // Seed a complete, valid record. A rename replaces the *file* (new inode);
    // writing the destination in place would keep the same inode. That is the
    // deterministic half of this test.
    writeFileSync(exit, JSON.stringify({ exit_code: 99, signal: null, at: "seed" }));
    const before = statSync(exit);

    // The speculative half: while the wrapper writes, concurrent readers must
    // never parse a half-written record. A reader therefore only ever sees the
    // seed or the finished record, never a prefix of either.
    const failures: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      readers.push(
        (async () => {
          while (!stop) {
            try {
              JSON.parse(readFileSync(exit, "utf-8"));
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code !== "ENOENT") failures.push(`${code ?? ""} ${String(error)}`);
            }
            await new Promise((resolve) => setImmediate(resolve));
          }
        })(),
      );
    }

    const child = spawn(process.execPath, [RUNNER, "--id", "bg-test", "--log", log, "--exit", exit, "--", "echo atomicity"], {
      stdio: "ignore",
    });
    const [code] = await once(child, "close");
    assert.equal(code, 0);

    stop = true;
    await Promise.all(readers);

    assert.deepEqual(failures, [], "no reader may observe invalid JSON");

    const record = JSON.parse(readFileSync(exit, "utf-8"));
    assert.equal(record.exit_code, 0, "the finished record replaced the seed");
    const after = statSync(exit);
    assert.notEqual(after.ino, before.ino, "the destination must be replaced by a rename, not written in place");
    assert.ok(!existsSync(`${exit}.tmp`), "the temp file must not be left behind");
  } finally {
    stop = true;
    await Promise.all(readers).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bg runner -4: an unstartable command is recorded as exit_code null plus error", () => {
  const dir = makeDir();
  try {
    const log = join(dir, "task.log");

    // (a) No command at all: still a start failure, still recorded.
    const missingExit = join(dir, "missing.exit");
    const missing = runRunner(["--id", "bg-test", "--log", log, "--exit", missingExit, "--"]);
    assert.notEqual(missing.status, 0, "a missing command must make the wrapper exit non-zero");
    assert.equal(missing.stdout, "");
    assert.equal(missing.stderr, "");
    const missingRecord = JSON.parse(readFileSync(missingExit, "utf-8"));
    assert.equal(missingRecord.exit_code, null);
    assert.equal(typeof missingRecord.error, "string");
    assert.ok(missingRecord.error.length > 0);

    // (b) A genuinely unspawnable command. With `shell: true` a *missing*
    // program is reported by the shell as its own exit code, so the only way
    // spawn itself fails is when the shell cannot be started. On Windows Node
    // resolves the shell from `ComSpec`; pointing it at a missing file makes
    // `spawn` raise ENOENT. Other platforms hardcode `/bin/sh`, so skip there.
    if (process.platform === "win32") {
      const spawnExit = join(dir, "spawn.exit");
      // Windows env var names are case-insensitive but the object is not: the
      // live `COMSPEC` key must be dropped before setting `ComSpec`, or the
      // child keeps the original value and the shell starts normally.
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === "comspec") delete env[key];
      }
      env.ComSpec = join(dir, "no-such-shell.exe");
      const result = runRunner(
        ["--id", "bg-test", "--log", log, "--exit", spawnExit, "--", "definitely_not_a_real_command_xyz"],
        { env },
      );
      assert.notEqual(result.status, 0, "a spawn failure must make the wrapper exit non-zero");
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      const record = JSON.parse(readFileSync(spawnExit, "utf-8"));
      assert.equal(record.exit_code, null);
      assert.equal(typeof record.error, "string");
      assert.ok(record.error.length > 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bg runner -5: the command runs through the platform shell", () => {
  const dir = makeDir();
  try {
    const log = join(dir, "task.log");

    // `&&` only means something to a shell.
    const chainedExit = join(dir, "chained.exit");
    const chained = runRunner(["--id", "bg-test", "--log", log, "--exit", chainedExit, "--", "echo one && echo two"], {
      cwd: dir,
    });
    assert.equal(chained.status, 0);
    const text = readFileSync(log, "utf-8");
    assert.match(text, /one/);
    assert.match(text, /two/);

    // Redirection is interpreted by the shell too, relative to the wrapper's
    // working directory (which the caller sets).
    const redirectExit = join(dir, "redirect.exit");
    const redirected = runRunner(
      ["--id", "bg-test", "--log", log, "--exit", redirectExit, "--", "echo redirected > redirect.txt"],
      { cwd: dir },
    );
    assert.equal(redirected.status, 0);
    assert.match(readFileSync(join(dir, "redirect.txt"), "utf-8"), /redirected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H1b -1 瞬时创建失败会被有界重试，且 .exit 记录重试次数", async () => {
  // 回退点：删掉重试 → calls===3 与 retries===2 变红；删掉 retriesField → retries 断言变红；
  //        用 'exit' 而不是 'spawn' 判定成功 → 重试逻辑不生效/命令跑两次。
  const dir = makeDir();
  let logFd = -1;
  try {
    const log = join(dir, "retry.log");
    logFd = openSync(log, "a");

    // 桩：前两次以 EAGAIN 失败（进程从未创建），第三次交给真实 spawn。
    let calls = 0;
    const spawnImpl = (command: string, options: Parameters<typeof spawn>[1]) => {
      calls += 1;
      if (calls <= 2) {
        const fake = new EventEmitter();
        setImmediate(() => {
          const error = new Error("spawn EAGAIN") as NodeJS.ErrnoException;
          error.code = "EAGAIN";
          fake.emit("error", error);
        });
        return fake as unknown as ChildProcess;
      }
      return spawn(command, options);
    };

    let record: Record<string, unknown> | undefined;
    let runnerCode: number | undefined;
    const outcome = await runCommand({
      command: "echo retried-ok",
      logFd,
      cwd: dir,
      spawnImpl: spawnImpl as unknown as typeof spawn,
      wait: () => {},
      onOutcome: (payload, code) => {
        record = payload;
        runnerCode = code;
      },
    });
    closeSync(logFd);
    logFd = -1;

    assert.equal(calls, 3, "前两次 EAGAIN 失败后必须再试一次");
    assert.equal(outcome.attempts, 3);
    assert.equal(record?.retries, 2, "靠重试才起来这件事必须写进 .exit");
    assert.equal(record?.exit_code, 0);
    assert.equal(runnerCode, 0);
    assert.match(readFileSync(log, "utf-8"), /retried-ok/, "第三次尝试必须真的执行了命令");
  } finally {
    if (logFd >= 0) closeSync(logFd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H1b -2 确定性失败（ENOENT）不重试，只尝试一次并如实记录原因", async () => {
  // 回退点：把 isRetryableSpawnError 改成恒 true → calls 变成 3，断言变红。
  const dir = makeDir();
  let logFd = -1;
  try {
    const log = join(dir, "no-retry.log");
    logFd = openSync(log, "a");

    let calls = 0;
    const spawnImpl = () => {
      calls += 1;
      const fake = new EventEmitter();
      setImmediate(() => {
        const error = new Error("spawn ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        fake.emit("error", error);
      });
      return fake as unknown as ChildProcess;
    };

    let record: Record<string, unknown> | undefined;
    const outcome = await runCommand({
      command: "no-such-command-xyz",
      logFd,
      cwd: dir,
      spawnImpl: spawnImpl as unknown as typeof spawn,
      wait: () => {},
      onOutcome: (payload) => {
        record = payload;
      },
    });
    closeSync(logFd);
    logFd = -1;

    assert.equal(calls, 1, "ENOENT 重试也不会好转，必须只尝试一次");
    assert.equal(outcome.attempts, 1);
    assert.equal(record?.exit_code, null);
    assert.match(String(record?.error), /ENOENT/);
    assert.equal(record?.retries, undefined, "没有重试时省略 retries");
  } finally {
    if (logFd >= 0) closeSync(logFd);
    rmSync(dir, { recursive: true, force: true });
  }
});
