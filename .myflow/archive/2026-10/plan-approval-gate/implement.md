# implement.md — 执行顺序、批次与契约副本清单

> 判定法与契约见 `design.md`；本文件只定「按什么顺序改哪些文件，拿什么证明改对了」。

---

## 0. 执行前提（硬约束）

| 约束 | 依据 | 对计划的含义 |
| --- | --- | --- |
| `myflow-implement` / `myflow-check` 可写但**一次只能一个** | `.pi/agents/*.md` 无 `writesUnder`，`subagent.ts` 拒绝写者并行 | 六批**全部串行**，不得并行 |
| 每次 dispatch 有 `timeoutMs`（默认 15 分钟） | `.myflow/workflow.md` Dispatch Protocol | 每批只做一件事；超时则拆小重派，不重做 |
| dispatch prompt 必须以 `Active task: <task.py current>` 开头 | 同上 | 统一模板见 §5 |
| 子代理**不读** jsonl 之外的东西；`prd.md`/`design.md`/`implement.md` 自动注入 | `context-injection.ts` | 本任务三份 artifact 已覆盖全部设计信息，jsonl 只需放**代码基线** |
| 注入预算 = 131072 字节总量（含 wrapper/header 开销） | 横评 `DV-1/DV-7` 的实测教训 | 本任务 jsonl 只放 2–3 个文件；**定稿前必须实算，不能只加文件字节** |
| 本仓库**无** `.myflow/worktree.yaml`（用户已定 `R-1`：**不建**） | 实测 `ls` + 用户决定 | `myflow-check` 的 verify 门**继续空跑** → 真正的校验靠 `node --test tests/` 与 §3 清单 |
| `tests/` 是 `R-T` 的唯一来源；回归即红的断言必须写进测试体，不能只写标题 | 横评 `C2` 复核教训 | 每个新门都要有「去掉该门即变红」的用例 |
| **测试必须清空 `MYFLOW_*`** 才有意义 | `.myflow/spec/harness/index.md` Pre-Development Checklist；横评实测 215/215 vs 泄漏时 198/17 | 跑测命令固定为：`env -u MYFLOW_AGENT_TYPE -u MYFLOW_CONTEXT_ID -u MYFLOW_SKIP_BREADCRUMB -u MYFLOW_WRITES_UNDER node --test tests/` |

---

## 1. 批次总览

| 批 | 内容 | 产出 | 门禁 |
| --- | --- | --- | --- |
| `B1` | `task.py` 侧：`plan-hash` / `approve` / `start` 门 / `validate` 报告 | `.myflow/scripts/task.py`、`tests/plan-approval-gate.test.ts`（Python 部分） | 新测试全绿；**旧测试不回归** |
| `B2` | 提问工具 | `.pi/extensions/myflow/ask.ts`（新）、`tests/ask-user.test.ts`（新） | 无 UI 时**不伪造答案**；有 UI 时返回选中项 |
| `B3` | 补 `task.py`（`gate-info` + R2 兑底）+ 批准工具 | `.myflow/scripts/task.py`（追加）、`.pi/extensions/myflow/approval.ts`（新）、`tests/plan-approval-tool.test.ts`（新） | 4 条前置逐条可测；**不内联哈希、不自己数已作答**；`start` 兑底可测 |
| `B4` | 接线 | `.pi/extensions/myflow/index.ts`、`status.ts`、`pi-coding-agent.d.ts`（按需） | 子代理调用被拦；`/myflow-status` 显示批准态 |
| `B5` | 契约副本同步 | `.myflow/workflow.md`、`.myflow/spec/harness/index.md`、`.pi/skills/myflow-brainstorm/SKILL.md`、`.pi/skills/myflow-meta/references/harness-conventions.md`、`.pi/prompts/myflow-continue.md` | §4 清单逐项勾完 |
| `B6` | 端到端 + 全量回归 | `tests/*` 补充、全量 `node --test tests/` | 见 §3 |

**顺序理由**：`B1` 是其余各批的依赖源（哈希与文件格式都在这里定稿）；
`B5` 必须在代码定稿后写（否则文档会描述未落地的东西）；
`B6` 收口。

---

## 2. 各批详细

### B1 — `task.py` 侧（唯一哈希实现 + 门）

