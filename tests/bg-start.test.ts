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
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  backgroundDir,
  createBgStartTool,
  entryPath,
  exitPath,
  listEntries,
  logPath,
  readEntry,
} from "../.pi/extensions/myflow/background.ts";

// F3 — `myflow_bg_start`（`.pi/extensions/myflow/background.ts`）。
//
// 这些用例不跑真实 Pi：`createBgStartTool` 把工具对象导出来，测试直接调
// `execute(id, params, signal, onUpdate, fakeCtx)`。`confirm` 是桩，
// `spawnProcess` 也是桩（用来断言「拒绝时 spawn 调用次数为 0」），
// `runnerPath` 指向仓库里真实的 F1 wrapper。
//
// 每个用例用独立的临时工程目录，并在 finally 里杀掉可能起来的进程，
// 绝不读写仓库真实的 `.myflow/.runtime/`，也绝不留孤儿进程。
//
// 回退点（删掉即变红）：
//   -1：把工具改成 await 子进程 exit → elapsed ≈ 4s，`< 2000ms` 断言变红。
//   -2：spawn 改成从不真正起（或 runnerPath 错）→ 日志标记等不到、条目可能仍在。
//   -3：删掉 `agreed !== true` 分支 → spawn 计数与「无条目」断言变红。
//   -4：无 UI 时放行（不检查 unattended）→ spawn 计数非 0。
//   -5：无 UI 放行时把 confirmed_by 写成 ui-confirm（或结果不回显）→ 文本/条目断言变红。
//   -6：删掉空命令校验 → confirm / spawn 计数非 0。
//   -7：删掉 bgSubAgentRefusal → 子代理用例出现副作用。

const ROOT = join(import.meta.dirname, "..");
const RUNNER = join(ROOT, ".myflow", "scripts", "bg_runner.mjs");
const CONTEXT_KEY = "pi_bgstart";

/** 一个能通过 findProjectRoot 的临时工程根。 */
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-bg-start-"));
  mkdirSync(join(root, ".myflow"), { recursive: true });
  writeFileSync(
    join(root, ".myflow", "workflow.md"),
    "[workflow-state:in_progress]\nBackground.\n[/workflow-state:in_progress]\n",
  );
  return root;
}

/** 默认「TUI 有 UI 且用户同意」的桩 ctx；各用例覆盖所需字段。 */
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

interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

/** 一个不真正起进程的 spawn 桩，记录每次调用。 */
function stubSpawn(): { fn: (...args: unknown[]) => unknown; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args[0] as unknown as SpawnCall);
    return { pid: 4242, unref() {} } as unknown;
  };
  return { fn, calls };
}

/**
 * 一个「异步失败」的 spawn 桩：返回 ChildProcess 形状的对象，`pid` 为 0，
 * `unref()` 为空实现，并在下一个 tick 发出 `'error'`。
 *
 * 这正是真实 `spawn` 报告「创建进程失败」（ENOENT/EAGAIN/ENOMEM，例如
 * Windows 的 ERROR_NO_SYSTEM_RESOURCES）的方式。事件只在注册了监听器时才安全：
 * 无监听器的 `'error'` 会被 EventEmitter 重抛成未捕获异常。
 */
function stubSpawnErroring(error: Error): {
  fn: (...args: unknown[]) => unknown;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args[0] as unknown as SpawnCall);
    const child = new EventEmitter() as EventEmitter & { unref: () => void; pid?: number };
    child.pid = 0;
    child.unref = () => {};
    process.nextTick(() => child.emit("error", error));
    return child;
  };
  return { fn, calls };
}

/** 一个同步抛错的 spawn 桩：模拟 `spawn` 在建立子进程前就抛出。 */
function stubSpawnThrowing(error: Error): {
  fn: (...args: unknown[]) => unknown;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args[0] as unknown as SpawnCall);
    throw error;
  };
  return { fn, calls };
}

