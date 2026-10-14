import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  isCmdShell,
  quoteForBash,
  quoteForCmd,
  resolveShellPath,
  runCommand,
  shellArgsFor,
  spawnRetryDelayMs,
  SPAWN_RETRY_TOTAL_BUDGET_MS,
} from "../.myflow/scripts/bg_runner.mjs";

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
  // Hermetic shell resolution: the developer's own `MYFLOW_BG_SHELL` must not
  // change what these cases exercise. A case that wants an override opts in
  // explicitly through `options.env`.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.MYFLOW_BG_SHELL;
  Object.assign(env, options.env ?? {});

  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: options.cwd,
    env,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "myflow-bg-runner-"));
}

/** Poll `predicate` until it is true or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met before timeout");
}

/** Whether a pid is still alive (`kill(pid, 0)` never signals, only probes). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process and its descendants.
 *
 * The runner starts its shell *detached*, so killing the runner no longer reaps
 * the shell: that is the whole point of detaching, but it means a test that
 * leaves a long-running command behind also leaves a process holding the log
 * file open, and Windows then refuses to remove the temp directory (EPERM).
 * `taskkill /F /T` is invoked from Node with an argv array — never through Git
 * Bash, which rewrites `/F` into an `F:/` path — and follows the parent/child
 * tree even across the detached boundary.
 */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Every number nested anywhere in `value` (a passed fd is exactly such a number). */
function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectNumbers(item, out);
  }
  return out;
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
    // Which shell ran it is recorded on the success path too (not just on
    // failure), so "was this cmd or bash?" is always answerable afterwards.
    assert.equal(typeof record.shell, "string");
    assert.ok(record.shell.length > 0, ".exit 必须记录外壳路径");
    assert.match(record.shell, /bash(\.exe)?$/i, "默认必须解析到 Git Bash / PATH 上的 bash");
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

