import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import {
  BACKGROUND_DIR,
  backgroundDir,
  createBgListTool,
  entryPath,
  exitPath,
  logPath,
  readEntry,
  writeEntry,
  type BackgroundEntry,
  type BgListRow,
} from "../.pi/extensions/myflow/background.ts";

// F5 — `myflow_bg_list`（`.pi/extensions/myflow/background.ts`）。
//
// 这些用例不跑真实 Pi：`createBgListTool` 把工具对象导出来，测试直接调
// `execute(id, params, signal, onUpdate, fakeCtx)`。注册表条目与日志都是手工
// 造出来的，`now` 通过注入固定，所以用例完全确定、不依赖系统时钟。
//
// 每个用例用独立的临时工程目录，并在 finally 里杀掉可能起来的探针进程，绝不
// 读写仓库真实的 `.myflow/.runtime/`，也绝不留孤儿进程。
//
// 回退点（删掉即变红）：
//   -1：删掉 pid 存活检测 → running 那条变成 exited；或状态不按 `.exit` 判定 → 其余断言变红。
//   -2：删掉 `writeEntry`（只返回自愈结果不回写）→ 磁盘条目仍是 running，断言变红。
//   -3：把 `current_session` 恒为 true/false → 两把不同 deriveContextKey 的断言变红。
//   -4：`prune: true` 不调 prune（或 prune 无条件删）→ 计数/文件存在性断言变红。
//   -5：删掉 `spawn_error` 守卫 → 那条（pid 活着）被误报成 running；或行里不展示原因 → 文本断言变红。
//   -6：listEntries 的 warnings 被吞掉 → warnings 计数与文本断言变红。
//   -7：include_finished 反向（false 时反而全列）→ 过滤断言变红。
//   -8：删掉 `resolveStatus` 里「已记 `exited`」那一档（D1）→ 自愈过的条目被复用 pid
//       复活成 running 并回写磁盘，断言变红。
//   -9：`resolveAndHeal` 不包 try/catch、或回写失败仍算 healed（D3）→ 整个 list 抛错 /
//       healed 计数断言变红。

const KEY = "pi_bglist";
const OTHER_KEY = "pi_bglist_other";

/** 一个能通过 findProjectRoot 的临时工程根。 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-bg-list-"));
  mkdirSync(join(root, ".myflow"), { recursive: true });
  writeFileSync(
    join(root, ".myflow", "workflow.md"),
    "[workflow-state:in_progress]\nBackground.\n[/workflow-state:in_progress]\n",
  );
  mkdirSync(backgroundDir(root), { recursive: true });
  return root;
}

/** 造一条注册表条目（字段同 design.md §3.1，log/exit_file 存相对路径）。 */
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
    started_by_context_key: KEY,
    confirmed_by: "ui-confirm",
    ...overrides,
  };
}

/** 落盘一条条目，并可选地带上它真实运行会留下的 `.exit`。 */
function seed(
  dir: string,
  entry: BackgroundEntry,
  options: { exit?: Record<string, unknown> } = {},
): void {
  writeEntry(dir, entry);
  writeFileSync(logPath(dir, entry.id), `log for ${entry.id}\n`);
  if (options.exit) {
    writeFileSync(exitPath(dir, entry.id), JSON.stringify(options.exit));
  }
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

interface ListTool {
  execute: (...args: unknown[]) => Promise<ToolResult>;
}

/** 一个不依赖真实会话的工具实例；`now` 可注入以固定 prune 边界。 */
function makeTool(contextKey: string = KEY, now?: () => number): ListTool {
  return createBgListTool({
    deriveContextKey: () => contextKey,
    isSubAgent: false,
    ...(now ? { now } : {}),
  }) as unknown as ListTool;
}

function fakeCtx(root: string) {
  return { cwd: root };
}

function run(
  root: string,
  params: Record<string, unknown> = {},
  contextKey: string = KEY,
  now?: () => number,
): Promise<ToolResult> {
  return makeTool(contextKey, now).execute("call", params, undefined, undefined, fakeCtx(root));
}

/** 结果里的 tasks，带类型。 */
function tasksOf(result: ToolResult): BgListRow[] {
  return result.details.tasks as BgListRow[];
}

/** 按 id 建索引，方便断言。 */
function byId(rows: BgListRow[]): Record<string, BgListRow> {
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

/**
 * 起一个真实存活、短命的探针进程，供 `-1`/`-7` 的 running 条目使用。
 * `stop()` 在 finally 里调用，确保不留孤儿。
 */
function startProbe(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ["-e", "setTimeout(function(){}, 4000)"], {
    stdio: "ignore",
  });
  const pid = child.pid ?? 0;
  const stop = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    // Windows：仍然从 Node 用参数数组调 taskkill（经 Git Bash 转发会把 /F 改成 F:/）。
    if (process.platform === "win32" && pid > 0) {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    }
  };
  return { pid, stop };
}