1. **`plan-hash <slug>`**：严格按 `design.md` §3.3 实现。
   - 固定顺序 `["prd.md", "design.md", "implement.md"]`，**只算存在的文件**；
   - 逐文件拼 `filename`(UTF-8) + `\0` + 原始字节 + `\0`；`sha256`；输出 `sha256:<hex>`；
   - 用 `_resolve_task_dir` 限定在 `.myflow/tasks/` 内（沿用既有包含性校验，不得新开路径解析）；
   - 纯函数化（便于测试直接 import 或对拍）。
2. **`approve <slug>`**：
   - 前置 ①任务存在且在 `tasks/` 内 ②`questions.jsonl` 有 ≥1 条 `via=="ui-select"` 且 `answer` 非空的行；
     任一不满足 → 非零退出 + 可操作提示（明确说「先提问」）；
   - `sys.stdin.isatty()` 为假 → 拒绝（提示由人类在终端运行，或用 TUI 批准工具）；
   - 写 `approval.json`（`design.md` §3.2 字段），`approved_by: "cli"`。
3. **`start` 第二个门**：在既有空上下文门禁**之后**追加批准校验（`design.md` §5.2）。
   - `--allow-unapproved` 放行但在 stderr 打警告，并在 `task.json` 写 `started_without_approval: true`。
4. **`validate` 报告**：追加已作答计数、`approval.json` 状态（`approved`/`stale`/`missing`）、哈希对比。
5. **测试**（`tests/plan-approval-gate.test.ts`，沿用 `tests/task-gate.test.ts` 的
   `makeProject` / `cleanEnv` / `run` / `runResult` 写法）：见 §3 的 P-1…P-8。

**陷阱（必须避免）**：
- 不要把批准信息写进 `task.json`（`start`/`archive` 会重写它；PRD 已选独立文件）。
- 不要在缺 `prd.md` 时把哈希算成空串哈希后**放行** —— 缺 plan 文件应视为「无可批准对象」。
- `isatty` 检查不要放进 `plan-hash`（那是只读命令，模型可以随意调）。

### B2 — `ask.ts`：`myflow_ask_user`

1. 新文件，导出注册函数（供 `index.ts` 调用），形态对齐 `subagent.ts` 的注册风格。
2. 入参校验：`options` 长度 2–4；`header` 截断到 24 字符；`question` 非空。
   违规 → 返回错误结果，**不弹窗**。
3. 交互：`ctx.hasUI && ctx.ui?.select` → `await ctx.ui.select(question, options)`；
   - 返回 `undefined` → `{ answer: null, via: "cancelled" }`
   - 返回字符串 → `{ answer, via: "ui-select" }`
4. 无 UI → `{ answer: null, via: "no-ui", instruction: <design.md §4.1 的原文> }`。
5. **审计**：无论哪种结果都追加一行 `questions.jsonl`（`via` 用 `ui-select`/`none`）。
   该文件只追加；解析容错（坏行跳过，不抛）。
6. 子代理：`detectAgentType() !== null` → 直接返回拒绝结果（不弹窗、不写文件）。
7. 测试：`tests/ask-user.test.ts`，见 §3 的 A-1…A-6。

### B3 — `gate-info` + R2 兑底 + `approval.ts`（**含一项开工前的设计修正**）

**先改 `task.py`（只追加，不改 B1 已有行为）：**
- 新增**只读**子命令 `gate-info <slug>`：stdout 单行 JSON
  `{"plan_hash":…,"plan_files":[…],"questions_answered":N,"approval":{"status":"approved|stale|missing","plan_hash":…}}`。
  实现必须**复用** `_plan_hash` / `_answered_question_count` / `_approval_report`，**不得新写一份判据**。
- `start` 在批准校验通过后，**再独立校验一次 `questions_answered >= 1`**（R2 兑底，`design.md` §5.2），
  用与 `approve` 同一个函数。不满足 → 拒绝 + 提示「先提问：用 `myflow_ask_user`」。
  ⚠️ `--allow-unapproved` **同时跳过**这道兑底（它代表「跳过整个 plan 批准门」），
  否则 B1 已改的 19 处既有测试会全红。
- 新增测试 `P-10`、`P-11`（见 §3）。

