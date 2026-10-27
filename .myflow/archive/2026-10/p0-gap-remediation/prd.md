# 补足 4 条 P0 缺口（相对 Pi 参照系）

## Goal

把审计找出的 **4 条 P0 缺口**在 myflow 内补上。**规格以父任务的 `p0-summary.md` 为准**，本文件只补决策、顺序与验收标准。

## 规格来源

4 条 P0 的机制、失效模式与补法要点是本任务的权威输入；落地后的稳定契约见 `.myflow/spec/harness/index.md`。

## 用户已定的决策

- **`P0-3` 采用「注入」**：把 `design.md` / `implement.md` 加入注入链（与 `prd.md` 同等待遇，受 `max_artifact_bytes` 约束），**不是**改成「子代理自行 read」。
- `info.md` 是 myflow 自有的注入面，**保留**。

## Work items（4 条，各自独立可验收，顺序 = 由易到硬）

> 每条一个 commit。每条都要有「回退即红」的测试。

### W1 `P0-2` 面包屑不变式回归测试

- **目标**：新增一条测试，把 `.myflow/workflow.md` 里每个 `[required · once]` 步骤与其所在 phase 的 `[workflow-state:*]` 块绑定：**每个必做步骤必须在其 phase 块里出现对应执行行**。
- **对齐语义**：以 `workflow.md` 里 `WORKFLOW-STATE BREADCRUMB CONTRACT` 注释的文本为准。
- **陷阱**：`tests/skills-hygiene.test.ts:226` 的 `required` 数组是 **payload 完整性清单**，不是这个不变式——别复用/混淆。
- **口径**：myflow 现 4 个 state 块**内容上已满足**该不变式 → 本条是**护栏**，测试应当**当前通过**；它的价值是「以后改 workflow.md 时回退即红」。若测试当前就失败，停下来报告，不要为了让测试通过而改 `workflow.md` 的语义。
- **验收**：手动从任一 state 块删掉一个必做步骤的执行行 → 测试必须变红。

### W2 `P0-4` 上下文键包含性校验（**两侧同改**）

- **目标**：`current_task` 指针的解析结果必须落在 `.myflow/tasks/` 内，读写两侧都校验。
- **读侧**：`.pi/extensions/myflow/turn-cache.ts:55`（`resolve(projectRoot, currentTask)`）→ 加包含性 + realpath 校验；不合法时**当作无活动任务**处理（而不是静默 `"stale"`）。
- **写侧**：`.myflow/scripts/task.py` 的指针写入处（`:119-126`、`:108-112`、`:257-258`、`:311`）→ 拒绝 `tasks/` 之外的路径。**中毒源**是 `:108-113` 的 `_relative` 绝对路径回退，须一并处理。
- **要求**：读侧在指针解析后校验包含性（并把越界当「无活动任务」），写侧在指针写入处拒绝 tasks 目录之外的路径。
- **陷阱**：只改读侧的话，中毒指针**仍由 myflow 自己写入** → 必须两侧。
- **顺带自洽**：同一 `buildTaskContext` 里 jsonl 引用文件受 `resolveProjectFile` 检查而 `prd.md`/`info.md` 直读——若要统一，说明取舍，**不要**顺手改掉 `prd.md`/`info.md` 的读取语义。
- **验收**：测试覆盖「`..` 逃逸 / 绝对路径 / 大小写差异」各一条，读侧与写侧各自可独立触发拒绝。

### W3 `P0-1` 任务启动空上下文门禁（⚠️ **不可半搬**）

- **目标**：对齐参考实现的三件套 —— `create` seed 空 `implement.jsonl`/`check.jsonl` → `validate` 把「0 条 curated」判为失败 → **`start` 拒绝**（`--allow-empty-context` 放行）。
- **硬约束**：myflow **没有 jsonl 写入口**（无 `add-context`）。因此：
  - 只加 `start` 门禁会造出**无法满足**的关 → **必须同时给出写入口**（`add-context <task> <action> <file> [reason]`）或明确记录「模型手写 jsonl」为受支持路径。
  - 若选择「模型手写」，`--allow-empty-context` 就是常规逃生口；这一点要写进 `workflow.md` 的 1.3 说明，不能只留在 `--help` 里。
