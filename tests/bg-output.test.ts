import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BACKGROUND_DIR,
  backgroundDir,
  createBgOutputTool,
  cursorPath,
  exitPath,
  logPath,
  readCursor,
  writeCursor,
  writeEntry,
  type BackgroundEntry,
} from "../.pi/extensions/myflow/background.ts";

// F4 — `myflow_bg_output`（`.pi/extensions/myflow/background.ts`）。
//
// 这些用例不跑真实 Pi：`createBgOutputTool` 把工具对象导出来，测试直接调
// `execute(id, params, signal, onUpdate, fakeCtx)`。注册表条目与日志文件都是
// 手工造出来的，所以用例完全确定，不依赖真的起进程（那是 F3 的事）。
//
// 每个用例用独立的临时工程目录，并在 finally 里删掉，绝不读写仓库真实的
// `.myflow/.runtime/`。
//
// 回退点（删掉即变红）：
//   -1：delta 不推进游标（或推进到文件末尾而不是已读末尾）→ 第二次读非空。
//   -2：peek 也写游标 → 之后那次真 delta 读到空。
//   -3：tail 写游标 → 前后 offset 断言变红；或 tail 取前 N 行 → 文本断言变红。
//   -4：截断时把 next_offset 设成文件末尾（或丢弃多余字节）→ 拼接断言/next_offset 变红。
//   -5：状态不从 `.exit` 取 → status/exit_code 断言变红。
//   -6：wait 不检查「有新字节」→ ① 超时；不检查「任务已结束」→ ② 超时；无界 → ③ 上界变红。
//   -7：游标全局单份而不是按会话 → 第二个会话读到空。
//   -8：offset>size 时静默返回空 → text/reset 断言变红。
//   -10：把 max_bytes 直接当字节偏移切（不回退到字符边界）→ 文本出现 U+FFFD / 拼接不等。
//   -11：退化时返回空原地不动 → 循环卡死、拼不回全文；把 end 回退成空也会变红。
//   -13：tail 不丢弃被 max_bytes 切开的半行（completeLines 改回 split）→ 首行是半行，断言变红；
//         反过来「总是丢弃首行」→ 窗口正好落在行首时会多丢一整行，断言变红。
//   -14：tail 的退化例外被去掉（partialFirstLine 时无条件丢弃首行）→ 单行超限返回空，断言变红。
//   H3 -1：output 不再带出 `.exit.shell` / `.exit.retries` → 两条断言变红。
//   H3 -2：把缺失的 retries 写成 `undefined`/`0` 占位 → `"retries" in details` 变红。
//   H3 -3：把拒绝记录的 `shell: null` 省略（`?? ""` 兜底）→ shell/`in` 断言变红。
//   H3 -4：无条件加 shell/retries（不看 .exit 是否存在）→ 运行中任务多出字段，断言变红。

const KEY = "pi_bgoutput";

/** 一个能通过 findProjectRoot 的临时工程根，注册表目录已建好。 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-bg-output-"));
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

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

/** 一个不依赖真实会话的工具实例；contextKey 用来模拟不同会话。 */
function makeTool(contextKey: string = KEY) {
  return createBgOutputTool({
    deriveContextKey: () => contextKey,
    isSubAgent: false,
  }) as unknown as { execute: (...args: unknown[]) => Promise<ToolResult> };
}

function fakeCtx(root: string) {
  return { cwd: root, mode: "tui", hasUI: true };
}

function run(root: string, params: Record<string, unknown>, contextKey: string = KEY): Promise<ToolResult> {
  return makeTool(contextKey).execute("call", params, undefined, undefined, fakeCtx(root));
}

