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
import { basename, dirname, join } from "node:path";
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
  type BgToolRegistration,
} from "../.pi/extensions/myflow/background/index.ts";

// F3 — `myflow_bg_start`（`.pi/extensions/myflow/background/start.ts`）。
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
//   -10：删掉 `onStarted` 调用的 try/catch → 成功的 start 变成被拒绝（promise
//        reject），用例变红。
//   H5 -1：删掉 `--cwd` 透传（或把条目 cwd 写回 root）→ 命令在错误目录执行，
//        marker 里的路径不等于 `<root>/app`。
//   H5 -2/-3/-4：删掉 `resolveBgCwd` 的包含判定（或目录存在性判定）→ 越界路径
//        被接受，confirm/spawn 计数非 0、注册表非空。
//   H5 -5：把确认门的 message 改回只传 command → 断言里读不到 cwd。

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

/**
 * 一个「创建成功」的 spawn 桩：返回 `ChildProcess` 形状的对象（`pid`、`unref()`，
 * 以及 `EventEmitter` 的 `on`），但从不发 `'error'`、也从不真的起进程。
 *
 * 与 `stubSpawn()` 的区别是它有 `on`：真实代码在 spawn 之后会挂 `'error'` 监听器，
 * 所以没有 `on` 的桩只能覆盖「在 spawn 处就返回」的拒绝路径。这个桩用于走到
 * spawn 之后的两步（写条目、`onStarted`）。
 */
function stubSpawnSucceeding(pid = 4242): {
  fn: (...args: unknown[]) => unknown;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args[0] as unknown as SpawnCall);
    const child = new EventEmitter() as EventEmitter & { unref: () => void; pid?: number };
    child.pid = pid;
    child.unref = () => {};
    return child;
  };
  return { fn, calls };
}

function makeTool(
  overrides: {
    isSubAgent?: boolean;
    spawnProcess?: (...args: unknown[]) => unknown;
    runnerPath?: string;
  } = {},
): { execute: (...args: unknown[]) => Promise<ToolResult> } {
  return createBgStartTool({
    deriveContextKey: () => CONTEXT_KEY,
    isSubAgent: overrides.isSubAgent ?? false,
    runnerPath: overrides.runnerPath ?? RUNNER,
    ...(overrides.spawnProcess ? { spawnProcess: overrides.spawnProcess } : {}),
  } as unknown as BgToolRegistration) as unknown as {
    execute: (...args: unknown[]) => Promise<ToolResult>;
  };
}

/**
 * 杀掉一个进程树。Windows 上必须从 Node 用参数数组调 `taskkill`：经 Git Bash
 * 转发会把 `/F` 改写成 `F:/`（design.md §4.4 已实测）。
 */
function killTree(pid: unknown): void {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;
  spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
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
 * finally 里统一的清理：先杀进程树，给文件句柄一点时间释放，再删临时目录。
 *
 * 时间上界：200ms 初始等待 + 最多 10 次 × 100ms 退避重试 ≈ 1.2s。
 *
 * `maxRetries > 0` 是缺的那一环：Node 的 `rmSync` 只在此时对
 * EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM 退避重试（`force: true` 只忽略 ENOENT，
 * 不重试占用）。detached 后台任务（runner + Git Bash 外壳）的日志句柄是内核直写的，
 * 可能比 `taskkill` + 200ms 活得更久；另一个边界是 4s 的 `sleep` 已自然结束、
 * `taskkill /T` 打在已死 pid 上失败，此时只能靠等待让持有者退出。
 *
 * 删完显式断言目录已消失；删不掉就**抛错让测试失败**（错误信息带上根因提示），
 * 不再静默留给 OS —— 一个泄漏的临时目录会伪装成「测试通过」。
 */
async function cleanup(root: string, pid: unknown): Promise<void> {
  killTree(pid);
  // 给被杀的进程树一点时间释放日志文件句柄。
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    throw new Error(
      `清理临时目录失败：${root}\n` +
        "可能原因：detached 后台任务（runner + Git Bash 外壳）的日志句柄仍未释放，" +
        "或 taskkill 打在已自然退出的 pid 上而进程尚未完全退出。\n" +
        `原始错误：${String(error)}`,
    );
  }
  assert.ok(!existsSync(root), `临时目录必须已删除：${root}`);
}

