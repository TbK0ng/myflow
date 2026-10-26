import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { createAskUserTool, QUESTIONS_FILE } from "../.pi/extensions/myflow/ask.ts";
import { createApprovalTool, APPROVAL_FILE } from "../.pi/extensions/myflow/approval.ts";
import { resolveActiveTaskStatus } from "../.pi/extensions/myflow/turn-cache.ts";

/**
 * B6：plan 提问与批准门的**端到端**。
 *
 * 与 `ask-user.test.ts` / `plan-approval-tool.test.ts` / `plan-approval-gate.test.ts`
 * 的单点用例不同，这里把整条真实链路串起来跑：真实的 `myflow_ask_user` 与
 * `myflow_request_approval` 处理器 + 真实的 `.myflow/scripts/task.py` 子进程。
 * 唯一被替换的是两个交互面 —— `ctx.ui.select` 与 `ctx.ui.confirm` —— 因为一个
 * 测试进程无法真的弹 TUI 窗口。除此之外没有任何 mock：`task.py` 不桩、工具逻辑
 * 不桩、`questions.jsonl` / `approval.json` 都由真实代码写出。
 *
 * 正向路径证明「ask → 写 plan → request_approval → start」一路走得通；
 * 四条反向路径各自证明一个门真的会拦：
 *   a. 批准后改 plan → `start` 以 stale 拒绝，并显示新旧哈希前 12 位；
 *   b. 没有 questions.jsonl → 批准工具拒绝且**一次都不弹窗**；
 *   c. questions_answered==0 + 合法 approval.json → `start` 的 R2 兜底仍拒绝；
 *   d. 无 UI → 两个工具都返回 instruction，且**绝不伪造同意**（不写 approval.json）。
 *
 * 会话对齐：`task.py` 用 `PI_SESSION_ID=e2e` 派生出会话键 `pi_e2e`；工具的
 * `deriveContextKey` 被注入为同一个 `pi_e2e`，因此两侧解析到**同一个活动任务**，
 * 这正是生产接线（index.ts 注入 `deriveContextKey`）所做的事。
 */

const REPO_ROOT = join(import.meta.dirname, "..");
const REPO_TASK_PY = join(REPO_ROOT, ".myflow", "scripts", "task.py");

/** `pi_` + sanitize("e2e")，与 task.py 的 `_context_key()` 逐字一致。 */
const CONTEXT_KEY = "pi_e2e";
const SESSION_ID = "e2e";

type ExecResult = {
  content: Array<{ text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

type ToolExec = { execute: (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: unknown) => void) | undefined,
  ctx: Record<string, unknown>,
) => Promise<ExecResult> };

/**
 * 一个最小但真实的工程：`.myflow/workflow.md`（`findProjectRoot` 的锚点）、
 * 一份真实的 `task.py` 副本（工具会 `spawnSync` 它）、以及一个可被两个
 * manifest curate 的真实文件。每个用例独立一个临时工程，避免会话指针串台。
 */
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-e2e-"));
  mkdirSync(join(root, ".myflow", "scripts"), { recursive: true });
  mkdirSync(join(root, ".myflow", ".runtime", "sessions"), { recursive: true });
  mkdirSync(join(root, ".myflow", "tasks"), { recursive: true });
  writeFileSync(
    join(root, ".myflow", "workflow.md"),
    "[workflow-state:planning]\nPlan the work.\n[/workflow-state:planning]\n",
  );
  copyFileSync(REPO_TASK_PY, join(root, ".myflow", "scripts", "task.py"));
  writeFileSync(join(root, "spec-notes.md"), "spec notes\n");
  return root;
}

/** 清掉运行环境里可能泄漏的 myflow 身份，让 `PI_SESSION_ID` 决定会话文件。 */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.MYFLOW_CONTEXT_ID;
  delete env.MYFLOW_AGENT_TYPE;
  return env;
}

function taskPy(root: string): string {
  return join(root, ".myflow", "scripts", "task.py");
}

function run(root: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("python3", [taskPy(root), ...args], {
    cwd: root,
    encoding: "utf-8",
    env: cleanEnv(env),
  }).trim();
}

function runResult(root: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync("python3", [taskPy(root), ...args], {
    cwd: root,
    encoding: "utf-8",
    env: cleanEnv(env),
  });
}

function taskDir(root: string, slug: string): string {
  return join(root, ".myflow", "tasks", slug);
}

function taskRef(slug: string): string {
  return `.myflow/tasks/${slug}`;
}

/**
 * 建任务（真实 `task.py create`）。`PI_SESSION_ID=e2e` 使 create 把会话指针写进
 * `pi_e2e.json`，与工具的注入键对齐。create 只在指针为空时写入，因此一工程一任务。
 */