test("bg runner -4: an unstartable shell is recorded as exit_code null plus error", () => {
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

    // (b) The *shell itself* cannot be started. The wrapper now spawns the shell
    // with argv, so the only way `spawn` fails is when that shell is missing.
    // `MYFLOW_BG_SHELL` is taken verbatim (no existence check, by design), so
    // pointing it at a missing file makes `spawn` raise ENOENT.
    const bogusShell = join(dir, "no-such-shell.exe");
    const spawnExit = join(dir, "spawn.exit");
    const spawnResult = runRunner(
      ["--id", "bg-test", "--log", log, "--exit", spawnExit, "--", "echo hi"],
      { env: { ...process.env, MYFLOW_BG_SHELL: bogusShell } },
    );
    assert.notEqual(spawnResult.status, 0, "a spawn failure must make the wrapper exit non-zero");
    assert.equal(spawnResult.stdout, "");
    assert.equal(spawnResult.stderr, "");
    const spawnRecord = JSON.parse(readFileSync(spawnExit, "utf-8"));
    assert.equal(spawnRecord.exit_code, null);
    assert.equal(typeof spawnRecord.error, "string");
    assert.ok(spawnRecord.error.length > 0);
    assert.equal(spawnRecord.shell, bogusShell, ".exit 必须记录被请求的外壳路径");

    // (c) A *missing command* is NOT a spawn failure any more. The shell starts
    // fine and reports the unknown command itself, which bash does as exit code
    // 127. Asserting this keeps the runner from ever regressing to treating a
    // shell-level failure as a failed process creation.
    const noCommandExit = join(dir, "no-command.exit");
    const noCommand = runRunner(
      ["--id", "bg-test", "--log", log, "--exit", noCommandExit, "--", "definitely_not_a_real_command_xyz"],
      { env: { ...process.env, MYFLOW_BG_SHELL: resolveShellPath() } },
    );
    assert.equal(noCommand.status, 127, "bash 把不存在的命令报为退出码 127（不是 spawn 失败）");
    const noCommandRecord = JSON.parse(readFileSync(noCommandExit, "utf-8"));
    assert.equal(noCommandRecord.exit_code, 127);
    assert.equal(noCommandRecord.signal, null);
    assert.equal(noCommandRecord.error, undefined, "命令不存在不得被记成创建失败");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bg runner -5: the command runs through the resolved shell", () => {
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

    // A pipe is interpreted by the shell, not by us: the command is one argv
    // element, so `|` must survive to bash. (This is the case `shell: "..."`
    // could not express on Windows.)
    const pipeExit = join(dir, "pipe.exit");
    const piped = runRunner(
      ["--id", "bg-test", "--log", log, "--exit", pipeExit, "--", "echo pipe-me | tr a-z A-Z"],
      { cwd: dir },
    );
    assert.equal(piped.status, 0);
    assert.match(readFileSync(log, "utf-8"), /PIPE-ME/);

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
  try {
    const log = join(dir, "retry.log");

    // 桩：前两次以 EAGAIN 失败（进程从未创建），第三次交给真实 spawn。
    // 注意新的 spawn 形态：外壳与参数是分开的 argv，命令是 args 的最后一个元素。
    let calls = 0;
    const spawnImpl = (
      shell: string,
      args: readonly string[],
      options: Parameters<typeof spawn>[2],
    ) => {
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
      return spawn(shell, args, options);
    };

    let record: Record<string, unknown> | undefined;
    let runnerCode: number | undefined;
    const delays: number[] = [];
    const outcome = await runCommand({
      command: "echo retried-ok",
      logPath: log,
      cwd: dir,
      spawnImpl: spawnImpl as unknown as typeof spawn,
      wait: (ms: number) => {
        delays.push(ms);
      },
      onOutcome: (payload, code) => {
        record = payload;
        runnerCode = code;
      },
    });

    assert.equal(calls, 3, "前两次 EAGAIN 失败后必须再试一次");
    assert.equal(outcome.attempts, 3);
    assert.deepEqual(delays, [250, 375], "两次重试必须按退避曲线等待");
    assert.equal(record?.retries, 2, "靠重试才起来这件事必须写进 .exit");
    assert.equal(record?.exit_code, 0);
    assert.equal(runnerCode, 0);
    assert.match(readFileSync(log, "utf-8"), /retried-ok/, "第三次尝试必须真的执行了命令");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H1b -2 确定性失败（ENOENT）不重试，只尝试一次并如实记录原因", async () => {
  // 回退点：把 isRetryableSpawnError 改成恒 true → calls 变成 3，断言变红。
  const dir = makeDir();
  try {
    const log = join(dir, "no-retry.log");

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
    const delays: number[] = [];
    const outcome = await runCommand({
      command: "no-such-command-xyz",
      logPath: log,
      cwd: dir,
      spawnImpl: spawnImpl as unknown as typeof spawn,
      wait: (ms: number) => {
        delays.push(ms);
      },
      onOutcome: (payload) => {
        record = payload;
      },
    });

    assert.equal(calls, 1, "ENOENT 重试也不会好转，必须只尝试一次");
    assert.deepEqual(delays, [], "ENOENT 不得触发任何退避等待");
    assert.equal(outcome.attempts, 1);
    assert.equal(record?.exit_code, null);
    assert.match(String(record?.error), /ENOENT/);
    assert.equal(record?.retries, undefined, "没有重试时省略 retries");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bg runner -6: MYFLOW_BG_SHELL 覆盖被采用，并原样记进 .exit.shell", () => {
  // 回退点：resolveShellPath 不再读 MYFLOW_BG_SHELL → shell 字段不等于注入值；
  //         runCommand 忘了把 shell 写进成功记录 → shell 断言变红。
  const dir = makeDir();
  try {
    const log = join(dir, "override.log");
    const exit = join(dir, "override.exit");
    const shell = resolveShellPath(); // 本机真实 bash（Git Bash 或 PATH 上的 bash）
    const result = runRunner(
      ["--id", "bg-test", "--log", log, "--exit", exit, "--", "echo override-marker"],
      { env: { ...process.env, MYFLOW_BG_SHELL: shell } },
    );
    assert.equal(result.status, 0);
    const record = JSON.parse(readFileSync(exit, "utf-8"));
    assert.equal(record.shell, shell, "注入的 MYFLOW_BG_SHELL 必须原样进入 .exit.shell");
    assert.match(readFileSync(log, "utf-8"), /override-marker/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bg runner -7: resolveShellPath 顺序固定（override -> settings -> Git -> PATH -> cmd）", () => {
  // 回退点：任一候选顺序被调换、多写一套解析、或丢掉存在性检查 → 对应断言变红。
  const gitBash = join("C:\\", "Program Files", "Git", "bin", "bash.exe");
  const noExists = () => false;
  const settingsFile = join("H:/home", ".pi", "agent", "settings.json");

  // 1. MYFLOW_BG_SHELL 优先，且原样返回（不做存在性检查）。
  assert.equal(
    resolveShellPath({
      env: { MYFLOW_BG_SHELL: "X:/nowhere/bash.exe" },
      platform: "win32",
      homeDir: "H:/home",
      pathValue: "",
      exists: noExists,
      readFile: () => "",
    }),
    "X:/nowhere/bash.exe",
  );

  // 2. settings.json 的 shellPath。
  assert.equal(
    resolveShellPath({
      env: {},
      platform: "win32",
      homeDir: "H:/home",
      pathValue: "",
      exists: (p) => p === "H:/home/custom/shell.exe" || p === settingsFile,
      readFile: () => JSON.stringify({ shellPath: "H:/home/custom/shell.exe" }),
    }),
    "H:/home/custom/shell.exe",
    "settings 的 shellPath 存在时必须采用",
  );

  // 2b. shellPath 指向不存在的文件 → 继续向下解析，不得采用不存在的外壳。
  assert.equal(
    resolveShellPath({
      env: {},
      platform: "win32",
      homeDir: "H:/home",
      pathValue: "",
      exists: (p) => p === settingsFile,
      readFile: () => JSON.stringify({ shellPath: "H:/gone/shell.exe" }),
    }),
    "cmd.exe",
    "settings 的 shellPath 不存在时必须继续向下解析",
  );

  // 3. Git for Windows 标准路径。
  assert.equal(
    resolveShellPath({
      env: {},
      platform: "win32",
      homeDir: "H:/home",
      pathValue: "",
      exists: (p) => p === gitBash,
      readFile: () => "",
    }),
    gitBash,
  );

  // 4. PATH 上的 bash。
  const pathBash = join("D:\\bin", "bash.exe");
  assert.equal(
    resolveShellPath({
      env: {},
      platform: "win32",
      homeDir: "H:/home",
      pathValue: "C:\\tools;D:\\bin",
      exists: (p) => p === pathBash,
      readFile: () => "",
    }),
    pathBash,
  );

  // 4b. PATH 搜索必须跳过 Windows 系统目录里的 bash.exe（那是 WSL 启动器，
  //     本项目禁止调用）：即使它存在、而真正的 git bash 在后面，也必须取后者。
  const wslLauncher = join("C:\\Windows\\System32", "bash.exe");
  assert.equal(
    resolveShellPath({
      env: {},
      platform: "win32",
      homeDir: "H:/home",
      pathValue: "C:\\Windows\\System32;D:\\bin",
      exists: (p) => p === wslLauncher || p === pathBash,
      readFile: () => "",
    }),
    pathBash,
    "System32 下的 bash.exe 是 WSL 启动器，必须跳过",
  );

  // 4c. 只有 System32 里有 bash.exe → 不得采用，退回 %ComSpec% 兜底。
  assert.equal(
    resolveShellPath({
      env: {},
      platform: "win32",
      homeDir: "H:/home",
      pathValue: "C:\\Windows\\System32",
      exists: (p) => p === wslLauncher,
      readFile: () => "",
    }),
    "cmd.exe",
  );

  // 5. 兜底：%ComSpec% 的 cmd.exe。
  assert.equal(
    resolveShellPath({
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      platform: "win32",
      homeDir: "H:/home",
      pathValue: "",
      exists: noExists,
      readFile: () => "",
    }),
    "C:\\Windows\\System32\\cmd.exe",
  );

  // 6. 参数形态：命令必须作为单个 argv 元素（这正是消灭二次解析的关键），
  //    重定向由外壳完成，日志路径按各自外壳的引用规则转义。
  assert.deepEqual(shellArgsFor(gitBash, "echo hi", "/tmp/task.log"), [
    "-lc",
    "exec >> '/tmp/task.log' 2>&1; echo hi",
  ]);
  // 含空格与单引号的日志路径：单引号必须转成 '\''，否则路径会被截断。
  assert.deepEqual(shellArgsFor(gitBash, "echo hi", "/tmp/my log's.task.log"), [
    "-lc",
    "exec >> '/tmp/my log'\\''s.task.log' 2>&1; echo hi",
  ]);
  assert.deepEqual(shellArgsFor("C:\\Windows\\System32\\cmd.exe", "echo hi", "C:\\tmp dir\\task.log"), [
    "/d",
    "/s",
    "/c",
    'echo hi >> "C:\\tmp dir\\task.log" 2>&1',
  ]);
  assert.equal(isCmdShell("cmd.exe"), true);
  assert.equal(isCmdShell("/bin/sh"), false);
  assert.equal(isCmdShell(gitBash), false);

  // quoteForBash / quoteForCmd 的单测（回退点：改掉转义规则 → 断言变红）。
  assert.equal(quoteForBash("/a b/c"), "'/a b/c'");
  assert.equal(quoteForBash("a'b"), "'a'\\''b'");
  assert.equal(quoteForCmd("C:\\a b\\c"), '"C:\\a b\\c"');
});

// ---- S2: the redirection moved from an inherited descriptor to the shell ----
//
// S2 root cause: passing an open descriptor as a *standard handle* makes libuv
// restrict the child's inherited handles, and on Windows that `CreateProcess`
// path can fail with ERROR_NO_SYSTEM_RESOURCES (232). The fix is to hand the
// child nothing (`stdio: "ignore"`) and let the shell open the log itself.

test('S2 -1: spawn 用 stdio:"ignore"，不向子进程传任何描述符', async () => {
  // 回退点：把 spawn 改回 stdio: ["ignore", logFd, logFd]（或以任何形式传数字 fd）
  //         → `options.stdio === "ignore"` 与 `collectNumbers === []` 两条断言变红。
  const dir = makeDir();
  try {
    const log = join(dir, "invariant.log");
    const captured: Array<Record<string, unknown>> = [];
    const spawnImpl = (
      shell: string,
      args: readonly string[],
      options: Parameters<typeof spawn>[2],
    ) => {
      captured.push(options as unknown as Record<string, unknown>);
      return spawn(shell, args, options);
    };
    let record: Record<string, unknown> | undefined;
    await runCommand({
      command: "echo invariant-ok",
      logPath: log,
      cwd: dir,
      spawnImpl: spawnImpl as unknown as typeof spawn,
      onOutcome: (payload) => {
        record = payload;
      },
    });

    assert.ok(captured.length >= 1, "至少要真正 spawn 一次");
    for (const options of captured) {
      assert.equal(options.stdio, "ignore", 'spawn 必须使用 stdio:"ignore"');
      assert.deepEqual(collectNumbers(options), [], "spawn options 里不得出现任何数字 fd");
    }
    assert.equal(record?.exit_code, 0);
    assert.match(readFileSync(log, "utf-8"), /invariant-ok/, "输出仍必须进入日志");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2 -2: 命令仍在运行时，另一个进程能立刻读到已写入的日志字节", async () => {
  // 回退点：改成 pipe 转发、重新传 fd、或在 runner 里自行缓冲 → 运行中读不到
  //         live-marker，waitFor 超时抛错变红。
  const dir = makeDir();
  try {
    const log = join(dir, "live.log");
    const exit = join(dir, "live.exit");
    const child = spawn(
      process.execPath,
      [RUNNER, "--id", "bg-test", "--log", log, "--exit", exit, "--", "echo live-marker; sleep 4"],
      { cwd: dir, stdio: "ignore" },
    );
    try {
      await waitFor(
        () => existsSync(log) && readFileSync(log, "utf-8").includes("live-marker"),
        5000,
      );
      assert.match(readFileSync(log, "utf-8"), /live-marker/, "命令活着时日志必须已可见");
      assert.equal(existsSync(exit), false, "命令还在跑时不得写出 .exit");
      assert.equal(isAlive(child.pid!), true, "读取时命令进程必须仍然活着");
    } finally {
      // The runner starts the shell detached now, so killing the runner alone
      // would leave the sleeping shell holding the log open; kill the tree.
      killTree(child.pid!);
      await once(child, "close").catch(() => {});
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2 -3: 日志路径含空格/单引号、命令含引号与空格都能跑通", () => {
  // 回退点：去掉 quoteForBash 的引号包裹或单引号转义 → 含空格的日志路径被 shell
  //         拆成多个参数，重定向失败，marker 进不了日志（marker 断言变红）。
  const dir = mkdtempSync(join(tmpdir(), "myflow bg space-"));
  try {
    const log = join(dir, "a log file's name.log");
    const exit = join(dir, "a log file's name.exit");
    const result = runRunner(
      ["--id", "bg-test", "--log", log, "--exit", exit, "--", 'echo "quoted marker with spaces"'],
      { cwd: dir },
    );
    assert.equal(result.status, 0, "含空格日志路径的命令必须成功");
    assert.match(readFileSync(log, "utf-8"), /quoted marker with spaces/);
    const record = JSON.parse(readFileSync(exit, "utf-8"));
    assert.equal(record.exit_code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- S3: no console when starting the shell, and a bounded retry budget ----
//
// S3 root cause: under load (the full test suite spawns hundreds of processes)
// Windows intermittently refuses `CreateProcess` with ERROR_NO_SYSTEM_RESOURCES
// (232) while building a console for the console programs the console-less
// runner starts. Two changes: (A) start the shell itself detached so Windows
// does not allocate a console for it at all, and (B) retry a transient refusal
// on a bounded backoff instead of retrying twice in half a second.

test("S3 -1: 起外壳时 stdio:'ignore' 且仅在 Windows 上 detached，不传任何 fd", async () => {
  // 回退点：去掉 Windows 上的 detached（改回 { cwd, stdio: "ignore" }）
  //         → win32 上 detached 断言变红；
  //         改成无条件 detached（不再按平台判断）→ POSIX 上同一条断言变红，
  //         因为那会把外壳移出 wrapper 的进程组、打掉 design.md §4.4 的组杀；
  //         改回向子进程传数字 fd → collectNumbers 变红。
  const dir = makeDir();
  try {
    const log = join(dir, "detached.log");
    const captured: Array<Record<string, unknown>> = [];
    const spawnImpl = (
      shell: string,
      args: readonly string[],
      options: Parameters<typeof spawn>[2],
    ) => {
      captured.push(options as unknown as Record<string, unknown>);
      return spawn(shell, args, options);
    };
    let record: Record<string, unknown> | undefined;
    await runCommand({
      command: "echo detached-ok",
      logPath: log,
      cwd: dir,
      spawnImpl: spawnImpl as unknown as typeof spawn,
      onOutcome: (payload) => {
        record = payload;
      },
    });

    assert.ok(captured.length >= 1, "至少要真正 spawn 一次");
    for (const options of captured) {
      assert.equal(
        options.detached,
        process.platform === "win32",
        "Windows 上起外壳必须 detached（不建控制台窗口）；非 Windows 必须留在 wrapper 进程组内（design.md §4.4）",
      );
      assert.equal(options.stdio, "ignore", '起外壳必须 stdio:"ignore"');
      assert.deepEqual(collectNumbers(options), [], "不得向子进程传任何数字 fd");
    }
    assert.equal(record?.exit_code, 0, "detached 后退出码仍必须被记录");
    assert.match(readFileSync(log, "utf-8"), /detached-ok/, "detached 后命令仍必须真的跑起来且输出进日志");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S3 -2: 被拒时按递增退避重试，穷尽 8 次并不超预算，错误可操作", async () => {
  // 回退点：MAX_SPAWN_RETRIES 改回 2 → attempts/calls 变红；
  //         退避改成固定值 → delays 断言变红；删掉可操作错误文案 → error 断言变红。
  const dir = makeDir();
  try {
    const log = join(dir, "exhausted.log");
    const delays: number[] = [];
    let calls = 0;
    const spawnImpl = () => {
      calls += 1;
      const fake = new EventEmitter();
      setImmediate(() => {
        const error = new Error("spawn EAGAIN") as NodeJS.ErrnoException;
        error.code = "EAGAIN";
        error.errno = -4094;
        fake.emit("error", error);
      });
      return fake as unknown as ChildProcess;
    };
    let record: Record<string, unknown> | undefined;
    const outcome = await runCommand({
      command: "never-runs",
      logPath: log,
      cwd: dir,
      spawnImpl: spawnImpl as unknown as typeof spawn,
      wait: (ms: number) => {
        delays.push(ms);
      },
      onOutcome: (payload) => {
        record = payload;
      },
    });

    assert.equal(outcome.attempts, 8, "1 次初始 + 7 次重试");
    assert.equal(calls, 8);
    // Hard-coded on purpose: deriving the expected values from
    // `spawnRetryDelayMs` would make this assertion circular and would let a
    // change to the backoff formula pass unnoticed.
    assert.deepEqual(
      delays,
      [250, 375, 562.5, 843.75, 1265.625, 1898.4375, 2000],
      "退避曲线必须是 250ms * 1.5^n，封顶 2s",
    );
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => spawnRetryDelayMs(n)),
      [250, 375, 562.5, 843.75, 1265.625, 1898.4375, 2000, 2000],
      "spawnRetryDelayMs 必须实现 250*1.5^n 且封顶 2s",
    );
    const total = delays.reduce((sum, value) => sum + value, 0);
    assert.equal(total, 7195.3125, "退避总和必须是一个可断言的确切值");
    assert.ok(total <= SPAWN_RETRY_TOTAL_BUDGET_MS, `退避总和 ${total}ms 不得超过预算 ${SPAWN_RETRY_TOTAL_BUDGET_MS}ms`);
    assert.equal(record?.retries, 7, "穷尽重试的差值必须写进 .exit");
    assert.equal(record?.exit_code, null);
    assert.match(String(record?.error), /refused to create the process after 8 attempts/);
    assert.match(String(record?.error), /environment condition/);
    assert.match(String(record?.error), /foreground/);
    assert.match(String(record?.error), /EAGAIN/);
    assert.match(String(record?.error), /errno -4094/, "原始 errno 必须随错误一起留下");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S3 -3: 永远失败时有界放弃（真实等待，总耗时小于预算+余量）", async () => {
  // 回退点：把重试改成无上界的循环，或让 wait 的时长不再封顶
  //         → 该用例要么超时要么 elapsed 超出上界而变红。
  const dir = makeDir();
  try {
    const log = join(dir, "bounded.log");
    const spawnImpl = () => {
      const fake = new EventEmitter();
      setImmediate(() => {
        const error = new Error("spawn UNKNOWN") as NodeJS.ErrnoException;
        error.code = "UNKNOWN";
        fake.emit("error", error);
      });
      return fake as unknown as ChildProcess;
    };
    let record: Record<string, unknown> | undefined;
    const started = Date.now();
    const outcome = await runCommand({
      command: "never-runs",
      logPath: log,
      cwd: dir,
      spawnImpl: spawnImpl as unknown as typeof spawn,
      onOutcome: (payload) => {
        record = payload;
      },
    });
    const elapsed = Date.now() - started;

    assert.equal(outcome.attempts, 8);
    assert.ok(elapsed >= 1000, `必须真的等过（实测 ${elapsed}ms）`);
    assert.ok(
      elapsed < SPAWN_RETRY_TOTAL_BUDGET_MS + 3000,
      `总耗时 ${elapsed}ms 必须小于预算 ${SPAWN_RETRY_TOTAL_BUDGET_MS}ms + 余量`,
    );
    assert.match(String(record?.error), /refused to create the process after 8 attempts/);
    assert.match(String(record?.error), /UNKNOWN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