test("F3 -1 起一个长跑命令 → 工具在 2000ms 内返回（立刻返回）", async () => {
  const root = makeProject();
  let pid: unknown;
  try {
    const tool = makeTool();
    const ctx = fakeCtx(root);
    // 探针由 runner 解析出的外壳（默认 Git Bash → `bash -lc`）启动，与生产路径一致。
    // 只睡 4s：断言界是 2000ms，4s 已是它的两倍，足以区分「立刻返回」与「等到退出」；
    // 10s 毫无必要，只会在资源紧张时把进程多留 8 秒。
    // 此前用的是 `powershell -NoProfile ...`（Windows-only、需要 PATH 上有 powershell），
    // 本批改为 bash 语义的 `sleep`，不再依赖 powershell。
    const longRunning = "sleep 4";

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
    // 「子进程真的起来了」。命令经 Git Bash（`bash -lc`）执行：`echo` 之后
    // 用 `;` 接 `sleep`，语义与之前的 PowerShell 写法等价。
    const command = "echo bg-start-marker; sleep 4";
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

    // H6 契约变更：条目现在**先于** spawn 写下（ADR-8），所以同步失败必然留下一条
    // 记录。旧断言要求“注册表为空”，它编码的是旧时序（spawn → 写条目），已不再成立。
    // 新的期望更强：条目存在、被判为 `exited`、带 `spawn_error`、且 pid 仍是 0
    // （没有任何进程被创建）。
    // 回退点：删掉 catch 里的 `recordSpawnFailure(error)` → 条目留在 `starting`（或被
    // 删除），下面两条断言变红。
    const entries = listEntries(backgroundDir(root)).entries;
    assert.equal(entries.length, 1, "先写条目后 spawn：同步失败必须留下一条已结束的记录");
    const failure = entries[0];
    assert.equal(failure.status, "exited", "失败不得留下 starting 条目");
    assert.equal(failure.pid, 0, "没有任何进程被创建，pid 必须是未确认的 0");
    assert.match(String(failure.spawn_error), /EPERM/);
  } finally {
    await cleanup(root, undefined);
  }
});

test("F3 -10 onStarted 抛错被吞：已经起来的 start 仍是成功", async () => {
  const root = makeProject();
  try {
    const { fn, calls } = stubSpawnSucceeding();
    // 记账回调收到 id 后抛出。断言只在回调**之外**做：回调里的断言会被这层
    // try/catch 一起吞掉，那正是本用例要防的那种「静默失败」。
    const seen: string[] = [];
    const tool = createBgStartTool({
      deriveContextKey: () => CONTEXT_KEY,
      isSubAgent: false,
      runnerPath: RUNNER,
      spawnProcess: fn as never,
      onStarted: (id: string) => {
        seen.push(id);
        throw new Error("bookkeeping blew up");
      },
    }) as unknown as { execute: (...args: unknown[]) => Promise<ToolResult> };

    const result = await tool.execute(
      "call-10",
      { command: "echo hi" },
      undefined,
      undefined,
      fakeCtx(root),
    );

    // 回退点：删掉 `registration.onStarted(id)` 那一层 try/catch → 这个 await 直接
    // reject（进程已经起了，工具却报失败），下面每条断言都拿不到。
    assert.equal(
      result.isError,
      undefined,
      `onStarted 抛错不得把已成功的 start 变成错误：${result.content[0]?.text}`,
    );
    assert.equal(result.details.started, true);
    const id = result.details.id as string;
    assert.equal(calls.length, 1, "确认之后必须真的调用 spawn");
    assert.deepEqual(seen, [id], "onStarted 必须被调用一次，且拿到刚写下的 id");

    // 条目已落盘：回调抛错没有回滚一个已经发生的启动。
    const entry = readEntry(backgroundDir(root), id);
    assert.ok(entry, "注册表条目必须存在（进程已经在跑了）");
    assert.equal(entry!.status, "running");
  } finally {
    await cleanup(root, undefined);
  }
});

// ---------------------------------------------------------------------------
// H5 — `cwd`（R5 / ADR-9）
//
// `cwd` 是命令真正执行的目录，所以它有两条约束：必须在项目根之内（与
// `writesUnder` 共用同一个按段、大小写不敏感、折叠 `..` 的包含判定），并且必须
// 是已存在的目录。校验发生在确认门**之前**：拒绝时不弹窗、不写条目、不 spawn。
// ---------------------------------------------------------------------------

