import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { resolveActiveTaskStatus } from "../.pi/extensions/myflow/turn-cache.ts";

/**
 * P / plan-approval-gate：`task.py` 侧的批准门（B1）。
 *
 * 本套件覆盖 implement.md §3 的 P-1…P-9。每一条都对应一个「删掉即变红」的门：
 *   - plan-hash：内容敏感、固定清单顺序、只算存在的文件（P-1、P-2）。
 *   - approve：先提问的强制点、非 tty 拒绝、成功落盘（P-3、P-4、P-5）。
 *   - start：缺批准拒绝、改 plan 后变 stale、逃生口留痕（P-6、P-7、P-8）。
 *   - validate：报告批准态（P-9，且不因缺批准而改变退出码）。
 *
 * 注意：本套件是「唯一 plan 哈希实现」的跨侧契约点之一 —— 这里只对拍
 * `task.py plan-hash` 的输出，绝不在 TS 里重写一遍哈希算法（design.md ADR-1）。
 */

const ROOT = join(import.meta.dirname, "..");
const TASK_PY = join(ROOT, ".myflow", "scripts", "task.py");

// 固定内容的 golden 值，钉死「filename + NUL + 原始字节 + NUL」的字节布局。
// 这是契约的观测点，不是第二份哈希实现（没有 TS 侧的拼接逻辑）。
const GOLDEN_PRD_ONLY = "sha256:b5334883d194e4f43bcdc1a43bd4d8458702371737c4ba8332617f410187fd02";
const GOLDEN_PRD_DESIGN = "sha256:59fc209de675d50ff8270e3437b5cbdc4d4cddc881a7b3160765b4fd979c5280";

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-approval-"));
  mkdirSync(join(root, ".myflow"), { recursive: true });
  writeFileSync(
    join(root, ".myflow", "workflow.md"),
    "[workflow-state:no_task]\nnone\n[/workflow-state:no_task]\n",
  );
  return root;
}

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.MYFLOW_CONTEXT_ID;
  delete env.MYFLOW_AGENT_TYPE;
  return env;
}

function run(root: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("python3", [TASK_PY, ...args], {
    cwd: root,
    encoding: "utf-8",
    env: cleanEnv(env),
  }).trim();
}

function runResult(root: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync("python3", [TASK_PY, ...args], {
    cwd: root,
    encoding: "utf-8",
    env: cleanEnv(env),
  });
}

/**
 * 在真正的 tty 分支上跑 `approve`。Git Bash 下的 `script`/`winpty` 在 Windows
 * 上不稳，且不该为了测试在产物里留一个「假装是 tty」的开关（那正好是模型也能
 * 设的开关）。这里用 `python3 -c` 加载 task.py 并把 `sys.stdin` 换成一个
 * isatty()=True 的桩，从而只测分支本身，不碰产品代码。
 */
