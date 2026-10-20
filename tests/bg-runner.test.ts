import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
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
import { pathToFileURL } from "node:url";
import {
  isRetryableSpawnError,
  quoteForBash,
  resolveShellPath,
  runCommand,
  shellArgsFor,
  shellRejectionReason,
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

/**
 * The machine's real POSIX shell, as the runner resolves it.
 *
 * Almost every case needs to pin `MYFLOW_BG_SHELL` to the real shell so the
 * developer's own configuration cannot change what is exercised. `resolveShellPath`
 * now returns `null` when nothing resolves, so the non-null case is asserted
 * once here instead of at every call site.
 */
function realShellPath(): string {
  const shell = resolveShellPath();
  assert.ok(
    typeof shell === "string" && shell.length > 0,
    "本机必须能解析到 POSIX 外壳（Git Bash 或 PATH 上的 bash）",
  );
  return shell;
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
      { env: { ...process.env, MYFLOW_BG_SHELL: realShellPath() } },
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

test("H2 -1 谓词层：ERR_* 是确定性错误，不重试；资源类/未知/无 code 仍重试", () => {
  // 回退点（H2）：删掉 isRetryableSpawnError 里的 `code.startsWith("ERR_")` 提前返回
  //   → 下面四条 ERR_* 断言都变红（它们会落到末尾的 `return true`）。
  //   把 ERR_* 塞进 NON_RETRYABLE_SPAWN_CODES 是做不到的：前缀不是集合成员，
  //   所以必须留这条单独判断。
  const withCode = (code: string | undefined) =>
    code === undefined ? {} : { code };

  for (const code of [
    "ERR_INVALID_ARG_TYPE",
    "ERR_INVALID_CALLBACK",
    "ERR_OUT_OF_RANGE",
    "ERR_UNKNOWN_SIGNAL",
  ]) {
    assert.equal(
      isRetryableSpawnError(withCode(code)),
      false,
      `${code} 是调用方写错，重试只会把错误延迟整个退避预算`,
    );
  }

  // 可重试的一侧必须保持：资源耗尽、无法识别的 code（Windows 232 → UNKNOWN），
  // 以及没有 code 的错误。
  assert.equal(isRetryableSpawnError(withCode("EAGAIN")), true);
  assert.equal(isRetryableSpawnError(withCode("ENOMEM")), true);
  assert.equal(isRetryableSpawnError(withCode("UNKNOWN")), true);
  assert.equal(isRetryableSpawnError(withCode("")), true, "空 code 无法分类，按可重试处理");
  assert.equal(isRetryableSpawnError({}), true, "没有 code 的错误必须可重试（232 靠这条）");
  assert.equal(isRetryableSpawnError(undefined), true);
  assert.equal(isRetryableSpawnError(null), true);

  // 既有确定性集合不能被这次改动挤掉。
  for (const code of ["ENOENT", "EINVAL", "EACCES", "EPERM"]) {
    assert.equal(isRetryableSpawnError(withCode(code)), false, `${code} 必须仍然不重试`);
  }
});

test("H2 -2 行为层：同步抛 ERR_INVALID_ARG_TYPE 只尝试一次，且不退避等待", async () => {
  // 回退点（H2）：删掉 ERR_ 前缀判断 → attempts 变成 9（1 + maxRetries 8）、
  //   calls 变成 9、waits 不再为空，下面四条断言全变红。
  const dir = makeDir();
  try {
    const log = join(dir, "err-code.log");

    let calls = 0;
    const spawnImpl = () => {
      calls += 1;
      // Node 在参数错误时是**同步抛**，不是发 'error' 事件；两条路径都必须不重试。
      const error = new Error("The \"options\" argument must be of type object") as NodeJS.ErrnoException;
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    };

    let record: Record<string, unknown> | undefined;
    let runnerCode: number | undefined;
    const waits: number[] = [];
    const outcome = await runCommand({
      command: "never-runs",
      logPath: log,
      cwd: dir,
      spawnImpl: spawnImpl as unknown as typeof spawn,
      maxRetries: 8,
      wait: (ms: number) => {
        waits.push(ms);
      },
      onOutcome: (payload, code) => {
        record = payload;
        runnerCode = code;
      },
    });

    assert.equal(outcome.attempts, 1, "ERR_INVALID_ARG_TYPE 必须只尝试一次");
    assert.equal(calls, 1, "spawn 只应被调用一次");
    assert.deepEqual(waits, [], "确定性错误不得触发任何退避等待");
    assert.notEqual(runnerCode, 0, "被拒必须以非零退出码上报");
    assert.equal(record?.exit_code, null);
    assert.equal(record?.retries, undefined, "没有重试时省略 retries");
    assert.match(String(record?.error), /ERR_INVALID_ARG_TYPE/);
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
    const shell = realShellPath(); // 本机真实 bash（Git Bash 或 PATH 上的 bash）
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

test("bg runner -7: resolveShellPath 顺序固定，且没有 cmd.exe 兜底（override -> settings -> Git -> PATH -> null）", () => {
  // 回退点：任一候选顺序被调换、多写一套解析、或丢掉存在性检查 → 对应断言变红。
  // 回退点（H1）：把 `syswow64` 从 findOnPath 的跳过集合删掉 → 下面 4d 的两条断言
  //               变红（它们断言的是“拒绝 WSL 启动器的三个视图”，不是“支持 WSL”）。
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
    null,
    "settings 的 shellPath 不存在时必须继续向下解析（不得停在不存在的外壳上）",
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

  // 4c. 只有 System32 里有 bash.exe → 不得采用，**也不得退回 cmd.exe**：
  //     没有可用的 POSIX 外壳就是 null（拒绝），不是换一个外壳静默继续。
  //     回退点：把第 5 步的 ComSpec/cmd.exe 兜底加回来 → 这几条断言全变红。
  assert.equal(
    resolveShellPath({
      env: {},
      platform: "win32",
      homeDir: "H:/home",
      pathValue: "C:\\Windows\\System32",
      exists: (p) => p === wslLauncher,
      readFile: () => "",
    }),
    null,
    "System32 里的 bash.exe 是 WSL 启动器，不得采用，也不得退回 cmd.exe",
  );

  // 4d. System32 的三个视图都是同一个 WSL 启动器，必须一视同仁：
  //     `System32`（64 位视角）/ `Sysnative`（32 位进程看 64 位 System32 的别名）
  //     / `SysWOW64`（64 位进程看 32 位 System32 的视图）。前两个已被 4b/4c 覆盖，
  //     这里补 SysWOW64：本机不装 WSL、也不打算装，所以它不是“待支持”，而是“必须拒绝”。
  //     回退点：从 findOnPath 的跳过集合里删掉 'syswow64' → 下面两条断言变红。
  const syswowLauncher = join("C:\\Windows\\SysWOW64", "bash.exe");
  assert.equal(
    resolveShellPath({
      env: {},
      platform: "win32",
      homeDir: "H:/home",
      pathValue: "C:\\Windows\\SysWOW64",
      exists: (p) => p === syswowLauncher,
      readFile: () => "",
    }),
    null,
    "SysWOW64 里的 bash.exe 是 WSL 启动器的 32 位视图，不得采用",
  );

  // 4e. 同上，但真正的 Git Bash 排在 System32 三视图之后：必须跳过三个视图、取后者。
  assert.equal(
    resolveShellPath({
      env: {},
      platform: "win32",
      homeDir: "H:/home",
      pathValue: ["C:\\Windows\\SysWOW64", "C:\\Windows\\Sysnative", "C:\\Windows\\System32", "D:\\bin"].join(";"),
      exists: (p) =>
        p === syswowLauncher ||
        p === join("C:\\Windows\\Sysnative", "bash.exe") ||
        p === wslLauncher ||
        p === pathBash,
      readFile: () => "",
    }),
    pathBash,
    "System32/Sysnative/SysWOW64 的 bash.exe 全部跳过，只采用真正的 Git Bash",
  );

  // 5. 即使 %ComSpec% / COMSPEC 指着一个真实存在的 cmd.exe，也不得兜底。
  //    回退点：恢复 ComSpec 兜底 → 两条断言变红。
  for (const env of [
    { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
  ]) {
    assert.equal(
      resolveShellPath({
        env,
        platform: "win32",
        homeDir: "H:/home",
        pathValue: "",
        exists: (p) => p === "C:\\Windows\\System32\\cmd.exe",
        readFile: () => "",
      }),
      null,
      "ComSpec 不再是兜底路径：解析不到 bash 必须返回 null",
    );
  }

  // 5b. POSIX 上同样没有 /bin/sh 兜底。
  assert.equal(
    resolveShellPath({
      env: {},
      platform: "linux",
      homeDir: "H:/home",
      pathValue: "/usr/local/bin",
      exists: noExists,
      readFile: () => "",
    }),
    null,
    "/bin/sh 不再是兜底路径",
  );

  // 6. 参数形态：外壳恒为 POSIX，所以只有一种 argv；命令必须是单个 argv 元素
  //    （这正是消灭二次解析的关键），重定向由外壳完成。
  //    回退点：把 cmd 分支（`/d /s /c`）加回来 → 形态不再唯一，断言变红。
  assert.deepEqual(shellArgsFor("echo hi", "/tmp/task.log"), [
    "-lc",
    "exec >> '/tmp/task.log' 2>&1; echo hi",
  ]);
  // 含空格与单引号的日志路径：单引号必须转成 '\''，否则路径会被截断。
  assert.deepEqual(shellArgsFor("echo hi", "/tmp/my log's.task.log"), [
    "-lc",
    "exec >> '/tmp/my log'\\''s.task.log' 2>&1; echo hi",
  ]);

  // 7. cmd.exe 与“解析不到”都是拒绝理由，且两者必须可区分（错误文案不同）。
  //    回退点：删掉 shellRejectionReason 的任一分支 → 对应断言变红。
  assert.match(String(shellRejectionReason("C:\\Windows\\System32\\cmd.exe")), /cmd\.exe/);
  assert.match(String(shellRejectionReason("cmd")), /cmd\.exe/);
  assert.match(String(shellRejectionReason(null)), /no POSIX shell/);
  assert.equal(shellRejectionReason(gitBash), null, "bash 不是拒绝理由");
  assert.equal(shellRejectionReason("/bin/sh"), null, "任何非 cmd 的路径都按 POSIX 外壳处理");
  assert.equal(
    shellRejectionReason("D:/tools/Git/git-bash.exe"),
    null,
    "名字里含 cmd 但不是 cmd.exe 不得误判",
  );

  // quoteForBash 的单测（回退点：改掉转义规则 → 断言变红）。
  assert.equal(quoteForBash("/a b/c"), "'/a b/c'");
  assert.equal(quoteForBash("a'b"), "'a'\\''b'");
});

test("bg runner -7b: 本机真实解析出的外壳是 Git Bash，且不是任何 WSL 启动器视图", () => {
  // 这是本任务的机器契约（H1）：“本机只用 Git Bash”。它不是恒真断言：真的用默认参数
  // 解析一遍，再按**路径段**检查结果，而不是只检查字符串里有没有 “system32”。
  //
  // 回退点：
  //   - findOnPath 不再跳过 syswow64/system32/sysnative，而本机 PATH 上恰好有 WSL 启动器
  //     → 下面的段断言变红；
  //   - resolveShellPath 变成返回 null → “必须解析到外壳”变红。
  const shell = resolveShellPath();
  assert.equal(typeof shell, "string", "本机必须能解析到 POSIX 外壳（期望 Git Bash）");
  assert.ok(shell && shell.length > 0, "解析结果不得为空字符串");
  assert.ok(existsSync(shell), `解析出的外壳必须真实存在：${shell}`);

  const segments = shell.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  for (const forbidden of ["system32", "sysnative", "syswow64"]) {
    assert.ok(
      !segments.includes(forbidden),
      `本机外壳不得来自 WSL 启动器视图（${forbidden}）：${shell}`,
    );
  }

  // 名字必须是 bash（POSIX 外壳），不能是 cmd.exe 或别的东西。
  const name = segments[segments.length - 1];
  assert.ok(
    name === "bash.exe" || name === "bash",
    `本机外壳必须是 bash（Git Bash），实际是：${shell}`,
  );
});

// ---- P1: no cmd.exe fallback ----
//
// Driving `cmd.exe` means handing it `/d /s /c "<command> >> <log> 2>&1"` as one
// argv element, and Node re-quotes that element for the Windows command line:
// a quote inside the command becomes `\"`, which `cmd.exe` does not accept. Any
// quoted command would fail on that path, so the fallback was advertised as
// usable while being broken. It is gone: no POSIX shell ⇒ **refuse**, and the
// refusal must prove that nothing ran (otherwise "refused" and "ran but failed"
// are indistinguishable from outside).

test("bg runner -8: 解析不到 POSIX 外壳 → 拒绝、写 error、且一个字都不执行", () => {
  // 回退点：把 resolveShellPath 的 `%ComSpec%` / `cmd.exe` 兜底加回来 → 这里注入的
  //         resolveShell 才失效；删掉 runWrapper 里的 shellRejectionReason 判定
  //         → 进程仍会去起 `null` 外壳并写出不同的记录，status / log 断言变红。
  //
  // The branch is unreachable on a real Windows machine (the Git for Windows bash
  // exists there), so the child process injects a resolver that finds nothing.
  // Everything else is real: a separate process, a real `<exit>` file, a real
  // attempt to run a command that must never reach a shell.
  const dir = makeDir();
  try {
    const log = join(dir, "refused.log");
    const exit = join(dir, "refused.exit");
    const sideEffect = join(dir, "side-effect.txt");
    const probe = join(dir, "no-shell-probe.mjs");
    const runnerUrl = pathToFileURL(RUNNER).href;
    const argv = [
      "--id",
      "bg-test",
      "--log",
      log,
      "--exit",
      exit,
      "--",
      "echo SHOULD-NOT-RUN > side-effect.txt",
    ];
    writeFileSync(
      probe,
      [
        `import { runWrapper } from ${JSON.stringify(runnerUrl)};`,
        `runWrapper({ argv: ${JSON.stringify(argv)}, resolveShell: () => null });`,
        "",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [probe], { cwd: dir, encoding: "utf-8" });
    assert.notEqual(result.status, 0, "解析不到外壳时 wrapper 必须非零退出（拒绝，不是假装成功）");
    assert.equal(result.stdout, "", "wrapper 仍然不得写 stdout");
    assert.equal(result.stderr, "", "wrapper 仍然不得写 stderr");

    const record = JSON.parse(readFileSync(exit, "utf-8"));
    assert.equal(record.exit_code, null, "没有进程被执行，不得编造退出码");
    assert.equal(record.shell, null, "解析不到外壳时 shell 必须为 null（不得写成 cmd.exe）");
    assert.match(String(record.error), /no POSIX shell could be resolved/);
    assert.match(String(record.error), /No command was executed/, "必须明说命令一个字都没跑");
    // How to fix it: the search order must be in the record, not just in the code.
    assert.match(String(record.error), /MYFLOW_BG_SHELL/);
    assert.match(String(record.error), /settings\.json's shellPath/);
    assert.match(String(record.error), /Git for Windows bash/);
    assert.match(String(record.error), /bash on PATH/);

    // The two facts that make "refused" different from "ran and failed":
    assert.equal(existsSync(log), false, "被拒绝时不得创建日志文件");
    assert.equal(existsSync(sideEffect), false, "被拒绝时命令不得产生任何副作用");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bg runner -9: MYFLOW_BG_SHELL 指到 cmd.exe → 拒绝，并指出不支持 cmd.exe", () => {
  // 回退点：删掉 shellRejectionReason 的 cmd.exe 分支 → wrapper 会把 cmd 当 POSIX
  //         外壳用 `-lc` 起起来，status/error/log 三条断言全变红。
  //
  // `MYFLOW_BG_SHELL` is taken verbatim, so a path whose basename is `cmd.exe`
  // triggers the guard on every platform without needing a real cmd.exe.
  const dir = makeDir();
  try {
    const log = join(dir, "cmd.log");
    const exit = join(dir, "cmd.exit");
    const sideEffect = join(dir, "side-effect.txt");
    const cmdShell = join(dir, "cmd.exe");
    const result = runRunner(
      ["--id", "bg-test", "--log", log, "--exit", exit, "--", "echo SHOULD-NOT-RUN > side-effect.txt"],
      { cwd: dir, env: { ...process.env, MYFLOW_BG_SHELL: cmdShell } },
    );

    assert.notEqual(result.status, 0, "cmd.exe 不是可用外壳：必须非零退出");
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");

    const record = JSON.parse(readFileSync(exit, "utf-8"));
    assert.equal(record.exit_code, null);
    assert.match(String(record.error), /cmd\.exe/, "错误信息必须点名 cmd.exe");
    assert.match(String(record.error), /not supported/, "必须明确“不支持”而不是笼统失败");
    assert.match(String(record.error), /No command was executed/);
    assert.match(String(record.error), /MYFLOW_BG_SHELL/, "必须指出改哪里");
    assert.equal(record.shell, cmdShell, ".exit 仍必须记录被拒绝的那个外壳路径");

    assert.equal(existsSync(log), false, "被拒绝时不得创建日志文件");
    assert.equal(existsSync(sideEffect), false, "被拒绝时命令不得产生任何副作用");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bg runner -10: runCommand 自己也会拒绝无外壳，且从不起进程", async () => {
  // 回退点：把 runCommand 顶部的 shellRejectionReason 判定删掉（只留 runWrapper 的）
  //         → spawnImpl 被调用（calls === 1）且 payload 不再是 shellUnavailable 形状，
  //         calls / error / log 三条断言变红。
  const dir = makeDir();
  try {
    const log = join(dir, "no-shell.log");
    let calls = 0;
    // If the guard regresses, this stub settles immediately with ENOENT so the
    // case *fails* (calls === 1, wrong error text) instead of hanging.
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
    let runnerCode: number | undefined;
    const outcome = await runCommand({
      command: "echo SHOULD-NOT-RUN",
      logPath: log,
      cwd: dir,
      shellPath: null,
      spawnImpl: spawnImpl as unknown as typeof spawn,
      onOutcome: (payload, code) => {
        record = payload;
        runnerCode = code;
      },
    });

    assert.equal(calls, 0, "没有外壳就不得调用 spawn");
    assert.equal(outcome.attempts, 0, "一次尝试都没有发生");
    assert.notEqual(runnerCode, 0, "拒绝必须报告非零 runnerCode");
    assert.equal(record?.exit_code, null);
    assert.match(String(record?.error), /no POSIX shell could be resolved/);
    assert.match(String(record?.error), /No command was executed/);
    assert.equal(record?.retries, undefined, "拒绝不是重试失败，不得记 retries");
    assert.equal(existsSync(log), false, "被拒绝时不得创建日志文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  // 前缀必须以 `myflow-` 开头：`tests/leak-audit.test.ts` 的审计 glob 只认
  // `%TEMP%/myflow-*`，前缀里那个**空格**是用例 S2 -3 故意要保留的。
  const dir = mkdtempSync(join(tmpdir(), "myflow-bg-runner space-"));
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

// ---------------------------------------------------------------------------
// H5 — `--cwd`（R5）
//
// The wrapper's own cwd (where `--log` / `--exit` resolve from) and the
// *command's* cwd are now separate: `myflow_bg_start` validates the directory
// and passes it as `--cwd`, so a background command can run in a subdirectory
// without moving the log/exit bookkeeping out of the project.
// ---------------------------------------------------------------------------

/** Quote `process.execPath` for a POSIX shell (its path may contain spaces). */
function quotedNode(): string {
  return `'${process.execPath.replace(/'/g, "'\''")}'`;
}

test("H5 -6 --cwd 生效（命令在该目录执行），缺值是硬错误", () => {
  const dir = makeDir();
  try {
    const sub = join(dir, "app");
    mkdirSync(sub, { recursive: true });
    const log = join(dir, "task.log");
    const exit = join(dir, "task.exit");

    // 回退点：删掉 `cwd: options.cwd ?? process.cwd()` 里的 `options.cwd`（退回
    // process.cwd()）→ `console.log(process.cwd())` 打印的是 dir，断言变红。
    const result = runRunner(
      [
        "--id",
        "bg-test",
        "--log",
        log,
        "--exit",
        exit,
        "--cwd",
        sub,
        "--",
        `${quotedNode()} -e "console.log(process.cwd())"`,
      ],
      { cwd: dir },
    );

    assert.equal(result.status, 0);
    assert.equal(
      readFileSync(log, "utf-8").trim(),
      sub,
      "命令必须在 --cwd 指定的目录里执行",
    );
    // 记账文件仍落在 wrapper 自己的 cwd 下（--log/--exit 是绝对路径，不受 --cwd 影响）。
    assert.equal(JSON.parse(readFileSync(exit, "utf-8")).exit_code, 0);

    // `--cwd` 缺值不得悄悄退回“当前目录”：否则命令会在一个确认门从未展示过的
    // 目录里运行。硬错误 = 退出码 2，且不写 `.exit`（回退点：把缺值当 null → 正常启动）。
    const missingCwdExit = join(dir, "missing.exit");
    const missing = runRunner([
      "--id",
      "bg-test",
      "--log",
      join(dir, "missing.log"),
      "--exit",
      missingCwdExit,
      "--cwd",
    ]);
    assert.equal(missing.status, 2, "`--cwd` 缺值必须是硬错误（EXIT_BAD_ARGS）");
    assert.ok(!existsSync(missingCwdExit), "参数错误时不得写 .exit 记录");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// H6 — the `<id>.pid` handshake (ADR-8 / R6)
//
// The wrapper must write `<pidPath>` *before* it resolves the shell, creates the
// log directory, or runs anything. The command therefore always runs in a world
// where its own pid is already on disk: that is what closes the orphan window
// (a crash can no longer leave a process nobody can address).
// ---------------------------------------------------------------------------

/** Quote a path for a POSIX shell, with forward slashes so `\` is not an escape. */
function shPath(path: string): string {
  return `'${path.split("\\").join("/").replace(/'/g, "'\''")}'`;
}

test("H6 -12 wrapper 先写 <id>.pid，再执行命令（命令执行时 .pid 已在，且 pid = wrapper pid）", async () => {
  const dir = makeDir();
  try {
    const log = join(dir, "task.log");
    const exit = join(dir, "task.exit");
    const pidFile = join(dir, "task.pid");
    const marker = join(dir, "marker.txt");

    // 命令把**读到的 `.pid` 内容**写进 marker。异步起 wrapper 是为了拿到它真实的
    // pid（MSYS 的 `$PPID` 在 Windows 上恒为 1，不可用），再与握手比对。
    // 回退点：把 `writePidRecord` 挪到 `runCommand` 之后 → `cat` 在写 `.pid` 之前
    // 执行，marker 为空，下面的 `.pid` 断言变红。
    const command = `cat ${shPath(pidFile)} > ${shPath(marker)}`;
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.MYFLOW_BG_SHELL;
    const child = spawn(
      process.execPath,
      [RUNNER, "--id", "bg-test", "--log", log, "--exit", exit, "--pid", pidFile, "--", command],
      { env, stdio: "ignore" },
    );
    const wrapperPid = child.pid;
    const [code] = await once(child, "exit");

    assert.equal(code, 0, "命令成功时 wrapper 退出码为 0");
    assert.ok(typeof wrapperPid === "number" && wrapperPid > 0);

    const handshake = JSON.parse(readFileSync(marker, "utf-8"));
    assert.equal(typeof handshake.pid, "number");
    assert.ok(Number.isInteger(handshake.pid) && handshake.pid > 0, ".pid 里必须是真实 pid");
    assert.equal(handshake.pid, wrapperPid, ".pid 里的 pid 必须是 wrapper 自己的 pid");
    assert.equal(typeof handshake.at, "string");
    assert.ok(!Number.isNaN(Date.parse(handshake.at)), ".pid.at 必须是合法 ISO 时间");

    // 盘上留下的还是同一份握手：wrapper 不会删它，读侧靠它判活。
    assert.equal(JSON.parse(readFileSync(pidFile, "utf-8")).pid, wrapperPid);
    assert.equal(JSON.parse(readFileSync(exit, "utf-8")).exit_code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H6 -13 拒绝外壳时也已经写下 .pid（握手早于外壳解析）", () => {
  const dir = makeDir();
  try {
    const log = join(dir, "task.log");
    const exit = join(dir, "task.exit");
    const pidFile = join(dir, "task.pid");

    // 一个肯定会被拒绝的外壳（cmd.exe）：命令一个字都不会执行，但“wrapper 曾经
    // 活着”仍必须留下证据，否则一个从未写 `.exit` 的坏任务无法与“从未启动”区分。
    const result = runRunner(
      ["--id", "bg-test", "--log", log, "--exit", exit, "--pid", pidFile, "--", "echo never"],
      { env: { MYFLOW_BG_SHELL: "cmd.exe" } },
    );
    assert.notEqual(result.status, 0, "被拒绝的任务退出码非零");
    assert.ok(existsSync(pidFile), "拒绝外壳时也必须留下 .pid 握手");
    assert.ok(JSON.parse(readFileSync(pidFile, "utf-8")).pid > 0);
    assert.equal(
      JSON.parse(readFileSync(exit, "utf-8")).shell,
      "cmd.exe",
      "拒绝记录保留被拒的外壳路径（而不是伪装成已解析）",
    );
    assert.ok(!existsSync(log), "拒绝时不得创建日志文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
