import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import {
  BACKGROUND_DIR,
  backgroundDir,
  createBgStartTool,
  createBgStopTool,
  entryPath,
  exitPath,
  isAlive,
  readEntry,
  writeEntry,
  type BackgroundEntry,
} from "../.pi/extensions/myflow/background.ts";

// F6 — `myflow_bg_stop`（`.pi/extensions/myflow/background.ts`）。
//
// 这些用例不跑真实 Pi：`createBgStopTool` 把工具对象导出来，测试直接调
// `execute(id, params, signal, onUpdate, fakeCtx)`。
//
// -1/-3 用**真实的** F1 wrapper 起真实进程（与生产同路径），再调 stop；`-2`/`-4`
// 是纯注册表用例；`-5` 通过注入 `terminate` 模拟「杀不死」，锁死「失败不得谎报」。
//
// 每个用例用独立的临时工程目录（前缀 `myflow-bg-stop-`，满足 leak-audit 的审计
// glob），并在 finally 里杀掉可能起来的进程树、删掉临时目录，绝不读写仓库真实的
// `.myflow/.runtime/`，也绝不留孤儿进程。
//
// 回退点（删掉即变红）：
//   -1：stop 改成只杀根 pid（不用 `/T`，或改成 `process.kill(pid)`）→ 孙进程仍活，
//       `childGone` 断言变红；或调 `taskkill` 时把参数拼成一个字符串 → Git Bash/MSYS
//       不再介入，但参数数组被拆错，杀不到。
//   -2：幂等分支里仍然 `writeEntry`（把 exit_code 抹成 null）→ 磁盘对比断言变红。
//   -3：成功分支不写 `ended_at`、或状态不置 `stopped` → 返回值/注册表断言变红。
//   -4：`readEntry` 返回 null 时仍继续走 kill 路径 → 抛栈而非明确错误，用例变红。
//   -5：进程仍活时也 `writeEntry({status:"stopped"})` → 磁盘对比断言 + `isError` 断言变红。

const ROOT = join(import.meta.dirname, "..");
const RUNNER = join(ROOT, ".myflow", "scripts", "bg_runner.mjs");
const CONTEXT_KEY = "pi_bgstop";

/** 一个能通过 findProjectRoot 的临时工程根。 */
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-bg-stop-"));
  mkdirSync(join(root, ".myflow"), { recursive: true });
  writeFileSync(
    join(root, ".myflow", "workflow.md"),
    "[workflow-state:in_progress]\nBackground.\n[/workflow-state:in_progress]\n",
  );
  mkdirSync(backgroundDir(root), { recursive: true });
  return root;
}

/** 默认「TUI 有 UI 且用户同意」的桩 ctx。 */
function fakeCtx(root: string, overrides: Record<string, unknown> = {}) {
  return {
    cwd: root,
    mode: "tui",
    hasUI: true,
    ui: { confirm: async () => true },
    ...overrides,
  };
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

interface BgTool {
  execute: (...args: unknown[]) => Promise<ToolResult>;
}

/** 起真实 wrapper 的 start 工具（runnerPath 指向仓库里真实的 F1 脚本）。 */
function makeStartTool(runnerPath: string = RUNNER): BgTool {
  return createBgStartTool({
    deriveContextKey: () => CONTEXT_KEY,
    isSubAgent: false,
    runnerPath,
  }) as unknown as BgTool;
}

/** 默认 stop 工具：真实 `terminateTree`。 */
function makeStopTool(): BgTool {
  return createBgStopTool({
    deriveContextKey: () => CONTEXT_KEY,
    isSubAgent: false,
  }) as unknown as BgTool;
}

/** 造一条注册表条目（字段同 design.md §3.1）。 */
function makeEntry(
  dir: string,
  id: string,
  overrides: Partial<BackgroundEntry> = {},
): BackgroundEntry {
  return {
    id,
    command: "echo hi",
    cwd: dir,
    pid: process.pid,
    log: join(BACKGROUND_DIR, `${id}.log`),
    exit_file: join(BACKGROUND_DIR, `${id}.exit`),
    status: "running",
    exit_code: null,
    started_at: new Date().toISOString(),
    ended_at: null,
    started_by_context_key: CONTEXT_KEY,
    confirmed_by: "ui-confirm",
    ...overrides,
  };
}

/**
 * 杀掉一个进程树。Windows 上必须从 Node 用**参数数组**调 `taskkill`：经 Git Bash
 * 转发会把 `/F` 改写成 `F:/`（design.md §4.4 已实测）。
 */
function killTree(pid: unknown): void {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid);
    } catch {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
  }
}