const TTY_SHIM = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("myflow_task", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
task_args = sys.argv[2:]
class _TTY:
    def isatty(self):
        return True
sys.stdin = _TTY()
sys.argv = ["task.py", *task_args]
spec.loader.exec_module(mod)
sys.exit(mod.main())
`;

function runWithTty(root: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync("python3", ["-c", TTY_SHIM, TASK_PY, ...args], {
    cwd: root,
    encoding: "utf-8",
    env: cleanEnv(env),
  });
}

function createTask(root: string, slug: string, title = "Gate task"): string {
  run(root, ["create", title, "--slug", slug], { PI_SESSION_ID: sessionId(slug) });
  return join(root, ".myflow", "tasks", slug);
}

/** create/start 共用同一个会话键，否则指针会落在另一个会话文件里。 */
function sessionId(slug: string): string {
  return `gate-${slug}`;
}

function taskDir(root: string, slug: string): string {
  return join(root, ".myflow", "tasks", slug);
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

/** 给任务补一份 plan 与一条已作答记录，使 approve 的前置全部满足。 */
function makeApprovable(root: string, slug: string): string {
  const dir = createTask(root, slug);
  writeFileSync(join(dir, "prd.md"), "hello plan\n");
  writeFileSync(join(dir, "questions.jsonl"), questionRow());
  return dir;
}

function approvalFile(root: string, slug: string): string {
  return join(taskDir(root, slug), "approval.json");
}

// ---------------------------------------------------------------------------
// P-1 / P-2：plan-hash 是唯一实现，内容敏感、顺序固定、只算存在的文件
// ---------------------------------------------------------------------------

test("P-1 plan-hash 对同一 plan 稳定，且对改一字节敏感", () => {
  const root = makeProject();
  try {
    const dir = createTask(root, "p1");
    writeFileSync(join(dir, "prd.md"), "hello plan\n");

    const first = run(root, ["plan-hash", ".myflow/tasks/p1"]);
    const second = run(root, ["plan-hash", ".myflow/tasks/p1"]);
    // 回退点：把 plan-hash 换成常量 → 下面的 notEqual 变红。
    assert.equal(first, second, "同一个 plan 必须得到同一个哈希");
    assert.equal(first, GOLDEN_PRD_ONLY, "golden：钉死 filename+NUL+bytes+NUL 布局");

    // 回退点：哈希忽略内容（只算文件名）→ 这里变红。
    writeFileSync(join(dir, "prd.md"), "hello plan!\n"); // 只差一个字节
    const changed = run(root, ["plan-hash", ".myflow/tasks/p1"]);
    assert.notEqual(changed, first, "plan 改一个字节，哈希必须变");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P-2 plan-hash 只算存在的 plan 文件，顺序由固定清单决定而非目录遍历", () => {
  const root = makeProject();
  try {
    const dir = createTask(root, "p2");
    writeFileSync(join(dir, "prd.md"), "hello plan\n");
    writeFileSync(join(dir, "design.md"), "design body\n");
    const twoFiles = run(root, ["plan-hash", ".myflow/tasks/p2"]);
    assert.equal(twoFiles, GOLDEN_PRD_DESIGN, "golden：prd 在前、design 在后的固定顺序");

    // 回退点：把固定清单换成目录遍历 → 下面两个任务的哈希不再相等（创建顺序不同）。
    const dirB = createTask(root, "p2b");
    writeFileSync(join(dirB, "design.md"), "design body\n");
    writeFileSync(join(dirB, "prd.md"), "hello plan\n");
    assert.equal(
      run(root, ["plan-hash", ".myflow/tasks/p2b"]),
      twoFiles,
      "哈希只取决于固定清单顺序，不取决于文件创建/遍历顺序",
    );

    // 新增一个 plan 文件必须改变哈希（design/implement 参与哈希）。
    writeFileSync(join(dir, "implement.md"), "impl body\n");
    const threeFiles = run(root, ["plan-hash", ".myflow/tasks/p2"]);
    assert.notEqual(threeFiles, twoFiles, "多一个 plan 文件，哈希必须变");

    // 回退点：把 task.json / *.jsonl / approval.json 也算进去 → 下面变红。
    writeFileSync(join(dir, "questions.jsonl"), questionRow());
    writeFileSync(join(dir, "approval.json"), "{}");
    writeFileSync(join(dir, "implement.jsonl"), '{"file": "prd.md", "reason": "x"}\n');
    writeFileSync(join(dir, "task.json"), JSON.stringify({ status: "churn" }));
    assert.equal(
      run(root, ["plan-hash", ".myflow/tasks/p2"]),
      threeFiles,
      "task.json / questions.jsonl / approval.json 不参与 plan 哈希",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P-3 / P-4 / P-5：approve 的「先提问」门、非 tty 门、成功落盘
// ---------------------------------------------------------------------------

test("P-3 approve 在没有已作答问题时拒绝（问过但没答案也不算）", () => {
  const root = makeProject();
  try {
    const dir = createTask(root, "p3");
    writeFileSync(join(dir, "prd.md"), "hello plan\n");

    // 回退点：去掉「已作答 ≥ 1」校验 → 下面变红（文件会被写出来）。
    const absent = runResult(root, ["approve", ".myflow/tasks/p3"]);
    assert.notEqual(absent.status, 0, "questions.jsonl 不存在时必须拒绝");
    assert.match(absent.stderr, /no answered choice questions/);
    assert.ok(!existsSync(join(dir, "approval.json")), "被拒绝时不得写 approval.json");

    // via:"none" 表示「问过但没取到答案」，绝不能被当成回答。
    writeFileSync(join(dir, "questions.jsonl"), questionRow({ answer: null, via: "none" }));
    const none = runResult(root, ["approve", ".myflow/tasks/p3"]);
    assert.notEqual(none.status, 0, "via:none 不算已作答");
    assert.match(none.stderr, /no answered choice questions/);
    assert.ok(!existsSync(join(dir, "approval.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P-4 approve 在 stdin 不是 tty 时拒绝（且不写文件）", () => {
  const root = makeProject();
  try {
    const dir = makeApprovable(root, "p4");

    // spawnSync 的 stdin 是管道 → isatty() 为假。前置 ①②③ 都满足，只卡 tty。
    const result = runResult(root, ["approve", ".myflow/tasks/p4"]);
    // 回退点：删掉 sys.stdin.isatty() 检查 → 下面变红（会出现 approval.json）。
    assert.notEqual(result.status, 0, "非交互 shell 不得批准");
    assert.match(result.stderr, /not a tty/);
    assert.match(result.stderr, /myflow_request_approval/, "提示应指向 TUI 批准工具");
    assert.ok(!existsSync(join(dir, "approval.json")), "非 tty 被拒时不得写文件");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P-5 approve 成功后 approval.json 字段齐全，plan_hash 与 plan-hash 一致", () => {
  const root = makeProject();
  try {
    const dir = makeApprovable(root, "p5");
    // 两条记录，其中一条 via:none —— questions_asked 只应数已作答的那条。
    writeFileSync(
      join(dir, "questions.jsonl"),
      questionRow() + questionRow({ answer: null, via: "none" }),
    );

    const result = runWithTty(root, ["approve", ".myflow/tasks/p5"], { PI_SESSION_ID: "p5-tty" });
    assert.equal(result.status, 0, result.stderr);

    const approval = JSON.parse(readFileSync(join(dir, "approval.json"), "utf-8"));
    // 回退点：漏写任一字段 → 对应断言变红。
    assert.match(approval.approved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(approval.approved_by, "cli");
    assert.equal(approval.session_id, "p5-tty");
    assert.deepEqual(approval.plan_files, ["prd.md"]);
    assert.equal(approval.questions_asked, 1);
    // 跨侧一致性：批准记录的哈希必须等于唯一实现 plan-hash 的输出。
    assert.equal(approval.plan_hash, run(root, ["plan-hash", ".myflow/tasks/p5"]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P-6 / P-7 / P-8：start 的批准门
// ---------------------------------------------------------------------------

test("P-6 start 在没有 approval.json 时非零退出并给出三条可操作提示", () => {
  const root = makeProject();
  try {
    const dir = createTask(root, "p6");
    writeFileSync(join(dir, "prd.md"), "hello plan\n");

    const result = runResult(root, ["start", ".myflow/tasks/p6", "--allow-empty-context"], {
      PI_SESSION_ID: sessionId("p6"),
    });
    // 回退点：删掉 start 的第二个门 → 下面变红（status 变 0）。
    assert.notEqual(result.status, 0, "无批准不得 start");
    assert.match(result.stderr, /no approval\.json|not approved/);
    assert.match(result.stderr, /current plan hash:/);
    assert.match(result.stderr, /--allow-unapproved/, "提示 (c) 必须命名逃生口");
    assert.match(result.stderr, /approve/, "提示 (b) 必须命名 approve 子命令");

    // 被拒绝时不得半启动。
    const task = JSON.parse(readFileSync(join(dir, "task.json"), "utf-8"));
    assert.equal(task.status, "planning");
    assert.equal(resolveActiveTaskStatus(root, `pi_${sessionId("p6")}`).status, "planning");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P-7 批准后改 plan，start 因 stale 拒绝（批准绑定 plan 内容）", () => {
  const root = makeProject();
  try {
    const dir = makeApprovable(root, "p7");
    const approved = runWithTty(root, ["approve", ".myflow/tasks/p7"], { PI_SESSION_ID: sessionId("p7") });
    assert.equal(approved.status, 0, approved.stderr);

    // 改一个 plan 字节，旧批准立即失效。
    writeFileSync(join(dir, "prd.md"), "hello plan CHANGED\n");
    const result = runResult(root, ["start", ".myflow/tasks/p7", "--allow-empty-context"], {
      PI_SESSION_ID: sessionId("p7"),
    });
    // 回退点：只查 approval.json 是否存在、不查哈希 → 下面变红。
    assert.notEqual(result.status, 0, "plan 变化后批准必须失效");
    assert.match(result.stderr, /stale/);
    assert.match(result.stderr, /current plan hash:/);
    assert.match(result.stderr, /approved plan hash:/);
    assert.equal(resolveActiveTaskStatus(root, `pi_${sessionId("p7")}`).status, "planning");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P-8 --allow-unapproved 放行但留痕（stderr 警告 + task.json 标记）", () => {
  const root = makeProject();
  try {
    const dir = createTask(root, "p8");
    writeFileSync(join(dir, "prd.md"), "hello plan\n");

    const result = runResult(
      root,
      ["start", ".myflow/tasks/p8", "--allow-empty-context", "--allow-unapproved"],
      { PI_SESSION_ID: sessionId("p8") },
    );
    // 回退点：静默放行（不打警告 / 不写标记）→ 下面变红。
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /without plan approval/);
    const task = JSON.parse(readFileSync(join(dir, "task.json"), "utf-8"));
    assert.equal(task.started_without_approval, true, "绕过必须留痕");
    assert.equal(task.status, "in_progress");
    assert.equal(resolveActiveTaskStatus(root, `pi_${sessionId("p8")}`).status, "in_progress");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P-9：validate 报告批准态，但不因缺批准而改变退出码
// ---------------------------------------------------------------------------

test("P-9 validate 报告已作答计数与批准态（approved / stale / missing）", () => {
  const root = makeProject();
  try {
    const dir = makeApprovable(root, "p9");
    // 让 manifest 门通过，从而专注批准态报告（validate 的退出码由 manifest 决定）。
    writeFileSync(join(root, "spec-notes.md"), "notes\n");
    run(root, ["add-context", ".myflow/tasks/p9", "implement", "spec-notes.md", "why"]);
    run(root, ["add-context", ".myflow/tasks/p9", "check", "spec-notes.md", "why"]);

    const before = runResult(root, ["validate", ".myflow/tasks/p9"]);
    // 回退点：让 validate 因缺批准而非零退出 → 下面 status 断言变红。
    assert.equal(before.status, 0, "缺批准不应让 validate 失败（它是报告器）");
    assert.match(before.stdout, /questions\.jsonl answered: 1/);
    assert.match(before.stdout, /approval\.json: missing/);
    assert.match(before.stdout, /plan hash matches current plan: no/);

    const approved = runWithTty(root, ["approve", ".myflow/tasks/p9"], { PI_SESSION_ID: "p9" });
    assert.equal(approved.status, 0, approved.stderr);
    const afterApprove = runResult(root, ["validate", ".myflow/tasks/p9"]);
    assert.equal(afterApprove.status, 0);
    assert.match(afterApprove.stdout, /approval\.json: approved/);
    assert.match(afterApprove.stdout, /plan hash matches current plan: yes/);

    writeFileSync(join(dir, "prd.md"), "hello plan CHANGED\n");
    const afterEdit = runResult(root, ["validate", ".myflow/tasks/p9"]);
    assert.equal(afterEdit.status, 0);
    assert.match(afterEdit.stdout, /approval\.json: stale/);
    assert.match(afterEdit.stdout, /plan hash matches current plan: no/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P-10 / P-11：gate-info 是 TS 侧唯一读数入口，start 有 R2 兜底
// ---------------------------------------------------------------------------

test("P-10 gate-info 输出字段齐全，plan_hash 与 plan-hash 逐字相等", () => {
  const root = makeProject();
  try {
    const dir = createTask(root, "p10");
    writeFileSync(join(dir, "prd.md"), "hello plan\n");
    writeFileSync(join(dir, "design.md"), "design body\n");

    const info = JSON.parse(run(root, ["gate-info", ".myflow/tasks/p10"]));
    const hash = run(root, ["plan-hash", ".myflow/tasks/p10"]);
    // 回退点：gate-info 自己另算一份哈希 → 这条断言不等。
    assert.equal(info.plan_hash, hash, "gate-info 的哈希必须逐字等于 plan-hash 的输出");
    assert.deepEqual(info.plan_files, ["prd.md", "design.md"]);
    assert.equal(info.questions_answered, 0);
    assert.deepEqual(info.approval, { status: "missing", plan_hash: null });
    // 只读：不得因为查一次就写出 approval.json。
    assert.ok(!existsSync(join(dir, "approval.json")), "gate-info 不得写任何文件");

    writeFileSync(join(dir, "questions.jsonl"), questionRow());
    const approved = runWithTty(root, ["approve", ".myflow/tasks/p10"], { PI_SESSION_ID: sessionId("p10") });
    assert.equal(approved.status, 0, approved.stderr);

    const info2 = JSON.parse(run(root, ["gate-info", ".myflow/tasks/p10"]));
    assert.equal(info2.questions_answered, 1);
    assert.equal(info2.approval.status, "approved");
    assert.equal(info2.approval.plan_hash, hash);

    // 改 plan → 批准态变 stale，但 current 哈希也跟着变（不是批准哈希）。
    writeFileSync(join(dir, "prd.md"), "hello plan CHANGED\n");
    const info3 = JSON.parse(run(root, ["gate-info", ".myflow/tasks/p10"]));
    assert.equal(info3.approval.status, "stale");
    assert.equal(info3.approval.plan_hash, hash, "stale 时保留旧批准哈希");
    assert.notEqual(info3.plan_hash, hash, "stale 时 current 哈希是新 plan 的");

    // 任务不存在 → 单行 JSON 错误 + 非零退出（可解析，不伪装成空门）。
    const missing = runResult(root, ["gate-info", ".myflow/tasks/does-not-exist"]);
    assert.notEqual(missing.status, 0);
    const errorJson = JSON.parse(missing.stdout.trim());
    assert.equal(typeof errorJson.error, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P-11 start 在 questions_answered==0 但批准文件合法时仍拒绝（R2 兜底）", () => {
  const root = makeProject();
  try {
    const dir = createTask(root, "p11");
    writeFileSync(join(dir, "prd.md"), "hello plan\n");
    // 人为造出一份哈希匹配、但「从未问过」的批准（正是绕过写入侧的场景）。
    const hash = run(root, ["plan-hash", ".myflow/tasks/p11"]);
    writeFileSync(
      join(dir, "approval.json"),
      JSON.stringify({
        approved_at: "2026-10-14T13:20:03Z",
        approved_by: "cli",
        session_id: null,
        plan_files: ["prd.md"],
        plan_hash: hash,
        questions_asked: 0,
      }) + "\n",
    );
    assert.ok(!existsSync(join(dir, "questions.jsonl")), "本场景刻意没有任何已作答记录");

    const refused = runResult(root, ["start", ".myflow/tasks/p11", "--allow-empty-context"], {
      PI_SESSION_ID: sessionId("p11"),
    });
    // 回退点：删掉 start 的 R2 兜底 → 哈希匹配就放行，这里会变 0。
    assert.notEqual(refused.status, 0, "批准文件合法但没问过，start 仍必须拒绝");
    assert.match(refused.stderr, /no choice question was ever answered/);
    assert.match(refused.stderr, /myflow_ask_user/);
    assert.equal(resolveActiveTaskStatus(root, `pi_${sessionId("p11")}`).status, "planning");

    // --allow-unapproved 代表「跳过整个 plan 批准门」，必须同时跳过 R2 兜底。
    const bypassed = runResult(
      root,
      ["start", ".myflow/tasks/p11", "--allow-empty-context", "--allow-unapproved"],
      { PI_SESSION_ID: sessionId("p11") },
    );
    assert.equal(bypassed.status, 0, bypassed.stderr);
    assert.equal(resolveActiveTaskStatus(root, `pi_${sessionId("p11")}`).status, "in_progress");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