function createTask(root: string, slug: string, title = "E2E task"): string {
  run(root, ["create", title, "--slug", slug], { PI_SESSION_ID: SESSION_ID });
  return taskDir(root, slug);
}

/** 用真实 `add-context` curate 两个 manifest，让 `start` 不必用逃生口。 */
function curate(root: string, slug: string): void {
  run(root, ["add-context", taskRef(slug), "implement", "spec-notes.md", "why it matters"]);
  run(root, ["add-context", taskRef(slug), "check", "spec-notes.md", "why it matters"]);
}

function readQuestions(dir: string): Array<Record<string, unknown>> {
  const path = join(dir, QUESTIONS_FILE);
  if (!existsSync(path)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* 坏行跳过，与 task.py 的读取容错一致 */
    }
  }
  return rows;
}

/** 真实工具，注入活动任务解析器（生产接线由 index.ts 注入同一个东西）。 */
function makeAskTool(): ToolExec {
  return createAskUserTool({
    deriveContextKey: () => CONTEXT_KEY,
    isSubAgent: false,
  }) as unknown as ToolExec;
}

function makeApprovalTool(): ToolExec {
  return createApprovalTool({
    deriveContextKey: () => CONTEXT_KEY,
    isSubAgent: false,
  }) as unknown as ToolExec;
}

/** 桩 TUI 上下文：只有交互面是桩，其余字段与真实 `ExtensionContext` 同形。 */
function tuiContext(
  root: string,
  faces: {
    select?: (title: string, options: string[]) => Promise<string | undefined>;
    confirm?: (title: string, message: string) => Promise<boolean>;
  },
): Record<string, unknown> {
  return { cwd: root, mode: "tui", hasUI: true, ui: faces };
}

/** 无 UI 上下文（print/json/rpc 的形态）。 */
function noUiContext(root: string): Record<string, unknown> {
  return { cwd: root, mode: "print", hasUI: false, ui: undefined };
}

const QUESTION_PARAMS = {
  header: "门的位置",
  question: "门卡在哪个转换点？",
  options: ["只卡规划→执行", "每次动手前"],
};

/** 正向路径的公共前缀：真实提问 → 真实落盘 questions.jsonl。 */
async function askWithUi(root: string, pickIndex = 0): Promise<number> {
  let calls = 0;
  await makeAskTool().execute(
    "ask-1",
    QUESTION_PARAMS,
    undefined,
    undefined,
    tuiContext(root, {
      select: async (_title: string, options: string[]) => {
        calls += 1;
        return options[pickIndex];
      },
    }),
  );
  return calls;
}

/** 正向路径的公共中段：用户同意 → 真实写 approval.json。 */
async function approveWithUi(root: string): Promise<{ confirmCalls: number; result: ExecResult }> {
  let confirmCalls = 0;
  const result = await makeApprovalTool().execute(
    "approval-1",
    {},
    undefined,
    undefined,
    tuiContext(root, {
      confirm: async () => {
        confirmCalls += 1;
        return true;
      },
    }),
  );
  return { confirmCalls, result };
}

// ---------------------------------------------------------------------------
// 正向路径
// ---------------------------------------------------------------------------

