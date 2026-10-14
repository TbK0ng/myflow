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
import {
  isCmdShell,
  resolveShellPath,
  runCommand,
  shellArgsFor,
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
  let logFd = -1;
  try {
    const log = join(dir, "retry.log");
    // 与 bg_runner 一致用 "w"：MSYS bash 无法使用以 "a"（O_APPEND）打开并
    // 经 stdio 传入的描述符（会报 Bad file descriptor），"w" 可以。
    logFd = openSync(log, "w");

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
    logFd = openSync(log, "w");

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

  // 6. 参数形态：命令必须作为单个 argv 元素（这正是消灭二次解析的关键）。
  assert.deepEqual(shellArgsFor(gitBash, "echo hi"), ["-lc", "echo hi"]);
  assert.deepEqual(shellArgsFor("C:\\Windows\\System32\\cmd.exe", "echo hi"), [
    "/d",
    "/s",
    "/c",
    "echo hi",
  ]);
  assert.equal(isCmdShell("cmd.exe"), true);
  assert.equal(isCmdShell("/bin/sh"), false);
  assert.equal(isCmdShell(gitBash), false);
});