/**
 * 在 `bash -lc` 里调用本机的 node（不依赖 PATH 上有 node）。
 *
 * `process.execPath` 里可能有空格（Windows 的 `C:\Program Files\nodejs\`），
 * 所以用单引号包住：POSIX 单引号内一切字面量，路径里的反斜杠不会被 bash 转义。
 */
function nodeCommand(script: string): string {
  const quoted = `'${process.execPath.replace(/'/g, "'\''")}'`;
  return `${quoted} -e "${script}"`;
}

test("H5 -1 cwd:'app' → 命令真的在 <root>/app 里执行（真进程）", async () => {
  const root = makeProject();
  mkdirSync(join(root, "app"), { recursive: true });
  let pid: unknown;
  try {
    const result = await makeTool().execute(
      "call-h5-1",
      // 回退点：删掉 spawn 参数里的 `--cwd`（或把条目/参数退回 root）→ 命令在项目根
      // 执行，marker 内容是 root 而不是 root/app，断言变红。
      { command: `${nodeCommand("process.stdout.write(process.cwd())")} > marker.txt`, cwd: "app" },
      undefined,
      undefined,
      fakeCtx(root),
    );

    pid = result.details.pid;
    assert.equal(result.details.started, true);

    const id = result.details.id as string;
    const dir = backgroundDir(root);
    const marker = join(root, "app", "marker.txt");

    const wrote = await waitFor(() => existsSync(marker) && readFileSync(marker, "utf-8").length > 0);
    assert.ok(wrote, "命令必须把 cwd 写进 app/marker.txt，证明它真的在 app 里执行");
    assert.equal(
      readFileSync(marker, "utf-8").trim(),
      join(root, "app"),
      "工作目录必须是解析后的 <root>/app",
    );

    // 注册表条目记录解析后的绝对 cwd，而不是用户传的相对路径。
    const entry = readEntry(dir, id)!;
    assert.equal(entry.cwd, join(root, "app"));
  } finally {
    await cleanup(root, pid);
  }
});

test("H5 -2 cwd:'../outside' → 拒绝，零副作用", async () => {
  const root = makeProject();
  // 逃逸目标必须是一个**真实存在的目录**，否则放行/拒绝可能来自「不存在」而不是
  // 包含判定（那样这条用例就测不到 `..` 折叠之后的那一步）。名字带上 root 的随机
  // 后缀，保证与其它并行用例不撞，且在 finally 里精确删除。
  const outside = join(dirname(root), `outside-${basename(root)}`);
  mkdirSync(outside, { recursive: true });
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

    // 回退点：删掉 resolveBgCwd 的包含判定 → `..` 逃逸被接受（目标目录存在，
    // 存在性/目录判定都会通过），confirm/spawn 计数非 0。
    const result = await makeTool({ spawnProcess: fn }).execute(
      "call-h5-2",
      { command: "echo hi", cwd: `../${basename(outside)}` },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.details.started, false);
    assert.equal(result.details.via, "error");
    assert.match(String(result.details.error), /inside the project root/);
    assert.equal(confirms, 0, "越界的 cwd 必须在弹窗之前被拒绝");
    assert.equal(calls.length, 0, "越界的 cwd 绝不能 spawn");
    assert.deepEqual(listEntries(backgroundDir(root)).entries, [], "拒绝不得写注册表条目");
  } finally {
    rmSync(outside, { recursive: true, force: true });
    await cleanup(root, undefined);
  }
});

test("H5 -3 根外的绝对路径（真实存在的目录）→ 拒绝，零副作用", async () => {
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
    // 一个**真实存在**的目录，但它在项目根之外：证明拒绝来自包含判定，
    // 而不是碰巧因为「目录不存在」而被挡下。
    const outside = tmpdir();
    assert.ok(existsSync(outside));

    // 回退点：删掉包含判定（只留存在性/目录判定）→ 这条用例被放行。
    const result = await makeTool({ spawnProcess: fn }).execute(
      "call-h5-3",
      { command: "echo hi", cwd: outside },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.details.via, "error");
    assert.match(String(result.details.error), /inside the project root/);
    assert.equal(confirms, 0);
    assert.equal(calls.length, 0);
    assert.deepEqual(listEntries(backgroundDir(root)).entries, []);
  } finally {
    await cleanup(root, undefined);
  }
});