test("F4 -1 delta：首次读全部、再次为空、追加后只读新增", async () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-test-0001";
    writeEntry(dir, makeEntry(dir, id));
    writeFileSync(logPath(dir, id), "hello\n");

    const first = await run(root, { task_id: id });
    assert.equal(first.isError, undefined);
    assert.equal(first.details.text, "hello\n");
    assert.equal(first.details.bytes, 6);
    assert.equal(first.details.next_offset, 6);
    assert.equal(first.details.truncated, false);
    assert.equal(readCursor(cursorPath(root, KEY, id)), 6, "delta 必须推进游标");

    const second = await run(root, { task_id: id });
    assert.equal(second.details.text, "");
    assert.equal(second.details.bytes, 0);
    assert.equal(second.details.next_offset, 6);

    appendFileSync(logPath(dir, id), "world\n");
    const third = await run(root, { task_id: id });
    assert.equal(third.details.text, "world\n", "只有新增部分");
    assert.equal(third.details.next_offset, 12);
    assert.equal(readCursor(cursorPath(root, KEY, id)), 12);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F4 -2 peek：读得到内容，但游标前后完全不变", async () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-test-0002";
    writeEntry(dir, makeEntry(dir, id));
    writeFileSync(logPath(dir, id), "abcdef");

    const cursor = cursorPath(root, KEY, id);
    assert.equal(readCursor(cursor), 0);
    assert.equal(existsSync(cursor), false, "前置条件：游标文件尚不存在");
    const result = await run(root, { task_id: id, peek: true });
    assert.equal(result.details.text, "abcdef");
    assert.equal(readCursor(cursor), 0, "peek 绝不动游标");
    assert.equal(existsSync(cursor), false, "peek 不得创建游标文件（否则就不是\"绝不动游标\"）");
    assert.equal(result.details.next_offset, 0);

    // peek 没有消费，随后一次真正的 delta 仍能拿到全部内容。
    const consumed = await run(root, { task_id: id });
    assert.equal(consumed.details.text, "abcdef");
    assert.equal(readCursor(cursor), 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F4 -3 tail：返回最后 N 行且不动游标", async () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-test-0003";
    writeEntry(dir, makeEntry(dir, id));
    writeFileSync(logPath(dir, id), "l1\nl2\nl3\nl4\n");

    const cursor = cursorPath(root, KEY, id);
    writeCursor(cursor, 5);
    const result = await run(root, { task_id: id, mode: "tail", lines: 2 });
    assert.equal(result.details.text, "l3\nl4\n");
    assert.ok(!String(result.details.text).includes("l1"));
    assert.equal(result.details.truncated, false);
    assert.equal(readCursor(cursor), 5, "tail 绝不动游标");
    assert.equal(result.details.next_offset, 5, "tail 的 next_offset 就是未变的游标");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F4 -4 截断：next_offset 指向已返回部分的末尾，剩余字节不丢", async () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-test-0004";
    writeEntry(dir, makeEntry(dir, id));
    const content = "0123456789".repeat(10); // 100 字节
    writeFileSync(logPath(dir, id), content);

    const first = await run(root, { task_id: id, max_bytes: 7 });
    assert.equal(first.details.truncated, true);
    assert.equal(first.details.bytes, 7);
    assert.equal(first.details.next_offset, 7, "截断时 next_offset 必须是已返回部分的末尾，不是文件末尾");

    // 连续小步读，把结果拼起来必须等于完整内容：证明没有静默丢字节。
    let collected = String(first.details.text);
    let sawTruncated = true;
    for (let i = 0; i < 100 && sawTruncated; i += 1) {
      const next = await run(root, { task_id: id, max_bytes: 7 });
      collected += String(next.details.text);
      sawTruncated = next.details.truncated === true;
      assert.ok(Number(next.details.next_offset) <= 100);
    }
    assert.equal(collected, content, "逐段读必须拼回完整内容");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F4 -5 已退出：status 与 exit_code 来自 .exit", async () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-test-0005";
    writeEntry(dir, makeEntry(dir, id));
    writeFileSync(logPath(dir, id), "done\n");
    writeFileSync(
      exitPath(dir, id),
      JSON.stringify({ exit_code: 7, signal: null, at: new Date().toISOString() }),
    );

    const result = await run(root, { task_id: id });
    assert.equal(result.details.status, "exited");
    assert.equal(result.details.exit_code, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F4 -6 wait_ms：有新输出提前返回、任务结束提前返回、否则有界超时", async () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);

    // ① 等待期间有新输出 → 提前返回。
    const idA = "bg-test-0006a";
    writeEntry(dir, makeEntry(dir, idA, { pid: process.pid }));
    writeFileSync(logPath(dir, idA), "start\n");
    writeCursor(cursorPath(root, KEY, idA), 6);
    const tA = Date.now();
    const pending = run(root, { task_id: idA, wait_ms: 5000 });
    setTimeout(() => {
      try {
        appendFileSync(logPath(dir, idA), "late\n");
      } catch {
        // The temp root is removed in `finally`; a prior failed assertion could
        // race this callback, and an unhandled timer error would be noise.
      }
    }, 250);
    const a = await pending;
    const elapsedA = Date.now() - tA;
    assert.ok(elapsedA < 3000, `有新输出时必须提前返回，实际 ${elapsedA}ms`);
    assert.equal(a.details.text, "late\n");

    // ② 无输出但任务已结束 → 提前返回。
    const idB = "bg-test-0006b";
    writeEntry(dir, makeEntry(dir, idB));
    writeFileSync(logPath(dir, idB), "ended\n");
    writeFileSync(exitPath(dir, idB), JSON.stringify({ exit_code: 0, signal: null, at: new Date().toISOString() }));
    writeCursor(cursorPath(root, KEY, idB), 6);
    const tB = Date.now();
    const b = await run(root, { task_id: idB, wait_ms: 5000 });
    const elapsedB = Date.now() - tB;
    assert.ok(elapsedB < 1500, `任务已结束时必须提前返回，实际 ${elapsedB}ms`);
    assert.equal(b.details.status, "exited");
    assert.equal(b.details.text, "");

    // ③ 无新输出且仍在跑 → 等到超时，且有上界。
    const idC = "bg-test-0006c";
    writeEntry(dir, makeEntry(dir, idC, { pid: process.pid }));
    writeFileSync(logPath(dir, idC), "quiet\n");
    writeCursor(cursorPath(root, KEY, idC), 6);
    const tC = Date.now();
    const c = await run(root, { task_id: idC, wait_ms: 400 });
    const elapsedC = Date.now() - tC;
    assert.ok(elapsedC >= 300, `必须真的等到超时，实际 ${elapsedC}ms`);
    assert.ok(elapsedC < 2000, `等待必须有界，实际 ${elapsedC}ms`);
    assert.equal(c.details.status, "running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F4 -7 游标按会话分开：两个会话都能读到，互不消费", async () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-test-0007";
    writeEntry(dir, makeEntry(dir, id));
    writeFileSync(logPath(dir, id), "shared\n");

    const a = await run(root, { task_id: id }, "pi_session_a");
    assert.equal(a.details.text, "shared\n");
    const b = await run(root, { task_id: id }, "pi_session_b");
    assert.equal(b.details.text, "shared\n", "第二个会话不得被第一个会话的游标吞掉");

    const aAgain = await run(root, { task_id: id }, "pi_session_a");
    assert.equal(aAgain.details.text, "", "A 自己的游标已被推进");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F4 -8 游标比文件长（日志被轮转/重建）：从 0 重读并带 reset", async () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-test-0008";
    writeEntry(dir, makeEntry(dir, id));
    writeFileSync(logPath(dir, id), "abc\n");

    const cursor = cursorPath(root, KEY, id);
    writeCursor(cursor, 9999);
    const result = await run(root, { task_id: id });
    assert.equal(result.details.reset, true, "必须显式报告重新读了");
    assert.equal(result.details.text, "abc\n", "不得静默返回空");
    assert.equal(result.details.bytes, 4);
    assert.equal(result.details.next_offset, 4);
    assert.equal(readCursor(cursor), 4, "重置后的游标必须落盘");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F4 -9 校验：task_id 缺失或不存在 → 明确错误", async () => {
  const root = makeRoot();
  try {
    const missingId = await run(root, {});
    assert.equal(missingId.isError, true);
    assert.match(String(missingId.details.error), /task_id/);

    const unknownId = await run(root, { task_id: "bg-nope-0000" });
    assert.equal(unknownId.isError, true);
    assert.match(String(unknownId.details.error), /No background task/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F4 -10 多字节字符不被切坏：小 max_bytes 分批 delta 逐步拼回原文", async () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-test-0010";
    writeEntry(dir, makeEntry(dir, id));
    const content = "中文输出行\n".repeat(8);
    const logFile = logPath(dir, id);
    writeFileSync(logFile, content);
    const raw = readFileSync(logFile);

    // 独立判定（不复用实现里的函数）：位置 p 是 UTF-8 字符边界 ⟺ p 等于文件
    // 长度，或该处字节不是续接字节（0b10xxxxxx）。
    const isBoundary = (p: number) => p === raw.length || (raw[p] & 0xc0) !== 0x80;

    let collected = "";
    let cursor = 0;
    let truncated = true;
    for (let i = 0; i < 200 && truncated; i += 1) {
      const step = await run(root, { task_id: id, max_bytes: 7 });
      const text = String(step.details.text);
      assert.ok(!text.includes("\uFFFD"), `第 ${i} 步不得出现替换字符 U+FFFD`);
      const next = Number(step.details.next_offset);
      assert.ok(next > cursor, `第 ${i} 步必须前进（${cursor} → ${next}）`);
      assert.ok(isBoundary(next), `第 ${i} 步 next_offset=${next} 必须落在字符边界上`);
      collected += text;
      cursor = next;
      truncated = step.details.truncated === true;
    }
    assert.equal(collected, content, "逐步拼接必须与原文逐字符相等，一个字都不能丢");
    assert.equal(cursor, raw.length, "最终必须读到文件末尾");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F4 -11 退化：max_bytes 小于单字符字节数时仍取一个完整字符并最终读完", async () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-test-0011";
    writeEntry(dir, makeEntry(dir, id));
    const content = "中文字";
    const logFile = logPath(dir, id);
    writeFileSync(logFile, content);
    const raw = readFileSync(logFile);

    const isBoundary = (p: number) => p === raw.length || (raw[p] & 0xc0) !== 0x80;

    // 预算 1 字节装不下一个 3 字节汉字：必须破例返回整个字符，且不得空转。
    const first = await run(root, { task_id: id, max_bytes: 1 });
    assert.ok(!String(first.details.text).includes("\uFFFD"));
    assert.equal(first.details.text, "中", "预算装不下一个字符时必须破例取整个字符");
    assert.ok(Number(first.details.bytes) > 1, "破例时必须真的超过 max_bytes");

    let collected = String(first.details.text);
    let cursor = Number(first.details.next_offset);
    let truncated = first.details.truncated === true;
    for (let i = 0; i < 50 && truncated; i += 1) {
      const step = await run(root, { task_id: id, max_bytes: 1 });
      const text = String(step.details.text);
      assert.ok(!text.includes("\uFFFD"), "不得出现替换字符 U+FFFD");
      assert.ok(text.length >= 1, "每一步至少一个完整字符，不得空转卡死");
      const next = Number(step.details.next_offset);
      assert.ok(next > cursor, `必须前进（${cursor} → ${next}）`);
      assert.ok(isBoundary(next), `next_offset=${next} 必须落在字符边界上`);
      collected += text;
      cursor = next;
      truncated = step.details.truncated === true;
    }
    assert.equal(collected, content, "循环读必须最终拼回全文");
    assert.equal(cursor, raw.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F4 -12 tail 起点对齐：max_bytes 落在字符中间时首字符不被损坏", async () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-test-0012";
    writeEntry(dir, makeEntry(dir, id));
    const content = "第一行输出\n第二行输出\n第三行输出\n第四行输出\n第五行输出\n";
    const logFile = logPath(dir, id);
    writeFileSync(logFile, content);
    const raw = readFileSync(logFile);

    // 独立判定（不复用实现里的函数）：位置 p 处是续接字节（0b10xxxxxx）⟺ 它落在
    // 一个多字节字符内部。取第一个这样的位置 p，再令 max_bytes = size - p，
    // tail 的窗口就会正好从字符中间开始。
    const isContinuation = (p: number) => (raw[p] & 0xc0) === 0x80;
    let p = 0;
    while (p < raw.length && !isContinuation(p)) p += 1;
    assert.ok(p > 0 && p < raw.length, "前置条件：必须存在一个非零的字符内位置");
    assert.ok(isContinuation(p), "前置条件：该位置必须是续接字节");

    const maxBytes = raw.length - p;
    assert.equal(raw.length - maxBytes, p, "窗口起点必须正好落在字符内位置 p");

    // 前置条件：tail 不得创建游标文件。
    const cursor = cursorPath(root, KEY, id);
    assert.equal(existsSync(cursor), false, "前置条件：游标文件尚不存在");

    const result = await run(root, { task_id: id, mode: "tail", max_bytes: maxBytes });
    const text = String(result.details.text);

    // ① 起点不得被切坏 → 不得出现替换字符。
    assert.ok(!text.includes("\uFFFD"), "tail 首字符不得因起点落在字符中间而损坏");
    // ② 返回的必须是原文尾部的一段（后缀），且非空。
    assert.ok(text.length > 0, "tail 不得返回空");
    assert.ok(content.endsWith(text), "tail 必须返回文件尾部的一段（原文的后缀）");
    const suffixStart = raw.length - Buffer.byteLength(text, "utf-8");
    assert.ok(
      suffixStart === raw.length || (raw[suffixStart] & 0xc0) !== 0x80,
      `tail 起点 ${suffixStart} 必须落在字符边界上`,
    );
    assert.ok(suffixStart >= p, `tail 起点应向后对齐，不早于字符内位置 ${p}（实际 ${suffixStart}）`);
    // ③ tail 绝不动游标。
    assert.equal(existsSync(cursor), false, "tail 不得创建游标文件");
    assert.equal(readCursor(cursor), 0, "tail 的游标读出来仍是 0");
    assert.equal(result.details.next_offset, 0, "tail 的 next_offset 就是未变的游标");

    // 退化：max_bytes 小于尾部单个多字节字符时，向前对齐会把起点推到 EOF；此时
    // 必须回退到最后一个完整字符的起点，而不是返回空。
    const idD = "bg-test-0012d";
    writeEntry(dir, makeEntry(dir, idD));
    const tailOnly = "中文字"; // 9 字节，无换行，末字符为 3 字节汉字。
    const logD = logPath(dir, idD);
    writeFileSync(logD, tailOnly);
    const rawD = readFileSync(logD);
    assert.equal(rawD[rawD.length - 1] & 0xc0, 0x80, "前置条件：末字节是续接字节");
    const degenerate = await run(root, { task_id: idD, mode: "tail", max_bytes: 1 });
    assert.equal(degenerate.details.text, "字", "退化时必须返回尾部一个完整字符，不得为空");
    assert.ok(!String(degenerate.details.text).includes("\uFFFD"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F4 -13 tail 按行边界截断：max_bytes 切在行中间时不返回半行", async () => {
  // 回退点：把 completeLines 改回 split（即不丢不完整首行）→ 返回文本以半行开头，
  //         断言变红；把行首判定改成「总是丢弃首行」→ 窗口正好落在行首时断言变红。
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-test-0013";
    writeEntry(dir, makeEntry(dir, id));
    const content = "AAAA\nBBBB\nCCCC\nDDDD\n"; // 20 字节
    const logFile = logPath(dir, id);
    writeFileSync(logFile, content);

    // max_bytes=12 → 窗口起点 = 20-12 = 8，正好落在第二行 "BBBB" 的中间。
    const cursor = cursorPath(root, KEY, id);
    const result = await run(root, { task_id: id, mode: "tail", lines: 3, max_bytes: 12 });
    const text = String(result.details.text);
    assert.equal(result.details.truncated, true, "被 max_bytes 截断必须标 truncated");
    assert.equal(text, "CCCC\nDDDD\n", "必须从下一个完整行开始，不得返回半行");
    assert.ok(!text.includes("BBB"), "不得包含被切开的半行片段");
    assert.ok(content.includes(`\n${text}`), "返回的必须是完整行组成的后缀");
    assert.equal(existsSync(cursor), false, "tail 不得创建游标文件");
    assert.equal(readCursor(cursor), 0);
    assert.equal(result.details.next_offset, 0, "tail 不动游标");

    // 窗口正好落在行首（起点前一个字节是换行）时不得多丢首行。
    const idBoundary = "bg-test-0013b";
    writeEntry(dir, makeEntry(dir, idBoundary));
    writeFileSync(logPath(dir, idBoundary), content);
    const atBoundary = await run(root, {
      task_id: idBoundary,
      mode: "tail",
      lines: 3,
      max_bytes: 16,
    });
    // 20-16 = 4 → 起点是 index 4 的 '\n'，其后 "BBBB\nCCCC\nDDDD\n" 三行完整。
    assert.equal(String(atBoundary.details.text), "BBBB\nCCCC\nDDDD\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F4 -14 tail 单行超限：唯一例外是返回对齐片段并标 truncated", async () => {
  // 回退点：把退化例外也丢掉（partialFirstLine 时无条件丢弃首行）→ 返回空，断言变红。
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-test-0014";
    writeEntry(dir, makeEntry(dir, id));
    const content = "0123456789"; // 单行、10 字节、无换行
    const logFile = logPath(dir, id);
    writeFileSync(logFile, content);

    const cursor = cursorPath(root, KEY, id);
    const result = await run(root, { task_id: id, mode: "tail", lines: 3, max_bytes: 4 });
    const text = String(result.details.text);
    assert.equal(result.details.truncated, true, "被 max_bytes 截断必须标 truncated");
    assert.equal(text, "6789", "唯一例外：单行本身超限时返回其（字符边界对齐的）片段");
    assert.ok(!text.includes("\uFFFD"));
    assert.ok(content.endsWith(text), "片段必须是该行的尾部");
    assert.equal(existsSync(cursor), false, "tail 不得创建游标文件");
    assert.equal(readCursor(cursor), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("H1a output 展示启动失败/异常退出原因：.exit.error 与 .exit.signal", async () => {
  // 回退点：resolveStatus 只带出 exit_code（丢掉 error/signal）→ ①failure 为 undefined、
  //        ②signal 为 undefined，断言变红；或 outputHumanText 不写出来 → 文本断言变红。
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);

    // ① 预置一个「创建失败」的 .exit：exit_code 为 null，但 error 说明原因。
    //    没有 H1a 时它和「正常退出但退出码未知」长得一模一样。
    const errId = "bg-test-h1a-err";
    writeEntry(dir, makeEntry(dir, errId, { status: "running", pid: process.pid }));
    writeFileSync(logPath(dir, errId), "");
    writeFileSync(
      exitPath(dir, errId),
      JSON.stringify({
        exit_code: null,
        error: "EAGAIN: resource temporarily unavailable",
        at: new Date().toISOString(),
      }),
    );
    const errResult = await run(root, { task_id: errId });
    assert.equal(errResult.details.status, "exited");
    assert.equal(errResult.details.exit_code, null);
    assert.match(String(errResult.details.failure), /EAGAIN/);
    assert.match(errResult.content[0].text, /EAGAIN/, "原因必须出现在人读文本里");

    // ② 被信号杀死：exit_code 为 null，仅 signal 可用（不得只认 exit_code）。
    const sigId = "bg-test-h1a-sig";
    writeEntry(dir, makeEntry(dir, sigId, { status: "running", pid: process.pid }));
    writeFileSync(logPath(dir, sigId), "");
    writeFileSync(
      exitPath(dir, sigId),
      JSON.stringify({ exit_code: null, signal: "SIGKILL", at: new Date().toISOString() }),
    );
    const sigResult = await run(root, { task_id: sigId });
    assert.equal(sigResult.details.status, "exited");
    assert.equal(sigResult.details.exit_code, null);
    assert.equal(sigResult.details.signal, "SIGKILL");
    assert.match(sigResult.content[0].text, /SIGKILL/);

    // ③ 扩展侧记录的原因（entry.spawn_error，无 .exit）也要通过 failure 看到。
    const spawnErrId = "bg-test-h1a-spawn";
    writeEntry(
      dir,
      makeEntry(dir, spawnErrId, {
        status: "running",
        pid: 999_999_999,
        spawn_error: "spawn UNKNOWN (232)",
      }),
    );
    writeFileSync(logPath(dir, spawnErrId), "");
    const spawnErrResult = await run(root, { task_id: spawnErrId });
    assert.match(String(spawnErrResult.details.failure), /232/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// H3 — `myflow_bg_output` 让 `.exit` 说真话：`shell` 与实际重试次数
//
// `.exit` 一直写着这两个字段，只是 `ExitRecord` 类型没承认它们、也没有读者。
// 现在 output 在任务**已结束**时把它们带出来。回退点见文件头 H3 行。
// ---------------------------------------------------------------------------

test("H3 -1 已结束：shell 与 retries 取自 .exit", async () => {
  // 回退点：output 不再带出 .exit.shell / .exit.retries → 两条断言变红
  //        （无论是因为字段没加、还是因为读的是 entry 的缓存值）。
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-test-h3-shell";
    // 条目里故意留一个不同的 cwd/pid 缓存：shell 必须来自 .exit，不是猜的。
    writeEntry(dir, makeEntry(dir, id));
    writeFileSync(logPath(dir, id), "built ok\n");
    const shell = "C:/Program Files/Git/bin/bash.exe";
    writeFileSync(
      exitPath(dir, id),
      JSON.stringify({ exit_code: 0, signal: null, at: new Date().toISOString(), shell, retries: 2 }),
    );

    const result = await run(root, { task_id: id, mode: "tail" });
    assert.equal(result.details.status, "exited");
    assert.equal(result.details.shell, shell, "shell 必须与 .exit 一致");
    assert.equal(result.details.retries, 2, "retries 必须与 .exit 一致");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("H3 -2 .exit 没有 retries：返回体里不出现该字段", async () => {
  // 回退点：把 retries 写成 `retries: undefined` 或 `retries: 0` 占位 →
  //        `"retries" in details` 变 true，断言变红（这是「不出现」而不是「等于 undefined」）。
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-test-h3-noretry";
    writeEntry(dir, makeEntry(dir, id));
    writeFileSync(logPath(dir, id), "done\n");
    writeFileSync(
      exitPath(dir, id),
      JSON.stringify({
        exit_code: 0,
        signal: null,
        at: new Date().toISOString(),
        shell: "/usr/bin/bash",
      }),
    );

    const result = await run(root, { task_id: id, mode: "tail" });
    assert.equal(result.details.status, "exited");
    assert.equal(result.details.shell, "/usr/bin/bash");
    assert.equal("retries" in result.details, false, "没有重试就没有 retries 字段");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("H3 -3 拒绝记录：shell 为 null 且 retries 不出现", async () => {
  // 回退点：把 shell 的 null 当成「没有值」而省略（或用 `?? ""` 兜底）→
  //        `details.shell === null` 与 `"shell" in details` 变红。
  //        拒绝是**记录下来的事实**（解析不到 POSIX 外壳，什么都没执行），
  //        必须能与「记录里根本没有这个字段」区分开。
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-test-h3-refused";
    writeEntry(dir, makeEntry(dir, id));
    writeFileSync(logPath(dir, id), "");
    writeFileSync(
      exitPath(dir, id),
      JSON.stringify({
        exit_code: null,
        error: "no POSIX shell resolved (tried MYFLOW_BG_SHELL, shellPath, Git Bash, PATH)",
        at: new Date().toISOString(),
        shell: null,
      }),
    );

    const result = await run(root, { task_id: id, mode: "tail" });
    assert.equal(result.details.status, "exited");
    assert.equal(result.details.exit_code, null);
    assert.equal("shell" in result.details, true, "拒绝记录也要带 shell 字段");
    assert.equal(result.details.shell, null, "拒绝路径的 shell 是 null，不是缺失");
    assert.equal("retries" in result.details, false);
    assert.match(String(result.details.failure), /no POSIX shell resolved/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("H3 -4 未结束任务：不带 shell / retries", async () => {
  // 回退点（本批最关键的一条）：把 runnerFacts 改成无条件加入（例如
  //        `shell: normalizeExitShell(exitRecord?.shell)`）→ 运行的条目没有 .exit，
  //        却会返回 `shell: null`，这里的 `"shell" in details === false` 变红。
  //        没有 .exit 就没有权威值，凭空给一个 null 等于谎称「被拒绝」。
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const runningId = "bg-test-h3-running";
    // pid = 本进程，保证 isAlive 为真 → resolveStatus 报 running 且没有 .exit。
    writeEntry(dir, makeEntry(dir, runningId, { status: "running", pid: process.pid }));
    writeFileSync(logPath(dir, runningId), "still going\n");

    const running = await run(root, { task_id: runningId, mode: "tail" });
    assert.equal(running.details.status, "running");
    assert.equal("shell" in running.details, false, "运行中的任务没有权威 shell");
    assert.equal("retries" in running.details, false, "运行中的任务没有权威 retries");

    // 同一个判定对 delta 与 stopping 后的自愈条目同样成立：条目标成 exited 但
    // 从未留下 .exit（自愈路径）时，也没有人可以声称用过哪个外壳。
    const healedId = "bg-test-h3-healed";
    writeEntry(dir, makeEntry(dir, healedId, { status: "exited", exit_code: null, pid: 999_999_999 }));
    writeFileSync(logPath(dir, healedId), "");
    const healed = await run(root, { task_id: healedId, mode: "delta" });
    assert.equal(healed.details.status, "exited");
    assert.equal("shell" in healed.details, false, "自愈的 exited 没有 .exit 就没有 shell");
    assert.equal("retries" in healed.details, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("H6 -5 starting 任务：正常返回 status=starting，不报错也不带 .exit 字段", async () => {
  // 回退点：把 `starting` 当错误（或当成已结束）→ `isError` / status 断言变红；
  //        把 `starting` 加进 `isFinishedStatus` → wait 会立刻返回、状态变成 exited。
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const id = "bg-test-h6-starting";
    writeEntry(
      dir,
      makeEntry(dir, id, { status: "starting", pid: 0, started_at: new Date().toISOString() }),
    );
    // 日志可能还不存在（毫秒级窗口里外壳还没创建它）：读空是正常结果。
    const result = await run(root, { task_id: id });
    assert.equal(result.isError, undefined, "starting 不是错误");
    assert.equal(result.details.status, "starting");
    assert.equal(result.details.exit_code, null);
    assert.equal(result.details.text, "");
    assert.equal("shell" in result.details, false, "还没有 .exit 就没有权威 shell");
    assert.equal("failure" in result.details, false, "starting 不是失败");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