**再写 `approval.ts`：**
0. **依赖注入，不得 `import "./index.ts"`**（**B2 暴露的结构问题**）：`ask.ts` 现在
   `import { detectAgentType } from "./index.ts"`，B4 接线后成循环依赖；而 `subagent.ts` 的
   **既有范式**就是不 import `index.ts`，靠 `registerMyflowSubagent(pi, { deriveContextKey })` 注入。
   → registration 至少提供 `deriveContextKey` 与 `isSubAgent` 两个能力，并在代码注释里说明
   为何不能 import。（B4 会把 `ask.ts` 改成同一注入形态。）
1. 前置校验按 `design.md` §4.2 的**四条顺序**，任一失败即返回拒绝原因列表（**不弹窗**）。
2. **读数用一次**：`spawnSync("python3", [taskPy, "gate-info", slug])` 解析 JSON，
   同时拿 `plan_hash`（用于写入）与 `questions_answered`（用于前置④）。
   **禁止**在 TS 里内联 sha256 拼装（`design.md` ADR-1），**也禁止**在 TS 里自己数
   `questions.jsonl`（`design.md` §3.3 的设计修正）。解释器与 `task.py` 路径解析与既有代码/测试保持一致。
3. `await ctx.ui.confirm(...)`，标题与正文给出 plan 文件清单 + 哈希前 12 位。
4. 同意 → 写 `approval.json`（`approved_by: "ui-confirm"`）→ 返回 `{ approved: true, plan_hash }`。
5. 拒绝 / 无 UI → **不写任何文件**；无 UI 返回 `instruction`（让人类跑 `task.py approve`）。
6. 子代理 → 拒绝（用注入进来的 `isSubAgent`）。
7. 测试：`tests/plan-approval-tool.test.ts`，见 §3 的 B-1…B-7。
   `B-4` 必须**显式断言** `approval.json.plan_hash` 与 `python3 task.py plan-hash <slug>` 的输出逐字相等。

### B4 — 接线（含**循环依赖修正**）

0. **先修 `ask.ts` 的循环依赖**（B2 遗留）：删掉 `import { detectAgentType } from "./index.ts"`，
   改为与 `approval.ts` 相同的**注入**形态；同步更新 `tests/ask-user.test.ts` 的 `A-5`
   （由「设 `MYFLOW_AGENT_TYPE`」改为「注入 `isSubAgent: true`」）。
   理由：`subagent.ts` 的既有范式就是不 import `index.ts`；循环依赖虽在 ESM 下可用但很脆。
0b. **完成后重新确认导入图无环**（`ask.ts`/`approval.ts` 均不得出现 `from "./index.ts"`）。
1. `index.ts`：在 `registerMyflowSubagent(...)` 附近调用两个新注册函数，**并传入**
   `deriveContextKey` 与 `isSubAgent`（与既有 `registerMyflowSubagent` 同款）；
   漏传会导致工具解析不到活动任务（非 TUI 会话）。
2. `index.ts` 的 `tool_call` 钩子：加子代理守卫（`design.md` §6），
   位置紧邻既有递归守卫，保持同一形态与文案风格。
3. `index.ts` 顶部常量：`ASK_TOOL_NAMES = new Set(["myflow_ask_user", "myflow_request_approval"])`。
4. `status.ts`：`/myflow-status` 增加一行批准态（`approved` / `stale (<旧哈希前8位>→<新哈希前8位>)` / `missing`）。
   该处**只读**，不写文件、不弹窗。
5. `pi-coding-agent.d.ts`：仅在缺少所需类型时新增字段（`ui.select`/`ui.confirm`/`hasUI` **已存在**，不要重复声明）。
6. 测试：补充到 `tests/extension.test.ts` 或新文件，见 §3 的 G-1…G-3。

### B5 — 契约副本同步（**最容易漏的一批**）

按 `design.md` §6 与 `README`/skill 的既有规则，一处规则改动必须同步所有副本：

| 文件 | 要改什么 |
| --- | --- |
| `.myflow/workflow.md` | Step 1.1（规划期必须用 `myflow_ask_user`）、Step 1.4（Activate：先批准再 `start`）、`Task Artifacts` 增加 `approval.json` / `questions.jsonl`、`Dispatch Protocol` 如需提及 |
| `.myflow/spec/harness/index.md` | 新增 Contracts 条目（`questions.jsonl`、`approval.json`、plan hash、门的语义）、Pre-Development Checklist 加一条、Quality Check 加一条、**并写明「本门是约定强化，非权限边界」**（`design.md` §8） |
| `.pi/skills/myflow-brainstorm/SKILL.md` | 把「一次问一个问题」升级为「用 `myflow_ask_user` 提问」，并把「出 plan 后必须 `myflow_request_approval`，批准后 `start`」写进流程 |
| `.pi/skills/myflow-meta/references/harness-conventions.md` | 工具清单加两个新工具；**只改本次新增项**（hook 计数漂移属横评 `DOC-DRIFT-01`，见评审项 R-3） |
| `.pi/prompts/myflow-continue.md` | 若其中复述 Step 1.4，则同步批准门；否则明确记录「无需修改」 |