test("H5 -4 不存在的目录 → 拒绝，零副作用", async () => {
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

    // 回退点：删掉目录存在性判定 → 路径通过包含判定后被接受，计数非 0。
    const result = await makeTool({ spawnProcess: fn }).execute(
      "call-h5-4",
      { command: "echo hi", cwd: "no-such-dir" },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.details.via, "error");
    assert.match(String(result.details.error), /existing directory/);
    assert.equal(confirms, 0);
    assert.equal(calls.length, 0);
    assert.deepEqual(listEntries(backgroundDir(root)).entries, []);
  } finally {
    await cleanup(root, undefined);
  }
});

test("H5 -5 确认门文本包含 cwd（非根与等于根时都显示）", async () => {
  const root = makeProject();
  mkdirSync(join(root, "app"), { recursive: true });
  try {
    const messages: Array<{ title: string; message: string }> = [];
    const ctx = fakeCtx(root, {
      ui: {
        confirm: async (title: string, message: string) => {
          messages.push({ title, message });
          return false; // 只要看见文本，不必真的起进程
        },
      },
    });

    // 回退点：把 message 改回只传 `command` → 下面的 cwd 断言一条都读不到。
    await makeTool().execute(
      "call-h5-5a",
      { command: "pwd > marker.txt", cwd: "app" },
      undefined,
      undefined,
      ctx,
    );
    await makeTool().execute("call-h5-5b", { command: "echo hi" }, undefined, undefined, ctx);

    assert.equal(messages.length, 2, "每次确认都要弹窗一次");
    assert.ok(messages[0].message.includes(join(root, "app")), "确认文本必须写出解析后的 cwd");
    assert.ok(messages[0].message.includes("pwd > marker.txt"), "确认文本必须仍然写出命令");
    // S-2：等于项目根时也显示，避免「看起来像在别处」的歧义。
    assert.ok(messages[1].message.includes(root), "cwd 等于项目根时也要显示目录");
  } finally {
    await cleanup(root, undefined);
  }
});

// ---------------------------------------------------------------------------
// H6 — `starting` + `.pid` 握手（ADR-8 / R6）
//
// 起点与终点都是顺序：条目必须在 spawn **之前**存在（`status:"starting"`、
// `pid:0`），spawn 之后才回填 pid 与 `running`。回填必须发生在 `execute`
// 返回之前，否则调用方会看到一个“已启动但还写着 starting”的任务。
// ---------------------------------------------------------------------------

test("H6 -11 spawn 被调用时条目已存在（starting/pid 0），返回后回填 running", async () => {
  const root = makeProject();
  try {
    const dir = backgroundDir(root);

    // 在 spawn 桩**内部**读盘：这是唯一能证明“先后顺序”的时刻。
    // 回退点：把 `writeEntry(dir, entry)` 挪回 spawn 之后（旧时序）→ 这里读到 0 条
    // 条目，`observed.status` 断言变红。
    const observed: Array<{ count: number; status?: string; pid?: number }> = [];
    const stub = (..._args: unknown[]) => {
      const entries = listEntries(dir).entries;
      observed.push({ count: entries.length, status: entries[0]?.status, pid: entries[0]?.pid });
      const child = new EventEmitter() as EventEmitter & { unref: () => void; pid?: number };
      child.pid = 4242;
      child.unref = () => {};
      return child;
    };

    const result = await makeTool({ spawnProcess: stub }).execute(
      "call-h6-11",
      { command: "echo hi" },
      undefined,
      undefined,
      fakeCtx(root),
    );

    assert.equal(result.details.started, true);
    assert.equal(observed.length, 1, "spawn 必须被调用一次");
    assert.equal(observed[0].count, 1, "spawn 时注册表里必须已经有这一条");
    assert.equal(observed[0].status, "starting", "spawn 时条目必须写着 starting");
    assert.equal(observed[0].pid, 0, "spawn 时 pid 必须还是“未确认”的 0");

    // 返回后回填：pid 来自 spawn，状态是 running。
    const id = result.details.id as string;
    const entry = readEntry(dir, id)!;
    assert.equal(entry.status, "running", "回填必须发生在 execute 返回之前");
    assert.equal(entry.pid, 4242);
    assert.equal(result.details.pid, 4242);
  } finally {
    await cleanup(root, undefined);
  }
});
