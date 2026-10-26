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
import { execFileSync } from "node:child_process";
import {
  APPROVAL_FILE,
  APPROVED_BY,
  APPROVAL_TOOL_NAME,
  createApprovalTool,
} from "../.pi/extensions/myflow/approval.ts";

/**
 * B-1…B-7：`myflow_request_approval` 的前置门与「不得伪造同意」不变量（B3）。
 *
 * 这些用例不跑真实 Pi：`createApprovalTool` 把工具对象导出来，测试直接调
 * `execute(id, params, signal, onUpdate, fakeCtx)`，用一个桩 `ctx.ui.confirm`
 * 决定「用户同不同意」。产品代码里没有、也不会有一个「假装有 UI / 假装同意」
 * 的开关 —— 桩只活在测试进程里。
 *
 * 每条用例都对应一个「删掉即变红」的判断（写在各断言上方）。
 *
 * 跨侧一致性（B-4）是本套件的核心护栏：工具写出的 plan_hash 必须逐字等于唯一
 * 实现 `task.py plan-hash` 的输出，且已作答计数也只能来自 `task.py gate-info`
 * （design.md §3.3 / ADR-1）。
 */

const ROOT = join(import.meta.dirname, "..");
const REPO_TASK_PY = join(ROOT, ".myflow", "scripts", "task.py");
const CONTEXT_KEY = "pi_approval";
const TASK_REL = ".myflow/tasks/demo";

/** 一个带活动任务、会话指针与 task.py 副本的临时工程。 */
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-approval-tool-"));
  mkdirSync(join(root, ".myflow", "scripts"), { recursive: true });
  mkdirSync(join(root, ".myflow", ".runtime", "sessions"), { recursive: true });
  writeFileSync(
    join(root, ".myflow", "workflow.md"),
    "[workflow-state:planning]\nPlan.\n[/workflow-state:planning]\n",
  );
  // 工具会 spawn `<root>/.myflow/scripts/task.py`，临时工程必须自带副本。
  copyFileSync(REPO_TASK_PY, join(root, ".myflow", "scripts", "task.py"));
  const taskDir = join(root, ".myflow", "tasks", "demo");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ title: "Demo", status: "planning" }));
  writeSession(root, TASK_REL);
  return root;
}

function writeSession(root: string, currentTask: string | null): void {
  writeFileSync(
    join(root, ".myflow", ".runtime", "sessions", `${CONTEXT_KEY}.json`),
    JSON.stringify({ current_task: currentTask }),
  );
}

function taskDir(root: string): string {
  return join(root, ".myflow", "tasks", "demo");
}

function approvalPath(root: string): string {
  return join(taskDir(root), APPROVAL_FILE);
}

/** 一行「已作答」的问答审计记录；`via:"none"` 表示问过但没取到答案。 */
function questionRow(overrides: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      at: "2026-10-14T13:02:11Z",
      tool: "myflow_ask_user",
      header: "门的位置",
      question: "门卡在哪个转换点？",
      options: ["只卡规划→执行", "每次动手前"],
      answer: "只卡规划→执行",
      via: "ui-select",
      ...overrides,
    }) + "\n"
  );
}

/** 补齐前置 ③④：写一份 plan 与一条已作答记录。 */
function makeApprovable(root: string): void {
  writeFileSync(join(taskDir(root), "prd.md"), "hello plan\n");
  writeFileSync(join(taskDir(root), "questions.jsonl"), questionRow());
}

