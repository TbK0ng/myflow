import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ASK_USER_TOOL_NAME,
  MAX_HEADER_CHARS,
  QUESTIONS_FILE,
  createAskUserTool,
  persistVia,
} from "../.pi/extensions/myflow/ask.ts";

/**
 * A-1…A-6：`myflow_ask_user` 的语义与「不得伪造同意」不变量（B2）。
 *
 * 这些用例不跑真实 Pi：`createAskUserTool` 把工具对象导出来，测试直接调
 * `execute(id, params, signal, onUpdate, fakeCtx)`，用一个桩 `ctx.ui.select`
 * 决定「用户选了什么」。产品代码里没有、也不会有一个「假装有 UI」的开关 ——
 * 桩只活在测试进程里。
 *
 * 每个用例都对应一个「删掉即变红」的判断：
 *   - A-1：删掉真弹窗分支 → answer/via 与落盘行都变红。
 *   - A-2：把 undefined 当成答案 → cancelled / via:none 断言变红。
 *   - A-3：无 UI 时返回任何默认答案 → answer===null 与 via:none 断言变红。
 *   - A-4：删掉 2–4 选项校验 → 桩 select 调用次数不再为 0。
 *   - A-5：删掉子代理守卫 → questions.jsonl 会被创建/增长。
 *   - A-6：若实现改成「先读后写」并让坏行抛错 → 追加后文件不增长。
 */

const CONTEXT_KEY = "pi_ask";

/** 一个带活动任务与会话指针的临时工程。 */
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-ask-"));
  mkdirSync(join(root, ".myflow", ".runtime", "sessions"), { recursive: true });
  writeFileSync(
    join(root, ".myflow", "workflow.md"),
    "[workflow-state:planning]\nPlan.\n[/workflow-state:planning]\n",
  );
  const taskDir = join(root, ".myflow", "tasks", "demo");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ title: "Demo", status: "planning" }));
  writeFileSync(
    join(root, ".myflow", ".runtime", "sessions", `${CONTEXT_KEY}.json`),
    JSON.stringify({ current_task: ".myflow/tasks/demo" }),
  );
  return root;
}

function questionsPath(root: string): string {
  return join(root, ".myflow", "tasks", "demo", QUESTIONS_FILE);
}

/** 解析 questions.jsonl，坏行跳过（与 task.py 的读取容错一致）。 */
function readRows(root: string): Array<Record<string, unknown>> {
  const path = questionsPath(root);
  if (!existsSync(path)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* 坏行跳过，不抛 */
    }
  }
  return rows;
}

/** 构造工具。`deriveContextKey` 让工具解析到本测试的活动任务；
 * `isSubAgent` 是 index.ts 注入的子代理标志（不再靠环境变量探测）。 */
function makeTool(overrides: { isSubAgent?: boolean } = {}) {
  return createAskUserTool({
    deriveContextKey: () => CONTEXT_KEY,
    isSubAgent: overrides.isSubAgent ?? false,
  }) as {
    execute: (
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: ((partial: unknown) => void) | undefined,
      ctx: Record<string, unknown>,
    ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean }>;
  };
}

/** 一个默认「TUI 有 UI」的桩 ctx；各用例覆盖所需字段。 */
function fakeCtx(root: string, overrides: Record<string, unknown> = {}) {
  return {
    cwd: root,
    mode: "tui",
    hasUI: true,
    ui: { select: async () => undefined as string | undefined },
    ...overrides,
  };
}

const VALID_PARAMS = {
  header: "门的位置",
  question: "门卡在哪个转换点？",
  options: ["只卡规划→执行", "每次动手前"],
};