test("F5 -1 能区分 running / exited / stopped，并各自给出正确的 exit_code", async () => {
  const root = makeRoot();
  let probe: { pid: number; stop: () => void } | undefined;
  try {
    const dir = backgroundDir(root);
    probe = startProbe();
    assert.ok(probe.pid > 0, "探针进程必须真的起来");

    const runningId = "bg-list-run-0001";
    const exitedId = "bg-list-exit-0002";
    const stoppedId = "bg-list-stop-0003";

    // 真·存活进程：无 `.exit`，pid 活着 → running。
    seed(dir, makeEntry(dir, runningId, { pid: probe.pid, status: "running" }));
    // 预置 `.exit` → exited，退出码来自记录。
    seed(
      dir,
      makeEntry(dir, exitedId, { pid: 999_999_999, status: "running" }),
      { exit: { exit_code: 0, signal: null, at: new Date().toISOString() } },
    );
    // 预置 stopped（pid 已死、无 `.exit`）→ stopped。
    seed(dir, makeEntry(dir, stoppedId, { pid: 999_999_999, status: "stopped" }));

    const result = await run(root);
    assert.equal(result.isError, undefined);

    const rows = byId(tasksOf(result));
    assert.equal(rows[runningId].status, "running");
    assert.equal(rows[runningId].exit_code, null);
    assert.equal(rows[exitedId].status, "exited");
    assert.equal(rows[exitedId].exit_code, 0);
    assert.equal(rows[stoppedId].status, "stopped");
    assert.equal(rows[stoppedId].exit_code, null);
    assert.equal(result.details.count, 3);
  } finally {
    probe?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("F5 -2 自愈并回写：pid 已死、无 .exit、条目写着 running → 磁盘被改成 exited", async () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-list-heal-0004";
    writeEntry(dir, makeEntry(dir, id, { status: "running", pid: 999_999_999, exit_code: null }));

    // 前置条件：磁盘上确实是 running（否则本用例证明不了回写）。
    assert.equal(readEntry(dir, id)?.status, "running");

    const result = await run(root);
    const row = byId(tasksOf(result))[id];
    assert.equal(row.status, "exited");
    assert.equal(row.exit_code, null);
    assert.equal(result.details.healed, 1, "自愈条目数必须报告");

    // 关键：只断言返回值是不够的 —— 磁盘上的条目必须真的被改写。
    const after = readEntry(dir, id);
    assert.equal(after?.status, "exited", "自愈结果必须回写磁盘");
    assert.equal(after?.exit_code, null);
    assert.ok(
      typeof after?.ended_at === "string" && after.ended_at.length > 0,
      "自愈为已结束时要补上 ended_at，否则将来 prune 永远删不掉它",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F5 -3 标出哪条是本会话起的（两个不同 context key）", async () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const mineId = "bg-list-mine-0005";
    const theirsId = "bg-list-theirs-0006";
    seed(dir, makeEntry(dir, mineId, { started_by_context_key: KEY, pid: 999_999_999 }));
    seed(dir, makeEntry(dir, theirsId, { started_by_context_key: OTHER_KEY, pid: 999_999_999 }));

    const rows = byId(tasksOf(await run(root, {}, KEY)));
    assert.equal(rows[mineId].current_session, true);
    assert.equal(rows[theirsId].current_session, false);

    // 换一个会话看：标记必须跟着 context key 走，而不是恒为 true/false。
    const otherRows = byId(tasksOf(await run(root, {}, OTHER_KEY)));
    assert.equal(otherRows[mineId].current_session, false);
    assert.equal(otherRows[theirsId].current_session, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F5 -4 prune:true 返回删除计数，且只删「已结束且 >24h」的", async () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const nowMs = Date.now();
    const clock = () => nowMs;
    const hour = 60 * 60 * 1000;
    const iso = (ms: number) => new Date(ms).toISOString();

    const runningId = "bg-list-prune-run-0007";
    const freshId = "bg-list-prune-fresh-0008";
    const oldId = "bg-list-prune-old-0009";

    // 运行中：永不动。
    seed(dir, makeEntry(dir, runningId, { status: "running", pid: process.pid }));
    // 已结束但只有 1 小时：太新。
    seed(dir, makeEntry(dir, freshId, { status: "exited", pid: 999_999_999, ended_at: iso(nowMs - hour) }), {
      exit: { exit_code: 0, signal: null, at: iso(nowMs - hour) },
    });
    // 已结束且 25 小时：该删。
    seed(dir, makeEntry(dir, oldId, { status: "exited", pid: 999_999_999, ended_at: iso(nowMs - 25 * hour) }), {
      exit: { exit_code: 1, signal: null, at: iso(nowMs - 25 * hour) },
    });

    const result = await run(root, { prune: true }, KEY, clock);
    assert.equal(result.details.pruned, 1, "只删除那一条过期的已结束任务");

    // 该删的真的没了（条目、exit 一起）。
    assert.equal(readEntry(dir, oldId), null);
    // 不该删的还在。
    assert.ok(readEntry(dir, runningId), "运行中的任务不得被 prune");
    assert.ok(readEntry(dir, freshId), "未满 24h 的任务不得被 prune");
    assert.ok(!tasksOf(result).some((row) => row.id === oldId), "被删的条目不出现在本次列表");

    // 没有 prune:true 时不得删除任何东西。
    const noPrune = await run(root, {}, KEY, clock);
    assert.equal(noPrune.details.pruned, 0);
    assert.ok(readEntry(dir, freshId));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F5 -5 spawn_error 可见，且不会被误报成 running", async () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-list-spawnerr-0010";
    // pid 故意是活的：若没有 spawn_error 守卫，resolveStatus 会按「pid 活」报 running。
    seed(
      dir,
      makeEntry(dir, id, {
        status: "running",
        pid: process.pid,
        spawn_error: "spawn EAGAIN: resource temporarily unavailable",
      }),
    );

    const result = await run(root);
    const row = byId(tasksOf(result))[id];
    assert.equal(row.status, "exited", "spawn 失败的任务不得报 running");
    assert.equal(row.spawn_error, "spawn EAGAIN: resource temporarily unavailable");
    assert.match(result.content[0].text, /EAGAIN/, "启动失败原因必须出现在人读输出里");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F5 -6 坏文件如实报告：列表仍能列出其它条目，并报出坏条目数量", async () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const goodId = "bg-list-good-0011";
    seed(dir, makeEntry(dir, goodId, { status: "running", pid: process.pid }));

    // 写一半的 JSON：listEntries 必须跳过并报告，而不是整份列表抛错。
    writeFileSync(entryPath(dir, "bg-list-broken-0012"), '{"id":"bg-list-broken-0012","command":');

    const result = await run(root);
    assert.equal(result.isError, undefined, "坏文件不得让整个 list 失败");
    assert.ok(tasksOf(result).some((row) => row.id === goodId), "好条目仍必须列出来");
    assert.equal(result.details.warnings, 1, "坏条目数量必须如实报告");
    assert.equal((result.details.warning_details as unknown[]).length, 1);
    assert.match(result.content[0].text, /could not be read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F5 -7 include_finished:false 只列仍在跑的", async () => {
  const root = makeRoot();
  let probe: { pid: number; stop: () => void } | undefined;
  try {
    const dir = backgroundDir(root);
    probe = startProbe();
    const runningId = "bg-list-inc-run-0013";
    const exitedId = "bg-list-inc-exit-0014";
    seed(dir, makeEntry(dir, runningId, { status: "running", pid: probe.pid }));
    seed(dir, makeEntry(dir, exitedId, { status: "exited", pid: 999_999_999 }), {
      exit: { exit_code: 0, signal: null, at: new Date().toISOString() },
    });

    const runningOnly = await run(root, { include_finished: false });
    const ids = tasksOf(runningOnly).map((row) => row.id);
    assert.deepEqual(ids, [runningId]);

    const all = await run(root, {});
    assert.equal(tasksOf(all).length, 2, "默认 include_finished 为 true");
  } finally {
    probe?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("F5 -8 自愈过的 exited 粘住：pid 被复用后仍报 exited，且不得把 running 写回磁盘（D1）", async () => {
  // 回退点：删掉 `resolveStatus` 的 sticky `exited` 分支 → 第二次 list 报 running,
  // 并把 running 回写磁盘，两条断言都红。
  const root = makeRoot();
  let probe: { pid: number; stop: () => void } | undefined;
  try {
    const dir = backgroundDir(root);
    const id = "bg-list-sticky-0015";

    // 第一次：pid 已死、无 `.exit` → list 把它自愈成 exited 并回写磁盘。
    seed(dir, makeEntry(dir, id, { status: "running", pid: 999_999_999 }));
    const first = byId(tasksOf(await run(root)))[id];
    assert.equal(first.status, "exited");
    assert.equal(readEntry(dir, id)?.status, "exited", "前置条件：自愈已落盘");

    // 然后那个旧 pid 被系统「重用」成一个无关的存活进程。
    probe = startProbe();
    assert.ok(probe.pid > 0, "探针进程必须真的起来");
    const healed = readEntry(dir, id)!;
    writeEntry(dir, { ...healed, pid: probe.pid });

    // 第二次：已经判过结束的条目不得因为 pid 活着而复活。
    const second = byId(tasksOf(await run(root)))[id];
    assert.equal(second.status, "exited", "已判结束的条目必须粘住");
    assert.equal(second.exit_code, null, "粘住时退出码仍是记录里的 NULL");
    assert.equal(
      readEntry(dir, id)?.status,
      "exited",
      "不得把 running 写回磁盘（否则下次 stop 会杀掉被重用的 pid）",
    );
  } finally {
    probe?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("F5 -9 回写失败不得炸掉 list：本次仍返回解析结果，但不计入 healed（D3）", async () => {
  // 回退点：`resolveAndHeal` 不包 try/catch → execute 抛 EISDIR，result 拿不到；
  // 回写失败仍返回 healed:true → healed 计数断言红。
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-list-healfail-0016";
    seed(dir, makeEntry(dir, id, { status: "running", pid: 999_999_999 }));

    // 造一个确定性的写入失败：`<id>.json.tmp` 是个目录，writeFileSync 会以
    // EISDIR 失败（不在 rename 的可重试集合里，不会白等 1s）。
    const blocker = `${entryPath(dir, id)}.tmp`;
    mkdirSync(blocker, { recursive: true });

    const result = await run(root);
    assert.equal(result.isError, undefined, "一次回写失败不得让整个 list 抛错");
    const row = byId(tasksOf(result))[id];
    assert.equal(row.status, "exited", "本次调用的结论仍必须正确");
    assert.equal(result.details.healed, 0, "没写进磁盘就不能算 healed");
    assert.equal(
      readEntry(dir, id)?.status,
      "running",
      "回写真的失败了：磁盘上的条目保持原样（没有假装写过）",
    );

    rmSync(blocker, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("H1a list 展示 .exit.error 与 .exit.signal，且与 spawn_error 能区分", async () => {
  // 回退点：resolveAndHeal/toListRow 丢开 resolved.failure/signal → 两行的
  //        failure/signal 断言变红；listHumanText 不写出来 → 文本断言变红。
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);

    // ① 运行后异常结束：.exit 里有 error（模拟 spawn 到未知错误码）。
    const errId = "bg-list-h1a-err";
    seed(dir, makeEntry(dir, errId, { status: "running", pid: 999_999_999 }), {
      exit: { exit_code: null, error: "UNKNOWN: resource temporarily unavailable (232)", at: new Date().toISOString() },
    });

    // ② 被信号杀死：exit_code 为 null，仅 signal 可用。
    const sigId = "bg-list-h1a-sig";
    seed(dir, makeEntry(dir, sigId, { status: "running", pid: 999_999_999 }), {
      exit: { exit_code: null, signal: "SIGKILL", at: new Date().toISOString() },
    });

    const result = await run(root);
    const rows = byId(tasksOf(result));
    assert.match(String(rows[errId].failure), /232/);
    assert.equal(rows[errId].spawn_error, undefined, "这条只有 .exit.error，两类原因必须能区分");
    assert.equal(rows[sigId].signal, "SIGKILL");
    assert.match(result.content[0].text, /232/, "原因必须出现在人读输出里");
    assert.match(result.content[0].text, /SIGKILL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