- **别照搬错**：参考实现在**文件不存在时不拦**（`cmd_validate` 对缺失返回 None），只拦「已 seed 但未 curate」。**不要**改成「缺失即拦」，那会让当前所有已存在的任务目录全部无法 `start`。
- **同族修正（`DRIFT-05` 附带）**：`.myflow/scripts/task.py:8` 的 usage 承诺 `task.py finish`，但 `main():395-427` 无该子解析器 → 运行即 argparse `invalid choice`（exit 2）。**二选一**：实现 `finish`（清活动任务、不改 status），或从 usage 里删掉该承诺。**不允许留现状**。
- **验收**：`start` 一个已 seed 但未 curate 的任务 → 非零退出并给出可操作提示；`--allow-empty-context` 可放行；`finish`（或删除后的 usage）实际行为与文档一致。

### W4 `P0-3` 注入 `design.md` / `implement.md`（用户选定「注入」）

- **目标**：`.pi/extensions/myflow/context-injection.ts:437-448` 的注入面从 `prd.md` + `info.md` + jsonl 扩为 `prd.md` + **`design.md`** + **`implement.md`** + `info.md` + jsonl。
- **要求**：`design.md` / `implement.md` 与 `prd.md` 走同一条 artifact 通道。
- **要求**：
  - 与 `prd.md` 同等待遇：受 `max_artifact_bytes`（默认 65536）约束，缺文件时静默跳过（与 `info.md` 的现有行为一致）。
  - **必须验证新增两项后上限仍生效**——不要因为多注入两份文档而让 `max_total_bytes`（默认 131072）静默截断**刻意策展的 jsonl**。
  - 同步 `.myflow/workflow.md` 的 Dispatch Protocol「Read order」段：从「子代理去读」改为与实现一致的表述（现在是代码真的注入了）。
- **不改**：`info.md` 的注入（myflow 自有）；**不做**「预算优先级重排」（把 jsonl 提到 prd 之前）——那是另一条独立发现，未列入这 4 条 P0。
- **验收**：一个带 `design.md`/`implement.md` 的任务，在子代理可见的 `<task-context>` 里能看到这两份的内容；缺文件时不报错；注入总量超限时的降级行为与 `prd.md` 一致。

## Acceptance Criteria

- [ ] W1–W4 各一个独立 commit，commit message 说明改了哪个 P0 与为什么。
- [ ] `node --test tests/` 全绿（**在 main session 跑**，或先清 `MYFLOW_AGENT_TYPE`/`MYFLOW_CONTEXT_ID`/`MYFLOW_SKIP_BREADCRUMB`/`MYFLOW_WRITES_UNDER`）。
- [ ] W1 的不变式测试：删掉任一必做步骤的执行行 → 变红。
- [ ] W2 的包含性校验：读侧与写侧各有可独立触发的拒绝测试（`..` / 绝对路径 / 大小写）。
- [ ] W3：`start` 对「已 seed 未 curate」拒绝且可 `--allow-empty-context` 放行；**文件缺失仍不拦**（与参考实现一致）；`finish` 的 usage 与实现一致。
- [ ] W4：`design.md`/`implement.md` 出现在 `<task-context>` 内；缺文件不报错；总量上限行为与 `prd.md` 一致。
- [ ] 未触碰 `omp/`/`opencode/`/`shared-hooks/` 任何内容。

## Definition of Done

- 每条 P0 的改动范围与 `p0-summary.md` 的「补法要点」一致；任何偏离都要在报告里说明。
- 新引入的契约（如 `add-context` 子命令、`--allow-empty-context`、注入面变更）同步写入 `.myflow/spec/harness/index.md`。
- 工作树在最后必须干净。

## Out of Scope

- 不做 `DRIFT-04`（内容级会话检索）、`DRIFT-05` 的其余 10 项、`DRIFT-08`、`DRIFT-09`、`DRIFT-10`。
- 不做「预算优先级重排」（jsonl 提到 prd 之前）。
- 不改 `omp/`/`opencode/`/`shared-hooks/` 相关任何判定或代码。
- 不重构 myflow 目录结构；不动 `writesUnder` 写者边界（已由 `3c6de58` 完成）。