function makeTool(
  overrides: {
    isSubAgent?: boolean;
    spawnProcess?: unknown;
    runnerPath?: string;
  } = {},
): { execute: (...args: unknown[]) => Promise<ToolResult> } {
  return createBgStartTool({
    deriveContextKey: () => CONTEXT_KEY,
    isSubAgent: overrides.isSubAgent ?? false,
    runnerPath: overrides.runnerPath ?? RUNNER,
    ...(overrides.spawnProcess ? { spawnProcess: overrides.spawnProcess } : {}),
  }) as unknown as { execute: (...args: unknown[]) => Promise<ToolResult> };
}

/**
 * 杀掉一个进程树。Windows 上必须从 Node 用参数数组调 `taskkill`：经 Git Bash
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

/** finally 里统一的清理：先杀进程树，给文件句柄一点时间释放，再删临时目录。 */
async function cleanup(root: string, pid: unknown): Promise<void> {
  killTree(pid);
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows 上偶尔仍被占用：临时目录留给 OS 清理，不因此让测试失败 */
  }
}

test("F3 -1 起一个长跑命令 → 工具在 2000ms 内返回（立刻返回）", async () => {
  const root = makeProject();
  let pid: unknown;
  try {
    const tool = makeTool();
    const ctx = fakeCtx(root);
    // 探针由 shell 启动（`cmd.exe /d /s /c "…"`），与生产路径一致。
    // 只睡 4s：断言界是 2000ms，4s 已是它的两倍，足以区分「立刻返回」与「等到退出」；
    // 10s 毫无必要，只会在资源紧张时把进程多留 8 秒。
    // ⚠️ 该探针需要 PATH 上有 `powershell`（Windows-only）；此前的 `node -e` 探针只需 `node`。
    const longRunning = 'powershell -NoProfile -Command "Start-Sleep -Seconds 4"';

    const startedAt = Date.now();
    const result = await tool.execute("call-1", { command: longRunning }, undefined, undefined, ctx);
    const elapsed = Date.now() - startedAt;

    pid = result.details.pid;

    // 可测上界，不是「感觉快」。
    assert.ok(elapsed < 2000, `工具必须在 2000ms 内返回，实际 ${elapsed}ms`);
    assert.equal(result.details.started, true);
    assert.equal(typeof result.details.id, "string");
    assert.ok((result.details.id as string).startsWith("bg-"));
    assert.equal(result.details.confirmed_by, "ui-confirm");
    assert.ok(typeof pid === "number" && (pid as number) > 0, "必须回报一个真实 pid");
  } finally {
    await cleanup(root, pid);
  }
});

test("F3 -2 confirm 为 true → 进程真的起来，且注册表条目已写", async () => {
  const root = makeProject();
  let pid: unknown;
  try {
    let confirms = 0;
    const ctx = fakeCtx(root, {
      ui: {
        confirm: async () => {
          confirms += 1;
          return true;
        },
      },
    });
    // 必须仍然产生输出：下面的断言靠日志里出现 `bg-start-marker` 来证明
    // 「子进程真的起来了」。PowerShell 写的是 CRLF，断言用的是 includes，不受影响。
    const command =
      'powershell -NoProfile -Command "Write-Output bg-start-marker; Start-Sleep -Seconds 4"';
    const result = await makeTool().execute(
      "call-2",
      { command, description: "alive check" },
      undefined,
      undefined,
      ctx,
    );

    pid = result.details.pid;
    const id = result.details.id as string;
    const dir = backgroundDir(root);

    assert.equal(confirms, 1, "有 UI 时 confirm 必须被调用一次");
    assert.equal(result.details.started, true);

    // 注册表条目按 design.md §3.1 落盘。
    assert.ok(existsSync(entryPath(dir, id)), "注册表条目必须已写");
    const entry = JSON.parse(readFileSync(entryPath(dir, id), "utf-8"));
    assert.equal(entry.id, id);
    assert.equal(entry.command, command);
    assert.equal(entry.description, "alive check");
    assert.equal(entry.status, "running");
    assert.equal(entry.confirmed_by, "ui-confirm");
    assert.equal(entry.started_by_context_key, CONTEXT_KEY);
    assert.equal(entry.pid, pid);

    // 进程真的在跑：它的输出到了日志文件（内核直写，跨进程可见）。
    const grew = await waitFor(
      () => existsSync(logPath(dir, id)) && readFileSync(logPath(dir, id), "utf-8").includes("bg-start-marker"),
    );
    assert.ok(grew, "命令的输出必须进日志文件，证明子进程真的起来了");
  } finally {
    await cleanup(root, pid);
  }
});