**验收**：用 grep 确认没有第二处仍在描述「不需要批准即可 start」的语句。

### B6 — 端到端与全量回归

1. 端到端（新 `tests/plan-approval-e2e.test.ts`，用临时工程 + 桩 UI）：
   `ask → 写 plan → request_approval → approve → start` 一路通过；
   以及改一个 plan 文件后 `start` 变红。
2. 全量：§0 的固定命令，**必须 215 + 新增用例全部通过**。
3. 报告实际字节数：`implement.jsonl` / `check.jsonl` + 三份 artifact 的**含开销实算**总量（写作断言，防 `DV-7` 重演）。

---

## 3. 测试清单（每条都要「回退即红」）

### Python 侧（B1）
| ID | 用例 | 回退即红的样子 |
| --- | --- | --- |
| `P-1` | `plan-hash` 对同一 plan 稳定，且对只改一字节的 plan 变化 | 哈希变成常量或不敏感 |
| `P-2` | `plan-hash` 缺 `design.md`/`implement.md` 时只算存在的文件，且顺序不影响结果**只体现在固定清单**上 | 用目录遍历顺序 → 结果抖动 |
| `P-3` | `approve` 在 `questions.jsonl` 不存在 / 全是 `via:"none"` 时**拒绝** | 去掉计数校验 |
| `P-4` | `approve` 在 `stdin` 非 tty 时**拒绝** | 去掉 `isatty` |
| `P-5` | `approve` 成功后 `approval.json` 字段齐全（含 `plan_hash` = `plan-hash` 输出） | 少写 `plan_hash` |
| `P-6` | `start` 无 `approval.json` → 非零退出 + 提示 | 去掉第二个门 |
| `P-7` | `start` 在批准后改 plan → 非零退出（`stale`） | 只查文件存在不查哈希 |
| `P-8` | `start --allow-unapproved` → 成功且 `task.json` 有 `started_without_approval: true` | 静默放行不留痕 |
| `P-9` | `validate` 报告批准态与已作答计数 | 不报告 |
| `P-10` | `gate-info` 输出 JSON 字段齐全，且 `plan_hash` 与 `plan-hash` **逐字相等**（B3 新增） | 自己另算一份哈希 → 断言不等 |
| `P-11` | `questions_answered==0` + 合法 `approval.json` → `start` **仍拒绝**；加 `--allow-unapproved` 放行（B3 的 R2 兑底） | 删掉兑底 → 非法场景放行 |

### 提问工具（B2）
| ID | 用例 |
| --- | --- |
| `A-1` | 有桩 UI 返回选中项 → `{answer, via:"ui-select"}`，且 `questions.jsonl` 追加一行 |
| `A-2` | 桩 UI 返回 `undefined` → `{answer:null, via:"cancelled"}` |
| `A-3` | `ctx.hasUI=false` → `via:"no-ui"` + `instruction` 非空 + **`answer` 必须为 `null`**（防伪造） |
| `A-4` | `options` 长度 1 或 5 → 拒绝且**不调用 UI**（桩记录调用次数为 0） |
| `A-5` | `detectAgentType()` 非空（子代理）→ 拒绝且不写 `questions.jsonl` |
| `A-6` | `questions.jsonl` 存在坏行时解析不抛错，仅跳过 |

### 批准工具（B3）
| ID | 用例 |
| --- | --- |
| `B-1` | 无活动任务 → 拒绝，不弹窗 |
| `B-2` | 有任务但无 `prd.md` → 拒绝，不弹窗 |
| `B-3` | `questions.jsonl` 无已作答行 → 拒绝，**不弹窗**（桩 confirm 调用次数 0） |
| `B-4` | 四条前置齐备 + 桩 confirm 返回 true → 写 `approval.json` 且 `plan_hash` 等于 `task.py plan-hash` 输出（**跨侧一致性**） |
| `B-5` | 桩 confirm 返回 false → **不写文件** |
| `B-6` | `ctx.hasUI=false` → 不写文件，返回 `instruction` |
| `B-7` | 子代理 → 拒绝 |