/** 轮询直到 predicate 为真或超时；返回最终值。 */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

/**
 * finally 里的统一清理：先杀进程树，给文件句柄一点时间释放，再删临时目录。
 * 删完显式断言目录已消失；删不掉就**抛错让测试失败**，不静默留给 OS。
 */
async function cleanup(root: string, pids: unknown[]): Promise<void> {
  for (const pid of pids) killTree(pid);
  // 给被杀的进程树一点时间释放日志文件句柄。
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    throw new Error(
      `清理临时目录失败：${root}\n` +
        "可能原因：detached 后台任务（runner + Git Bash 外壳）的日志句柄仍未释放。\n" +
        `原始错误：${String(error)}`,
    );
  }
  assert.ok(!existsSync(root), `临时目录必须已删除：${root}`);
}

/** 起一个真实存活、短命的探针进程，供 `-5` 使用。 */
function startProbe(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ["-e", "setTimeout(function(){}, 60000)"], {
    stdio: "ignore",
  });
  const pid = child.pid ?? 0;
  const stop = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    killTree(pid);
  };
  return { pid, stop };
}

/** 正斜杠路径，避免在 bash 命令里被当成转义。 */
function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

// 两个辅助脚本：父进程写下自己的 pid，再起一个孙进程；孙进程写下自己的 pid，
// 两者都长睡。命令经 F1 wrapper 的 Git Bash 外壳启动，于是进程树形如
// wrapper -> bash -> tree-parent(node) -> tree-child(node)。
const TREE_CHILD_SRC = [
  'import { writeFileSync } from "node:fs";',
  "writeFileSync(process.argv[2], String(process.pid));",
  "setTimeout(function () {}, 60000);",
  "",
].join("\n");

const TREE_PARENT_SRC = [
  'import { spawn } from "node:child_process";',
  'import { writeFileSync } from "node:fs";',
  'import { dirname, join } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  "const [childOut, parentOut] = process.argv.slice(2);",
  "const here = dirname(fileURLToPath(import.meta.url));",
  "writeFileSync(parentOut, String(process.pid));",
  'spawn(process.execPath, [join(here, "tree-child.mjs"), childOut], { stdio: "ignore" });',
  "setTimeout(function () {}, 60000);",
  "",
].join("\n");

test("F6 -1 stop 杀掉整个进程树：孙进程也死（用存活检测断言）", async () => {
  const root = makeProject();
  const cleanupPids: unknown[] = [];
  try {
    writeFileSync(join(root, "tree-child.mjs"), TREE_CHILD_SRC);
    writeFileSync(join(root, "tree-parent.mjs"), TREE_PARENT_SRC);
    const childPidFile = join(root, "child.pid");
    const parentPidFile = join(root, "parent.pid");
    const command =
      `node "${toPosixPath(join(root, "tree-parent.mjs"))}" ` +
      `"${toPosixPath(childPidFile)}" "${toPosixPath(parentPidFile)}"`;

    const started = await makeStartTool().execute(
      "start-1",
      { command },
      undefined,
      undefined,
      fakeCtx(root),
    );
    assert.equal(started.isError, undefined, `start 失败：${started.content[0]?.text}`);
    const id = started.details.id as string;
    const wrapperPid = started.details.pid as number;
    cleanupPids.push(wrapperPid);

    // 等整棵树把 pid 写下来，并确认「stop 之前它们都活着」——否则「stop 后死掉」
    // 这个断言可能是自然退出造成的假绿。
    const wrote = await waitFor(
      () => existsSync(parentPidFile) && existsSync(childPidFile),
      15_000,
    );
    assert.ok(wrote, "命令必须写出父进程与孙进程的 pid 文件");
    const parentPid = Number(readFileSync(parentPidFile, "utf-8"));
    const childPid = Number(readFileSync(childPidFile, "utf-8"));
    cleanupPids.push(parentPid, childPid);
    assert.ok(parentPid > 0 && childPid > 0, "pid 文件里必须是真实 pid");
    assert.ok(isAlive(parentPid), `stop 之前父进程必须活着（pid ${parentPid}）`);
    assert.ok(isAlive(childPid), `stop 之前孙进程必须活着（pid ${childPid}）`);
    assert.notEqual(parentPid, childPid, "父/孙必须是两个不同进程");

    const result = await makeStopTool().execute(
      "stop-1",
      { task_id: id },
      undefined,
      undefined,
      fakeCtx(root),
    );
    assert.equal(result.isError, undefined, `stop 不应报错：${result.content[0]?.text}`);
    assert.equal(result.details.stopped, true);
    assert.equal(result.details.status, "stopped");

    // 核心断言：子孙真的死了。看存活检测，不看 taskkill 的输出。
    const parentGone = await waitFor(() => !isAlive(parentPid), 5_000);
    const childGone = await waitFor(() => !isAlive(childPid), 5_000);
    assert.ok(parentGone, `父进程必须已死（pid ${parentPid}）`);
    assert.ok(childGone, `孙进程必须已死（pid ${childPid}）—— /T 必须杀到后代`);

    const entry = readEntry(backgroundDir(root), id)!;
    assert.equal(entry.status, "stopped");
    assert.ok(
      typeof entry.ended_at === "string" && entry.ended_at.length > 0,
      "注册表必须写入 ended_at",
    );
  } finally {
    await cleanup(root, cleanupPids);
  }
});