test("E2E 正向：ask → 写 plan → request_approval → start 一路通过", async () => {
  const root = makeProject();
  try {
    const dir = createTask(root, "e2e");
    curate(root, "e2e");

    // 1) 真实提问两次（两道选择题），桩 select 选第一项。
    let selectCalls = 0;
    const pickFirst = async (_title: string, options: string[]) => {
      selectCalls += 1;
      return options[0];
    };
    const q1 = await makeAskTool().execute(
      "q1",
      QUESTION_PARAMS,
      undefined,
      undefined,
      tuiContext(root, { select: pickFirst }),
    );
    const q2 = await makeAskTool().execute(
      "q2",
      { header: "提问机制", question: "用什么机制提问？", options: ["新增工具", "仅提示词"] },
      undefined,
      undefined,
      tuiContext(root, { select: pickFirst }),
    );
    // 回退点：删掉真弹窗分支 → selectCalls 与 via 断言变红。
    assert.equal(selectCalls, 2, "每题恰好弹一次");
    assert.equal(q1.details.via, "ui-select");
    assert.equal(q2.details.via, "ui-select");

    const rows = readQuestions(dir);
    assert.equal(rows.length, 2, "每次提问追加一行");
    for (const row of rows) {
      assert.equal(row.via, "ui-select", "落盘必须是 ui-select");
      assert.equal(typeof row.answer, "string");
      assert.ok((row.answer as string).length > 0, "已作答行的 answer 非空");
    }

    // 2) 用户答完后才产出 plan（本任务三份 artifact 用两份代表）。
    writeFileSync(join(dir, "prd.md"), "# plan v1\n");
    writeFileSync(join(dir, "design.md"), "# design v1\n");
    const currentHash = run(root, ["plan-hash", taskRef("e2e")]);

    // 3) 真实批准工具：桩 confirm 同意 → 真实写 approval.json。
    const { confirmCalls, result: approval } = await approveWithUi(root);
    assert.equal(confirmCalls, 1, "前置齐备才弹一次批准窗");
    assert.equal(approval.details.approved, true);
    assert.equal(approval.details.via, "ui-confirm");
    assert.ok(existsSync(join(dir, APPROVAL_FILE)), "同意后必须落盘 approval.json");

    const record = JSON.parse(readFileSync(join(dir, APPROVAL_FILE), "utf-8"));
    // 跨侧一致性：写下的哈希与唯一实现逐字相等（ADR-1）。
    assert.equal(record.plan_hash, currentHash);
    assert.deepEqual(record.plan_files, ["prd.md", "design.md"]);
    assert.equal(record.questions_asked, 2, "批准快照记录已作答计数");
    assert.equal(record.approved_by, "ui-confirm");

    // 4) 门放行：真实 start，无任何逃生口。
    const started = runResult(root, ["start", taskRef("e2e")], { PI_SESSION_ID: SESSION_ID });
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /started:/);
    const task = JSON.parse(readFileSync(join(dir, "task.json"), "utf-8"));
    assert.equal(task.status, "in_progress");
    assert.equal(task.started_without_approval, undefined, "正常路径不得留绕过痕迹");
    assert.equal(resolveActiveTaskStatus(root, CONTEXT_KEY).status, "in_progress");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 反向路径 a：批准后改 plan → stale
// ---------------------------------------------------------------------------

test("E2E 反向 a：批准后改 plan，start 以 stale 拒绝并显示新旧哈希前 12 位", async () => {
  const root = makeProject();
  try {
    const dir = createTask(root, "stale");
    curate(root, "stale");
    assert.equal(await askWithUi(root), 1);

    writeFileSync(join(dir, "prd.md"), "# plan v1\n");
    const approvedHash = run(root, ["plan-hash", taskRef("stale")]);
    const { result: approval } = await approveWithUi(root);
    assert.equal(approval.details.approved, true);

    // 改一个 plan 文件：批准必须立即失效。
    writeFileSync(join(dir, "prd.md"), "# plan v2 (one byte changed)\n");
    const newHash = run(root, ["plan-hash", taskRef("stale")]);
    assert.notEqual(newHash, approvedHash, "改 plan 必须改哈希");

    const short = (hash: string) => hash.split(":", 2)[1].slice(0, 12);
    const result = runResult(root, ["start", taskRef("stale")], { PI_SESSION_ID: SESSION_ID });
    // 回退点：只查文件存在、不查哈希 → status 变 0。
    assert.notEqual(result.status, 0, "plan 变化后旧批准必须失效");
    assert.match(result.stderr, /stale/);
    assert.ok(result.stderr.includes(short(newHash)), `stderr 应含当前哈希前 12 位\n${result.stderr}`);
    assert.ok(result.stderr.includes(short(approvedHash)), `stderr 应含批准哈希前 12 位\n${result.stderr}`);
    assert.equal(resolveActiveTaskStatus(root, CONTEXT_KEY).status, "planning", "不得半启动");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 反向路径 b：没有 questions.jsonl → 批准工具拒绝且不弹窗
// ---------------------------------------------------------------------------

test("E2E 反向 b：没有 questions.jsonl 时批准工具拒绝且一次都不弹窗", async () => {
  const root = makeProject();
  try {
    const dir = createTask(root, "noq");
    curate(root, "noq");
    writeFileSync(join(dir, "prd.md"), "# plan\n");
    assert.ok(!existsSync(join(dir, QUESTIONS_FILE)), "本场景刻意没有任何提问记录");

    let confirmCalls = 0;
    const result = await makeApprovalTool().execute(
      "approval",
      {},
      undefined,
      undefined,
      tuiContext(root, {
        confirm: async () => {
          confirmCalls += 1;
          return true;
        },
      }),
    );

    // 回退点：删掉「questions_answered >= 1」前置 → confirmCalls 变 1。
    assert.equal(confirmCalls, 0, "问都没问过就绝不能弹批准窗");
    assert.equal(result.isError, true);
    assert.equal(result.details.approved, false);
    assert.equal(result.details.via, "rejected");
    assert.ok(!existsSync(join(dir, APPROVAL_FILE)), "被拒绝时不得写 approval.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 反向路径 c：questions_answered==0 + 合法 approval.json → R2 兜底
// ---------------------------------------------------------------------------

test("E2E 反向 c：questions_answered==0 但批准文件合法，start 仍拒绝（R2 兜底）", async () => {
  const root = makeProject();
  try {
    const dir = createTask(root, "r2");
    curate(root, "r2");
    writeFileSync(join(dir, "prd.md"), "# plan\n");

    // 人为造出「哈希匹配、但从未问过」的批准 —— 正是绕过写入侧的场景。
    const hash = run(root, ["plan-hash", taskRef("r2")]);
    writeFileSync(
      join(dir, APPROVAL_FILE),
      JSON.stringify({
        approved_at: "2026-10-14T13:20:03Z",
        approved_by: "cli",
        session_id: null,
        plan_files: ["prd.md"],
        plan_hash: hash,
        questions_asked: 0,
      }) + "\n",
    );
    assert.ok(!existsSync(join(dir, QUESTIONS_FILE)));

    const refused = runResult(root, ["start", taskRef("r2")], { PI_SESSION_ID: SESSION_ID });
    // 回退点：删掉 start 的 R2 兜底 → 哈希匹配就放行，status 会变 0。
    assert.notEqual(refused.status, 0, "批准合法但没问过，start 仍必须拒绝");
    assert.match(refused.stderr, /no choice question was ever answered/);
    assert.match(refused.stderr, /myflow_ask_user/);
    assert.equal(resolveActiveTaskStatus(root, CONTEXT_KEY).status, "planning");

    // --allow-unapproved 代表「跳过整个 plan 批准门」，必须同时跳过 R2 兜底并留痕。
    const bypassed = runResult(root, ["start", taskRef("r2"), "--allow-unapproved"], {
      PI_SESSION_ID: SESSION_ID,
    });
    assert.equal(bypassed.status, 0, bypassed.stderr);
    const task = JSON.parse(readFileSync(join(dir, "task.json"), "utf-8"));
    assert.equal(task.started_without_approval, true);
    assert.equal(task.status, "in_progress");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 反向路径 d：无 UI → instruction，不伪造同意
// ---------------------------------------------------------------------------

test("E2E 反向 d：无 UI 时两个工具都返回 instruction，绝不产生批准", async () => {
  const root = makeProject();
  try {
    const dir = createTask(root, "noui");
    curate(root, "noui");
    writeFileSync(join(dir, "prd.md"), "# plan\n");

    // 先在一次 TUI 会话里真实问过一遍：批准工具的前置④才有据可依，
    // 好让本用例专注在「批准动作本身无 UI」的降级行为上。
    assert.equal(await askWithUi(root), 1);
    const answeredBefore = readQuestions(dir).filter((row) => row.via === "ui-select").length;
    assert.equal(answeredBefore, 1);

    // (1) 提问工具在无 UI 下：返回指令，answer 必须为 null。
    const ask = await makeAskTool().execute(
      "ask-noui",
      { header: "无 UI", question: "能弹窗吗？", options: ["能", "不能"] },
      undefined,
      undefined,
      noUiContext(root),
    );
    // 回退点：无 UI 时返回任何非 null answer → 下面断言变红。
    assert.equal(ask.details.via, "no-ui");
    assert.equal(ask.details.answer, null, "没有真实用户输入就绝不能有答案");
    assert.equal(typeof ask.details.instruction, "string");
    assert.match(String(ask.details.instruction), /END YOUR TURN/);

    // 审计：设计（design.md §3.1）要求无 UI 也留一行 `via:"none"`，好把
    // 「问过但问不出来」与「根本没问」区分开；但它绝不是一条「已作答」。
    const afterAsk = readQuestions(dir).filter((row) => row.via === "ui-select");
    assert.equal(afterAsk.length, answeredBefore, "无 UI 不得新增任何已作答行");

    // (2) 批准工具在无 UI 下：返回指令，绝不写 approval.json。
    const approval = await makeApprovalTool().execute(
      "approval-noui",
      {},
      undefined,
      undefined,
      noUiContext(root),
    );
    // 回退点：无 UI 时走「默认同意」分支 → 下面 existsSync 变红。
    assert.equal(approval.details.approved, false);
    assert.equal(approval.details.via, "no-ui");
    assert.equal(typeof approval.details.instruction, "string");
    assert.match(String(approval.details.instruction), /mode=print/);
    assert.match(String(approval.details.instruction), /task\.py approve noui/);
    assert.ok(!existsSync(join(dir, APPROVAL_FILE)), "无 UI 时绝不能伪造同意");

    // 无 UI 的询问后，`start` 仍被门拦住（没有批准）。
    const refused = runResult(root, ["start", taskRef("noui")], { PI_SESSION_ID: SESSION_ID });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /no approval\.json|not approved/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