### 接线（B4）
| ID | 用例 |
| --- | --- |
| `G-1` | 子代理调 `myflow_ask_user` → `tool_call` 返回 `block: true` |
| `G-2` | 子代理调 `myflow_request_approval` → 同上 |
| `G-3` | `/myflow-status` 在三种批准态下输出正确（missing / stale 带新旧哈希 / approved） |
| `G-4` | 既有递归守卫与 `writesUnder` 守卫**未被破坏**（跑既有用例即可，但必须显式确认这两组仍绿） |

---

## 4. 完成判据（PRD AC ↔ 落点）

| PRD AC | 落在哪 |
| --- | --- |
| TUI 下先弹选择题 | `A-1`/`A-4` + `B5` 的 brainstorm 技能文本 |
| 没问过就请求批准 → 拒绝 | `B-3`、`P-3` |
| 未批准 `start` 非零退出 | `P-6` |
| 批准与 plan 内容绑定 | `P-7`、`B-4` |
| 非 TUI 不伪造同意 | `A-3`、`B-6` |
| 子代理不能调用 | `G-1`、`G-2`、`A-5`、`B-7` |
| 哈希只有一份实现 | `B-4`（跨侧一致）+ 评审时 grep 确认 TS 无内联哈希 |
| 回退即红 | §3 每条的「回退即红的样子」列，评审时逐条验证 |
| 契约副本同步 | `B5` 清单 + grep 复核 |
| 不削弱 `ADV-01` | `G-4` |

---

## 5. Dispatch 模板

```
Active task: .myflow/tasks/plan-approval-gate

本次批次：<B1..B6>
目标：<一句话>

必读：
- .myflow/tasks/plan-approval-gate/design.md   （契约；§1 强制层级表、§3 数据契约、§4 工具规格、§5 门、§6 守卫、§8 威胁模型）
- .myflow/tasks/plan-approval-gate/prd.md
- 相关现有代码：<按批给具体文件>

产出：<按批给具体文件>
禁止：写 ../critic_doc/；改 research/；改本任务三份 artifact（发现问题请报告，由主会话决定）
禁止：在 TS 里内联任何 plan 哈希实现（design.md ADR-1）
禁止：削弱 .pi/extensions/myflow/index.ts 既有递归守卫与 writesUnder 路径守卫
```

---

## 6. 评审项（**用户已全部裁定**）

| # | 事项 | 用户裁定 | 对计划的影响 |
| --- | --- | --- | --- |
| `R-1` | 是否建 `.myflow/worktree.yaml` 让 check 门真跑测试 | **不建** | `B6` 的验证靠 §0 的固定测试命令 + §3 清单；**不新增配置文件** |
| `R-2` | `--allow-unapproved` 是否保留 | **保留**（同 ADR-5） | `B1` 第 3 项照做：警告 + `task.json` 记 `started_without_approval: true` |
| `R-3` | 顺手修 `harness-conventions.md` 的 hook 计数漂移？ | **不用** | `B5` 只加两个新工具到清单，**不动 hook 计数**（横评 `DOC-DRIFT-01` 留给独立任务） |
| `R-4` | `questions.jsonl` 是否纳入注入源 | **不用** | 注入面不变；问答内容靠 `prd.md` 承载 |
| `R-5` | 工具命名 | **同建议** | `myflow_ask_user` / `myflow_request_approval` |

**已获批准，可以 `task.py start`。**

---

## 7. 回退与失败处理

| 情形 | 处理 |
| --- | --- |
| 某批超 15 分钟被截断 | 读 `.myflow/.runtime/subagent-logs/` 的日志，拆小重派；**不重做已完成部分** |
| 测试回归（既有 215 条有红） | 停下报告，不要为了让新用例通过而改既有断言 |
| 发现设计本身有误（如 `ctx.ui.select` 在工具处理器里不可用） | **停止实现**，回 Phase 1 修订 `design.md`，并记录该发现（这正是「先核实再用」的用途） |
| 需要新的 Pi 能力（例如真正的多选） | 记为已知限制（ADR-6），不在本任务内绕过 Pi |
| 注入被截断（出现 `[myflow: context limit reached …]`） | 按横评 `DV-1` 的降级顺序处理，并**用含开销实算**复核 |