test("F6 -2 幂等：对已结束任务 stop 不报错、不改已有 exit_code", async () => {
  const root = makeProject();
  try {
    const dir = backgroundDir(root);

    const exitedId = "bg-stop-done-0002a";
    writeEntry(
      dir,
      makeEntry(dir, exitedId, {
        status: "exited",
        exit_code: 7,
        ended_at: "2026-01-01T00:00:00.000Z",
        pid: 999_999_999,
      }),
    );
    writeFileSync(
      exitPath(dir, exitedId),
      JSON.stringify({ exit_code: 7, signal: null, at: "2026-01-01T00:00:00.000Z" }),
    );

    const stoppedId = "bg-stop-done-0002b";
    writeEntry(
      dir,
      makeEntry(dir, stoppedId, {
        status: "stopped",
        exit_code: null,
        ended_at: "2026-01-02T00:00:00.000Z",
        pid: 999_999_998,
      }),
    );

    const beforeExited = readFileSync(entryPath(dir, exitedId), "utf-8");
    const beforeStopped = readFileSync(entryPath(dir, stoppedId), "utf-8");

    const stop = makeStopTool();

    const r1 = await stop.execute("stop-2a", { task_id: exitedId }, undefined, undefined, fakeCtx(root));
    assert.equal(r1.isError, undefined, "已结束的任务不是错误");
    assert.equal(r1.details.already_finished, true);
    assert.equal(r1.details.stopped, false);
    assert.equal(r1.details.status, "exited");
    assert.equal(r1.details.exit_code, 7);
    assert.match(r1.content[0].text, /already finished/);

    const r2 = await stop.execute("stop-2b", { task_id: stoppedId }, undefined, undefined, fakeCtx(root));
    assert.equal(r2.isError, undefined);
    assert.equal(r2.details.already_finished, true);
    assert.equal(r2.details.status, "stopped");

    // 磁盘上一字未改：exit_code 没有被抹成 null、ended_at 没有被刷新。
    assert.equal(
      readFileSync(entryPath(dir, exitedId), "utf-8"),
      beforeExited,
      "幂等 stop 不得改写已有 exit_code",
    );
    assert.equal(readFileSync(entryPath(dir, stoppedId), "utf-8"), beforeStopped);
  } finally {
    await cleanup(root, []);
  }
});