test("F3 -3 confirm 为 false → 不 spawn、不写注册表", async () => {
  const root = makeProject();
  try {
    const { fn, calls } = stubSpawn();
    let confirms = 0;
    const ctx = fakeCtx(root, {
      ui: {
        confirm: async () => {
          confirms += 1;
          return false;
        },
      },
    });

    const result = await makeTool({ spawnProcess: fn }).execute(
      "call-3",
      { command: "echo hi" },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.started, false);
    assert.equal(result.details.via, "cancelled");
    assert.equal(confirms, 1);
    assert.equal(calls.length, 0, "用户拒绝后绝不能 spawn");
    assert.deepEqual(listEntries(backgroundDir(root)).entries, [], "拒绝后不得写注册表条目");
  } finally {
    await cleanup(root, undefined);
  }
});

test("F3 -4 无 UI 且未显式 unattended → 拒绝、返回指令、不 spawn", async () => {
  const root = makeProject();
  try {
    const { fn, calls } = stubSpawn();
    const ctx = fakeCtx(root, { hasUI: false, mode: "print", ui: undefined });

    const result = await makeTool({ spawnProcess: fn }).execute(
      "call-4",
      { command: "echo hi" },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.started, false);
    assert.equal(result.details.via, "no-ui");
    const instruction = String(result.details.instruction);
    assert.match(instruction, /unattended/, "指令必须说明可用 unattended 显式放行");
    assert.match(instruction, /mode=print/);
    assert.equal(calls.length, 0, "无 UI 且未放行时绝不能 spawn");
    assert.deepEqual(listEntries(backgroundDir(root)).entries, []);
  } finally {
    await cleanup(root, undefined);
  }
});

test("F3 -5 无 UI + unattended:true → 放行，条目与结果都留痕 no-ui-explicit", async () => {
  const root = makeProject();
  let pid: unknown;
  try {
    const ctx = fakeCtx(root, { hasUI: false, mode: "print", ui: undefined });
    const command = 'node -e "process.exit(0)"';

    const result = await makeTool().execute(
      "call-5",
      { command, unattended: true },
      undefined,
      undefined,
      ctx,
    );

    pid = result.details.pid;
    const id = result.details.id as string;
    const dir = backgroundDir(root);

    assert.equal(result.details.started, true);
    assert.equal(result.details.confirmed_by, "no-ui-explicit");

    // R8：结果文本里必须显式回显「未经用户确认」。
    const text = result.content[0].text;
    assert.match(text, /confirmed_by: no-ui-explicit/);
    assert.match(text, /did NOT confirm/);

    const entry = JSON.parse(readFileSync(entryPath(dir, id), "utf-8"));
    assert.equal(entry.confirmed_by, "no-ui-explicit", "注册表条目也要留痕");

    // 等命令自己结束，确保这个用例不在机器上留下孤儿。
    const finished = await waitFor(() => existsSync(exitPath(dir, id)), 10_000);
    assert.ok(finished, "快速命令应当写完 .exit 记录");
  } finally {
    await cleanup(root, pid);
  }
});