type ToolExec = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: unknown) => void) | undefined,
  ctx: Record<string, unknown>,
) => Promise<{
  content: Array<{ text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}>;

function makeTool(overrides: { isSubAgent?: boolean } = {}): ToolExec {
  return createApprovalTool({
    deriveContextKey: () => CONTEXT_KEY,
    isSubAgent: overrides.isSubAgent ?? false,
  }) as unknown as ToolExec;
}

/** 一个默认「TUI 且用户同意」的桩 ctx；各用例覆盖所需字段。 */
function fakeCtx(root: string, overrides: Record<string, unknown> = {}) {
  return {
    cwd: root,
    mode: "tui",
    hasUI: true,
    ui: { confirm: async () => true },
    ...overrides,
  };
}

/** 唯一实现 plan-hash 的输出，作为跨侧一致性断言的参照。 */
function repoPlanHash(root: string): string {
  return execFileSync("python3", [REPO_TASK_PY, "plan-hash", TASK_REL], {
    cwd: root,
    encoding: "utf-8",
  }).trim();
}

test("B-1 无活动任务 → 拒绝且不弹窗、不写文件", async () => {
  const root = makeProject();
  try {
    makeApprovable(root);
    writeSession(root, null); // 清掉活动任务
    let confirmCalls = 0;
    const ctx = fakeCtx(root, {
      ui: {
        confirm: async () => {
          confirmCalls += 1;
          return true;
        },
      },
    });

    const result = await makeTool().execute("id", {}, undefined, undefined, ctx);

    // 回退点：删掉「有活动任务」前置 → confirmCalls 不再是 0，且可能写出文件。
    assert.equal(confirmCalls, 0, "前置不通过就绝不能弹窗");
    assert.equal(result.isError, true);
    assert.equal(result.details.approved, false);
    assert.equal(result.details.via, "rejected");
    assert.ok(!existsSync(approvalPath(root)), "被拒绝时不得写 approval.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B-2 有任务但无 plan 文件 → 拒绝且不弹窗", async () => {
  const root = makeProject();
  try {
    // 有任务、有已作答记录，但没有任何 plan 文件。
    writeFileSync(join(taskDir(root), "questions.jsonl"), questionRow());
    let confirmCalls = 0;
    const ctx = fakeCtx(root, {
      ui: {
        confirm: async () => {
          confirmCalls += 1;
          return true;
        },
      },
    });

    const result = await makeTool().execute("id", {}, undefined, undefined, ctx);

    // 回退点：删掉「至少一个 plan 文件」前置 → confirmCalls 变 1。
    assert.equal(confirmCalls, 0, "无可批准对象时不得弹窗");
    assert.equal(result.details.via, "rejected");
    assert.deepEqual(result.details.reasons, ["no plan files (prd.md is missing) — nothing to approve"]);
    assert.ok(!existsSync(approvalPath(root)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B-3 无已作答问题时拒绝，且桩 confirm 调用次数为 0", async () => {
  const root = makeProject();
  try {
    writeFileSync(join(taskDir(root), "prd.md"), "hello plan\n");
    // 只有 via:none 的行：问过但没取到答案，绝不算「已作答」。
    writeFileSync(
      join(taskDir(root), "questions.jsonl"),
      questionRow({ answer: null, via: "none" }),
    );
    let confirmCalls = 0;
    const ctx = fakeCtx(root, {
      ui: {
        confirm: async () => {
          confirmCalls += 1;
          return true;
        },
      },
    });

    const result = await makeTool().execute("id", {}, undefined, undefined, ctx);

    // 回退点：删掉「questions_answered >= 1」前置 → confirmCalls 变 1。
    assert.equal(confirmCalls, 0, "问都没问过就绝不能弹批准窗");
    assert.equal(result.details.via, "rejected");
    assert.match(String(result.details.reasons), /no answered choice questions/);
    assert.ok(!existsSync(approvalPath(root)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B-4 四条前置齐备 + 用户同意 → 写 approval.json，plan_hash 与 plan-hash 逐字相等", async () => {
  const root = makeProject();
  const previousSession = process.env.PI_SESSION_ID;
  process.env.PI_SESSION_ID = "approval-tool-test";
  try {
    makeApprovable(root);
    let confirmCalls = 0;
    const ctx = fakeCtx(root, {
      ui: {
        confirm: async () => {
          confirmCalls += 1;
          return true;
        },
      },
    });

    const result = await makeTool().execute("id", {}, undefined, undefined, ctx);

    assert.equal(confirmCalls, 1, "四条前置齐备才弹一次窗");
    assert.equal(result.details.approved, true);
    assert.equal(result.details.via, "ui-confirm");

    const written = JSON.parse(readFileSync(approvalPath(root), "utf-8"));
    // 回退点：漏写任一字段 → 对应断言变红。
    assert.match(written.approved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(written.approved_by, APPROVED_BY);
    assert.equal(written.approved_by, "ui-confirm");
    assert.equal(written.session_id, "approval-tool-test");
    assert.deepEqual(written.plan_files, ["prd.md"]);
    assert.equal(written.questions_asked, 1);
    // 跨侧一致性：工具写出的哈希必须逐字等于唯一实现 plan-hash 的输出。
    // 回退点：在 TS 里内联一份哈希实现（ADR-1 禁止）→ 这条断言最可能变红。
    assert.equal(written.plan_hash, repoPlanHash(root));
    assert.equal(result.details.plan_hash, repoPlanHash(root));
  } finally {
    if (previousSession === undefined) delete process.env.PI_SESSION_ID;
    else process.env.PI_SESSION_ID = previousSession;
    rmSync(root, { recursive: true, force: true });
  }
});

test("B-4b ctx.sessionManager 的 session id 优先于环境变量", async () => {
  const root = makeProject();
  const previousSession = process.env.PI_SESSION_ID;
  process.env.PI_SESSION_ID = "env-fallback";
  try {
    makeApprovable(root);
    const ctx = fakeCtx(root, {
      sessionManager: { getSessionId: () => "ctx-session" },
    });

    const result = await makeTool().execute("id", {}, undefined, undefined, ctx);

    assert.equal(result.details.approved, true);
    const written = JSON.parse(readFileSync(approvalPath(root), "utf-8"));
    // 回退点：只读 PI_SESSION_ID（shell 工具才有）→ UI 工具写出的 session_id 恒为 null。
    assert.equal(written.session_id, "ctx-session");
  } finally {
    if (previousSession === undefined) delete process.env.PI_SESSION_ID;
    else process.env.PI_SESSION_ID = previousSession;
    rmSync(root, { recursive: true, force: true });
  }
});

test("B-5 用户拒绝（confirm=false）→ 目标文件不存在", async () => {
  const root = makeProject();
  try {
    makeApprovable(root);
    const ctx = fakeCtx(root, { ui: { confirm: async () => false } });

    const result = await makeTool().execute("id", {}, undefined, undefined, ctx);

    // 回退点：把「拒绝也写文件」当默认路径 → 下面 existsSync 变红。
    assert.equal(result.details.approved, false);
    assert.equal(result.details.via, "cancelled");
    assert.ok(!existsSync(approvalPath(root)), "拒绝时不得留下 approval.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B-6 无 UI（非 TUI）→ 不写文件，返回让人类跑 CLI 的指令", async () => {
  const root = makeProject();
  try {
    makeApprovable(root);
    // hasUI=false 且没有 confirm：print/json/rpc 的形态。
    const ctx = fakeCtx(root, { hasUI: false, mode: "print", ui: undefined });

    const result = await makeTool().execute("id", {}, undefined, undefined, ctx);

    // 回退点：无 UI 时走「默认同意」分支 → 下面 existsSync 变红。
    assert.equal(result.details.approved, false);
    assert.equal(result.details.via, "no-ui");
    assert.equal(typeof result.details.instruction, "string");
    assert.match(String(result.details.instruction), /mode=print/);
    assert.match(String(result.details.instruction), /task\.py approve demo/);
    assert.ok(!existsSync(approvalPath(root)), "无 UI 时绝不能伪造同意");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B-7 子代理调用被拒，且不写文件", async () => {
  const root = makeProject();
  try {
    makeApprovable(root);
    let confirmCalls = 0;
    const ctx = fakeCtx(root, {
      ui: {
        confirm: async () => {
          confirmCalls += 1;
          return true;
        },
      },
    });

    const result = await makeTool({ isSubAgent: true }).execute("id", {}, undefined, undefined, ctx);

    // 回退点：删掉注入的 isSubAgent 守卫 → confirmCalls 变 1、文件被写出。
    assert.equal(confirmCalls, 0, "子代理不得弹批准窗");
    assert.equal(result.isError, true);
    assert.equal(result.details.approved, false);
    assert.ok(!existsSync(approvalPath(root)), "子代理不得写 approval.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("工具名与批准文件名是跨语言契约的一部分", () => {
  // 这两个字面量是 task.py（APPROVAL_FILE）与 index.ts（子代理守卫）共用的锚点。
  assert.equal(APPROVAL_TOOL_NAME, "myflow_request_approval");
  assert.equal(APPROVAL_FILE, "approval.json");
});