test("F6 -3 成功 stop：status=stopped 且 ended_at 非空（返回值与注册表都写）", async () => {
  const root = makeProject();
  const cleanupPids: unknown[] = [];
  try {
    // 让命令把自己的 pid 写进文件：即使 taskkill 在罕见的创建竞态下漏掉了它，
    // 清理阶段也能按 pid 精确杀掉，避免临时目录因残留句柄删不掉而假红。
    writeFileSync(join(root, "sleep.mjs"), TREE_CHILD_SRC);
    const cmdPidFile = join(root, "cmd.pid");
    const command = `node "${toPosixPath(join(root, "sleep.mjs"))}" "${toPosixPath(cmdPidFile)}"`;

    const started = await makeStartTool().execute(
      "start-3",
      { command },
      undefined,
      undefined,
      fakeCtx(root),
    );
    assert.equal(started.isError, undefined, `start 失败：${started.content[0]?.text}`);
    const id = started.details.id as string;
    const wrapperPid = started.details.pid as number;
    cleanupPids.push(wrapperPid);

    const wrote = await waitFor(() => existsSync(cmdPidFile), 15_000);
    assert.ok(wrote, "命令必须写出自己的 pid 文件");
    const cmdPid = Number(readFileSync(cmdPidFile, "utf-8"));
    cleanupPids.push(cmdPid);
    assert.ok(isAlive(wrapperPid), "注册的后台任务必须真的在跑");

    const result = await makeStopTool().execute(
      "stop-3",
      { task_id: id },
      undefined,
      undefined,
      fakeCtx(root),
    );
    assert.equal(result.isError, undefined, `stop 不应报错：${result.content[0]?.text}`);
    assert.equal(result.details.stopped, true);
    assert.equal(result.details.status, "stopped");
    assert.ok(
      typeof result.details.ended_at === "string" && (result.details.ended_at as string).length > 0,
      "返回体必须有 ended_at",
    );

    const entry = readEntry(backgroundDir(root), id)!;
    assert.equal(entry.status, "stopped");
    assert.ok(
      typeof entry.ended_at === "string" && entry.ended_at.length > 0,
      "注册表必须有 ended_at",
    );
  } finally {
    await cleanup(root, cleanupPids);
  }
});

test("F6 -4 不存在的 task_id → 明确错误，不抛栈", async () => {
  const root = makeProject();
  try {
    const result = await makeStopTool().execute(
      "stop-4",
      { task_id: "bg-nope-0000" },
      undefined,
      undefined,
      fakeCtx(root),
    );
    assert.equal(result.isError, true);
    assert.match(String(result.details.error), /No background task/);
    assert.match(String(result.details.error), /bg-nope-0000/);
    assert.equal(result.details.stopped, false);
    assert.equal(result.details.already_finished, false);

    // 空 task_id 同样拒绝，且不抛栈。
    const empty = await makeStopTool().execute(
      "stop-4b",
      { task_id: "   " },
      undefined,
      undefined,
      fakeCtx(root),
    );
    assert.equal(empty.isError, true);
    assert.match(String(empty.details.error), /task_id/);
  } finally {
    await cleanup(root, []);
  }
});

test("F6 -5 失败不得谎报：进程仍活时不写 stopped，返回原始 stderr", async () => {
  const root = makeProject();
  let probe: { pid: number; stop: () => void } | undefined;
  try {
    const dir = backgroundDir(root);
    probe = startProbe();
    assert.ok(probe.pid > 0, "探针进程必须真的起来");

    const id = "bg-stop-live-0005";
    writeEntry(dir, makeEntry(dir, id, { pid: probe.pid, status: "running" }));
    const before = readFileSync(entryPath(dir, id), "utf-8");

    // 注入一个「杀不死」的 terminate：不动进程，返回非零退出 + stderr。
    const stop = createBgStopTool({
      deriveContextKey: () => CONTEXT_KEY,
      isSubAgent: false,
      terminate: () => ({ status: 1, stderr: "ERROR: Access is denied." }),
    }) as unknown as BgTool;

    const result = await stop.execute("stop-5", { task_id: id }, undefined, undefined, fakeCtx(root));
    assert.equal(result.isError, true, "进程还活着就不能报成功");
    assert.equal(result.details.stopped, false);
    assert.equal(result.details.already_finished, false);
    assert.equal(result.details.status, "running");
    assert.match(String(result.details.stderr), /Access is denied/);
    assert.match(result.content[0].text, /still alive/);

    // 磁盘不得被写成 stopped。
    assert.equal(
      readFileSync(entryPath(dir, id), "utf-8"),
      before,
      "失败时不得把条目改成 stopped",
    );
    assert.equal(readEntry(dir, id)?.status, "running");
  } finally {
    probe?.stop();
    await cleanup(root, []);
  }
});