test("F3 -6 command 为空 → 拒绝，且不弹窗、不 spawn", async () => {
  const root = makeProject();
  try {
    const { fn, calls } = stubSpawn();
    let confirms = 0;
    const ctx = fakeCtx(root, {
      ui: {
        confirm: async () => {
          confirms += 1;
          return true;
        },
      },
    });
    const tool = makeTool({ spawnProcess: fn });

    for (const command of ["", "   ", undefined]) {
      const result = await tool.execute("call-6", { command }, undefined, undefined, ctx);
      assert.equal(result.isError, true);
      assert.equal(result.details.started, false);
    }

    assert.equal(confirms, 0, "空命令不得弹窗");
    assert.equal(calls.length, 0, "空命令不得 spawn");
    assert.deepEqual(listEntries(backgroundDir(root)).entries, []);
  } finally {
    await cleanup(root, undefined);
  }
});

test("F3 -7 注入 isSubAgent → 工具内部守卫拒绝，无弹窗/无 spawn/无条目", async () => {
  const root = makeProject();
  try {
    const { fn, calls } = stubSpawn();
    let confirms = 0;
    const ctx = fakeCtx(root, {
      ui: {
        confirm: async () => {
          confirms += 1;
          return true;
        },
      },
    });

    const result = await makeTool({ isSubAgent: true, spawnProcess: fn }).execute(
      "call-7",
      { command: "echo hi" },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.isError, true);
    assert.match(String(result.details.error), /main session/);
    assert.equal(confirms, 0, "子代理拒绝必须发生在弹窗之前");
    assert.equal(calls.length, 0);
    assert.deepEqual(listEntries(backgroundDir(root)).entries, []);
  } finally {
    await cleanup(root, undefined);
  }
});

test("F3 -8 spawn 异步 'error' → 不崩，且写入 spawn_error 并自愈为 exited", async () => {
  const root = makeProject();
  try {
    const boom = new Error("spawn EAGAIN: resource temporarily unavailable");
    const { fn, calls } = stubSpawnErroring(boom);
    const ctx = fakeCtx(root);

    // 若实现未注册 'error' 监听器，spawn 桩在下一个 tick emit('error') 时会被
    // EventEmitter 重抛成未捕获异常，用例根本走不到下面的断言（回退即红）。
    const result = await makeTool({ spawnProcess: fn }).execute(
      "call-8",
      { command: "echo hi" },
      undefined,
      undefined,
      ctx,
    );

    // 工具已经返回值：失败是靠注册表条目诊断的，不是靠阻塞返回。
    assert.equal(result.details.started, true);
    assert.equal(typeof result.details.id, "string");
    assert.equal(calls.length, 1, "确认之后必须真的调用 spawn");

    const id = result.details.id as string;
    const dir = backgroundDir(root);

    // 失败原因必须真的落盘（轮询，不靠固定 sleep）。
    const recorded = await waitFor(() => {
      const entry = readEntry(dir, id);
      return typeof entry?.spawn_error === "string" && entry.spawn_error.length > 0;
    }, 1000, 20);
    assert.ok(recorded, "spawn 失败原因必须写入条目的 spawn_error");

    const entry = readEntry(dir, id)!;
    assert.match(String(entry.spawn_error), /EAGAIN/);
    assert.equal(entry.status, "exited", "异步失败必须自愈为 exited");
    assert.ok(
      typeof entry.ended_at === "string" && entry.ended_at.length > 0,
      "结束时间必须写入",
    );
  } finally {
    await cleanup(root, undefined);
  }
});

test("F3 -9 spawn 同步抛错 → 返回错误，且不写任何注册表条目", async () => {
  const root = makeProject();
  try {
    const { fn, calls } = stubSpawnThrowing(new Error("spawn EPERM: operation not permitted"));
    const ctx = fakeCtx(root);

    const result = await makeTool({ spawnProcess: fn }).execute(
      "call-9",
      { command: "echo hi" },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.isError, true);
    assert.match(String(result.details.error), /Could not start the background runner/);
    assert.equal(calls.length, 1, "确认之后尝试了 spawn");
    assert.deepEqual(
      listEntries(backgroundDir(root)).entries,
      [],
      "同步 spawn 失败必须在写条目之前返回，注册表不得残留条目",
    );
  } finally {
    await cleanup(root, undefined);
  }
});