test("A-1 桩 UI 返回选中项 → answer/via 正确，并追加一行 via:ui-select", async () => {
  const root = makeProject();
  try {
    let calls = 0;
    const ctx = fakeCtx(root, {
      ui: {
        select: async (_title: string, options: string[]) => {
          calls += 1;
          return options[1];
        },
      },
    });

    const result = await makeTool().execute("id", VALID_PARAMS, undefined, undefined, ctx);

    assert.equal(calls, 1, "真实弹窗只应被调用一次");
    assert.equal(result.details.answer, "每次动手前");
    assert.equal(result.details.via, "ui-select");

    const rows = readRows(root);
    assert.equal(rows.length, 1, "每次提问必须追加恰好一行");
    assert.equal(rows[0].tool, ASK_USER_TOOL_NAME);
    assert.equal(rows[0].question, VALID_PARAMS.question);
    assert.deepEqual(rows[0].options, VALID_PARAMS.options);
    assert.equal(rows[0].answer, "每次动手前");
    assert.equal(rows[0].via, "ui-select");
    assert.match(String(rows[0].at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A-2 桩 UI 返回 undefined（取消）→ via:cancelled，落盘行 via:none", async () => {
  const root = makeProject();
  try {
    const ctx = fakeCtx(root, { ui: { select: async () => undefined } });
    const result = await makeTool().execute("id", VALID_PARAMS, undefined, undefined, ctx);

    assert.equal(result.details.via, "cancelled");
    assert.equal(result.details.answer, null);

    const rows = readRows(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].via, "none", "取消不是回答，落盘必须是 none");
    assert.equal(rows[0].answer, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A-3 无 UI → via:no-ui + 指令，绝不伪造答案", async () => {
  const root = makeProject();
  try {
    // hasUI=false 且没有 select：非 TUI（print/json/rpc）的形态。
    const ctx = fakeCtx(root, { hasUI: false, mode: "print", ui: undefined });
    const result = await makeTool().execute("id", VALID_PARAMS, undefined, undefined, ctx);

    // 回退点：无 UI 时返回任何非 null answer → 下面变红。
    assert.equal(result.details.answer, null, "没有真实用户输入就绝不能有答案");
    assert.equal(result.details.via, "no-ui");
    assert.equal(typeof result.details.instruction, "string");
    assert.match(String(result.details.instruction), /END YOUR TURN/);
    assert.match(String(result.details.instruction), /mode=print/);

    const rows = readRows(root);
    assert.equal(rows.length, 1, "无 UI 也要留审计行（问过但问不出来）");
    assert.equal(rows[0].via, "none");
    assert.equal(rows[0].answer, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A-4 options 越界（1 或 5）→ 拒绝且不调用 UI、不落盘", async () => {
  const root = makeProject();
  try {
    let calls = 0;
    const ctx = fakeCtx(root, {
      ui: {
        select: async () => {
          calls += 1;
          return "x";
        },
      },
    });
    const tool = makeTool();

    const tooFew = await tool.execute(
      "id",
      { ...VALID_PARAMS, options: ["only"] },
      undefined,
      undefined,
      ctx,
    );
    const tooMany = await tool.execute(
      "id",
      { ...VALID_PARAMS, options: ["a", "b", "c", "d", "e"] },
      undefined,
      undefined,
      ctx,
    );

    // 回退点：删掉 2–4 校验 → calls 变成 2。
    assert.equal(calls, 0, "参数不合法时不得弹窗");
    assert.equal(tooFew.isError, true);
    assert.equal(tooMany.isError, true);
    assert.ok(!existsSync(questionsPath(root)), "参数不合法不得落盘");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A-4b header 超长被截断而非报错", async () => {
  const root = makeProject();
  try {
    const ctx = fakeCtx(root, { ui: { select: async (_t: string, options: string[]) => options[0] } });
    const longHeader = "x".repeat(MAX_HEADER_CHARS + 10);
    const result = await makeTool().execute(
      "id",
      { ...VALID_PARAMS, header: longHeader },
      undefined,
      undefined,
      ctx,
    );

    // 回退点：把截断改成报错 → isError 变红；不截断 → 行内长度断言变红。
    assert.ok(!result.isError);
    const rows = readRows(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].header, longHeader.slice(0, MAX_HEADER_CHARS));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A-5 子代理调用被拒，且不写 questions.jsonl", async () => {
  const root = makeProject();
  try {
    const ctx = fakeCtx(root, {
      ui: {
        select: async () => {
          throw new Error("a sub-agent must never reach the UI");
        },
      },
    });
    const result = await makeTool({ isSubAgent: true }).execute(
      "id",
      VALID_PARAMS,
      undefined,
      undefined,
      ctx,
    );

    // 回退点：删掉 isSubAgent 守卫 → 文件被创建、isError 变假。
    assert.equal(result.isError, true);
    assert.equal(result.details.answer, null);
    assert.ok(!existsSync(questionsPath(root)), "子代理不得产生审计行");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A-6 questions.jsonl 里的坏行不影响追加（只追加、不读、不抛）", async () => {
  const root = makeProject();
  try {
    writeFileSync(questionsPath(root), "{ this is not json\n");

    const ctx = fakeCtx(root, { ui: { select: async (_t: string, options: string[]) => options[0] } });
    const result = await makeTool().execute("id", VALID_PARAMS, undefined, undefined, ctx);

    // 回退点：若实现先解析再追加并让坏行抛错 → 这里会 reject，下面的行数断言也变红。
    assert.equal(result.details.via, "ui-select");
    const lines = readFileSync(questionsPath(root), "utf-8").trim().split(/\r?\n/);
    assert.equal(lines.length, 2, "坏行保留，正常行追加");
    const appended = JSON.parse(lines[1]);
    assert.equal(appended.via, "ui-select");
    assert.equal(appended.answer, VALID_PARAMS.options[0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A-7 没有活动任务时拒绝且不写任何文件", async () => {
  const root = makeProject();
  try {
    // 清掉会话指针：没有活动任务可归属。
    writeFileSync(
      join(root, ".myflow", ".runtime", "sessions", `${CONTEXT_KEY}.json`),
      JSON.stringify({ current_task: null }),
    );
    const result = await makeTool().execute("id", VALID_PARAMS, undefined, undefined, fakeCtx(root));

    assert.equal(result.isError, true);
    assert.ok(!existsSync(questionsPath(root)), "没有活动任务不得落盘");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistVia 把返回值 via 映射为落盘的两个合法值", () => {
  // 这是 TS 侧与 task.py `_answered_question_count`（只认 "ui-select"）的契约点。
  assert.equal(persistVia("ui-select"), "ui-select");
  assert.equal(persistVia("cancelled"), "none");
  assert.equal(persistVia("no-ui"), "none");
  assert.equal(persistVia("error"), "none");
});
