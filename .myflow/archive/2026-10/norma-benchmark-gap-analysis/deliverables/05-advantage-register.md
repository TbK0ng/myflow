# 05 — 相对优势登记册（`ADV-*`）

> **版本锚点**：myflow@`0a702fa`、Norma@`52f17dd`、Pi **1.2.0**（`E0`/`E1`/`E2`，见 `research/00-baseline.md`）。
> **判定规则**：`design.md` §5.2（`V-ADV` 定义：myflow 有 ∧ Norma 无，标**不可回退**）、§4（强制层级/回归轴）、§8.6（条目模板）、§2.2（归属域）。
> **取材**：`research/contract-risks-and-advantages.md`（T3，`ADV-01..05`）、`02-matrix.md` 表 B 的 4 条 `V-ADV`（`OBS-01/02`、`TEST-01/02`）、
> 各域分片的「Norma 有、myflow 另法解决」一节（S1/S3/S7/S8）。**已去重**，同一优势不写两条。
> **路径前缀**同 `04-risk-register.md`。本文件不引入 12 个分片、`02-matrix.md`、`03-gap-register.md` 之外的新结论。
> **加星（★）** = 不可回退项，共 **6** 条（`ADV-01`..`ADV-04`、`ADV-06`、`ADV-08`）。

---

## 0. 计数总览

| 指标 | 数量 |
| --- | --- |
| `ADV-*` 总数 | **10** |
| 标记不可回退（★） | **6** |
| 有回归护栏（`R-T`） | **9** |
| 当前无护栏（`R-∅`） | **1**（`ADV-07`，已给补护栏建议） |

**与 `02-matrix.md` 表 B 的 `V-ADV`（4 条）对账**：`OBS-01`→`ADV-05`、`OBS-02`→`ADV-02`、`TEST-01`→`ADV-08`、`TEST-02`→`ADV-09`（全部覆盖）。
剩余 6 条源自 T3 与各域分片的「另法解决」清单。**与 `03-gap-register.md` 无重复计数**：`ADV-*` 是 `V-ADV`（不补），不在缺口册中。

---

## 1. 条目

### ★ ADV-01 有界写者才可并行 + 路径级 fail-closed 写范围门

- **myflow 机制**：
  `parallel` 模式下可写且未声明 `writesUnder` 的 agent → orchestration **抛错拒绝**（`sb:636-647`，B3 已复核）；
  子进程内 `tool_call` 对声明了 `writesUnder` 的 agent 做**路径级**守卫，`..` / 绝对路径 / 空白声明一律 **fail-closed**（`ag:42-56`、`sb:452-453`、`ix:434-451`）。
  证据：`subagent.ts:630-648`、`index.ts:420-451`、`agents.ts:42-56`。
- **强制层级**：`E-C[myflow]`（会拒绝的代码路径：orchestration `throw` + `tool_call` 返回 `{block:true}`）。**回归**：`R-T`
  （`tests/subagent.test.ts:308`（无界写者并行被拒）、`:334`（声明作用域可并行）、`:456`（作用域内只写）、`:525`/`:554`/`:581`（无任务 / 空白 / 逃逸作用域 fail-closed））。
- **Norma 对照**：Norma `tool` 包**无**「按 agent 声明限制写入路径」的对应能力。
  `(NEG)` 语料 `../Norma/**/*.go` 全仓，检索式 `writesUnder|WriteScope|allowedPath|AllowedPath`，命中 **0**；
  `RunParallel` 仅信号量限流（`coordinator/coordinator.go:112-116`）。属**设计缺失**，非取舍。
- **不可回退理由**：回退即两个 agent 共写同一工作树，而工作树是**唯一交付边界**；一旦并行写者互踩，任务产物不可恢复。
- **回退护栏**：`tests/subagent.test.ts:308,334,456,525,554,581`（删任一即失败）+ `.myflow/workflow.md` 的并行条款；
  `tests/skills-hygiene.test.ts:120-131` 锁定 agent 三件套 frontmatter 契约。

### ★ ADV-02 派发上限 + 逐 run 可回溯日志

- **myflow 机制**：`MAX_PARALLEL_PROMPTS=6`（`sb:57,633`）+ 单次 dispatch 墙钟上限 `SUBAGENT_TIMEOUT_MS=900_000`（`sb:64,655`）
  + 每 run 落**原始 stdout/stderr 日志**（`sb:64,439-443`，`SUBAGENT_LOG_DIR=.myflow/.runtime/subagent-logs`）；
  超时 `killChildTree` → 回报 cap / 日志路径 / `exitCode 124`（`sb:286-310,473-484`）。
- **强制层级**：`E-C[myflow]`。**回归**：`R-T`（`tests/subagent.test.ts:208`（超限被停、被回报、被记录）、`:269`（上限内不受影响））。
- **Norma 对照**：Norma 有 run 内预算与收尾（`harness/query.go:110,531-543`），但**无父侧取消、无逐 run 命名日志**；
  其缺口正好对应 myflow 的 `GAP-LOOP-06`（结算缺席）。即「各有半边」——myflow 的日志与取消是 Norma 没有的边。
- **不可回退理由**：日志是超时/失败后**唯一可复核的证据**；删掉它，长任务失败将不可诊断。
- **回退护栏**：`tests/subagent.test.ts:208-252`、`:269`。

### ★ ADV-03 注入预算显式降级（拒绝静默丢弃）

- **myflow 机制**：三级字节上限（单文件 32 KiB / 单 artifact 64 KiB / 合计 128 KiB，`ci:20-26`）+
  截断标记 + 汇总「context limit reached」提示（`ci:148-176,250`）+ 项目外引用拒收（`ci:386-394,492-493`）。
- **强制层级**：`E-C[myflow]`。**回归**：`R-T`（`tests/context-injection.test.ts:131,142,226,443`）+ `implement.md` §6 的预算算术。
- **Norma 对照**：Norma 以**压缩分层**（`noa`）处理同一上下文压力，无对应「omitted 提示」——是**路线差异**（Norma 压，myflow 显式降级）。
- **不可回退理由**：静默截断会让子代理误以为「已读全」，从而在缺失证据上作出断言（本任务本身就是对该风险的反向验证）。
- **回退护栏**：`tests/context-injection.test.ts` 的预算用例；`02-matrix.md`/本册对预算算术的引用。

### ★ ADV-04 递归守卫是代码 + research 工具白名单

- **myflow 机制**：`myflow-research` 工具白名单**无 `bash`**（`.pi/agents/myflow-research.md:5`）
  + `tool_call` 对子代理调用 `myflow_subagent` **直接 block**（`ix:420-432`）
  + agent frontmatter `tools:` 经 `--tools` 交 Pi 硬门控（`sb:403`）。**三层**：`E-C[myflow]` + `E-G[myflow→Pi]` + `E-P[myflow]`（文字说明）。
- **强制层级**：`E-C[myflow]`（`{block:true}`）。**回归**：`R-T`（`tests/subagent.test.ts:427,434-454`（主会话放行 / 子代理被拒）、`tests/skills-hygiene.test.ts:133`）。
- **Norma 对照**：Norma 的 `MaxDepth` 代码守卫强度相同（`subagent/subagent.go:84`，测试 `subagent_test.go:61-71`）——
  **非优势差距**，但 myflow 的**三层叠加**高于 Norma 的单层代码守卫，故仍登记（且不可回退）。
- **不可回退理由**：递归派发会指数放大 token 消耗与写冲突；`PRD Q3` 曾误判其为「仅提示词」，实证为 `E-C`（`02-matrix.md §5.2 C-8`），删之会**静默**恢复自旋能力。
- **回退护栏**：上述两个测试；`harness-conventions.md` 的「keep both」条款。

### ADV-05 `/myflow-status` 无模型调用的状态可观测 + escape hatch

- **myflow 机制**：`/myflow-status` 无模型调用，输出 phase / task / git / next + `phaseBlockFound`（暴露 workflow 漂移）（`ix:254-271`、`st:69-115`）；
  `get_context.py --json` 供脚本消费；跳过关键字 / `MYFLOW_SKIP_BREADCRUMB` 逃生路径（`ix:310-315`、`escape-hatch.ts`）。
- **强制层级**：`E-C[myflow]`。**回归**：`R-T`（`tests/status.test.ts:31`、`tests/escape-hatch.test.ts`、`tests/extension.test.ts:172`）。
- **Norma 对照**：Norma **无工作流状态概念**可观测（`research/norma-plan-mem.md` 无对应目录；`OBS` 域为跨切面域）。属**设计缺失**。
- **不可回退理由**：在无 UI、无模型调用的前提下定位「阶段漂移」，是长会话排障的最低成本手段；删之则漂移只能靠人读 `workflow.md`。
- **回退护栏**：`tests/status.test.ts`、`tests/escape-hatch.test.ts`。

### ★ ADV-06 channel durable JSONL 子代理间通信

- **myflow 机制**：channel 运行时提供 **durable JSONL 事件日志** + `send` / `messages` / `wait --kind done` / `interrupt`，
  支持 peer worker 异步协作与中断（`channel.py:466-485`；`.pi/skills/myflow-channel/SKILL.md:41-46`）。
- **强制层级**：`E-C[myflow]`（并发/单写者守卫 `channel.py:506-523` 返回 1）。**回归**：`R-T`（`tests/channel.test.ts:179`）。
- **Norma 对照**：Norma 子代理**只回一段最终文本**（`subagent/subagent.go:88-95`），**无子代理间通信**。属**设计缺失**（其 `coordinator` 只做扇出，不做对等通信）。
- **不可回退理由**：长任务需要「两个代理来回讨论 / 中途纠偏 / 打断卡住的 worker」；删掉 channel 即退回「一次性派发-回传」的最弱协作模型。
- **回退护栏**：`tests/channel.test.ts`（并发上限与单 reviewer）；`myflow-channel/SKILL.md` 的接口契约。

### ADV-07 git 版本控制的 spec + skill 知识持久化

- **myflow 机制**：`.myflow/spec/` 与 `.pi/skills/` 作为**受版本控制**的持久知识，可 diff / 回滚 / 与代码同版本 / 可测试；
  明确定位「Specs are authoritative over memory」（`.pi/skills/myflow-before-dev/SKILL.md:61`）。
- **强制层级**：`E-P[myflow]`（spec 约定为主）+ 部分 `E-C[myflow]`（`tests/skills-hygiene.test.ts` 锁定 SKILL.md 结构）。
  **回归**：`R-∅`——**当前无**针对 `.myflow/spec/` 的专门回归护栏（`spec/index.md` 为人工维护，`03-gap-register.md` 的 `QGAP-MEM-02` 已登记该漂移风险）。
- **Norma 对照**：Norma `memory` 是 **agent 自动累积**、不版本控制、带相关度召回与陈旧告警（`memory/*.go`）；
  myflow **有意**选 spec 路线（团队共享、可 review、与代码同版本）。是**路线取舍**，非单纯缺失——但「自动累积/召回」的缺失已记为 `GAP-MEM-03/04`。
- **不可回退理由**：spec 的可 diff / 可回滚 / 可测试是 myflow 全部「契约沉淀」能力的地基；回退为 memory 工具会失去版本控制与团队共享。
- **回退护栏**：**当前无专用护栏**。补护栏建议：新增 `tests/spec-hygiene.test.ts`
  （① `spec/index.md` 与 `.myflow/spec/**/*.md` 实际集合一致；② 每个 spec 文件有约定抬头），并可挂到 `worktree.py verify`——
  该建议与 `QGAP-MEM-01`/`QGAP-MEM-02` 的补足标准同源，不重复实现。

### ★ ADV-08 verify gate（含 channel review worker）

- **myflow 机制**：`agent_before_settle` 门控 `myflow-check` 子代理直到配置的 verify 命令通过，**有界重试** `MAX_VERIFY_ATTEMPTS`（`ix:464-500`）；
  `channel.py:566-569` 把**非子代理**的 channel review worker 也纳入同一门（`MYFLOW_VERIFY_GATE=1`）。
  「一关注点两路强制」——同一门覆盖两条派发通道。
- **强制层级**：`E-C[myflow]`（`{continue:true}` + 有界）。**回归**：`R-T`（`tests/extension.test.ts:285,318,356`（通过 / review worker / 有界且仅对 check）、`tests/worktree.test.ts:130`）。
- **Norma 对照**：Norma **无等价 verify 门**（`research/myflow-enforcement-tiers.md §5`）。属**设计缺失**。
- **不可回退理由**：「检查者不通过验证就不收工」是 harness 质量的核心；且它同时覆盖子代理与 peer worker 两条路径，回退会留下检查漏洞。
- **回退护栏**：`tests/extension.test.ts:285,318,356`、`tests/worktree.test.ts:130`。

### ADV-09 harness 自身回归 + 把文档契约钉成测试

- **myflow 机制**：17 个测试文件覆盖 extension / subagent / context-injection / turn-cache / task-gate / task-bridge /
  workflow-invariant / skills-hygiene / worktree / channel / status / mvp 等；
  其中 `tests/workflow-invariant.test.ts:71` 把**文档契约**钉成测试（`workflow.md` 的 Phase/Step 声明 ↔ 代码双向对齐）；
  `tests/skills-hygiene.test.ts:29-65` 锁定 8 个 `SKILL.md` 的 frontmatter 结构，**强于 Pi**（Pi 对坏 skill 只警告，`docs/skills.md:85`）。
- **强制层级**：`E-C[myflow]`。**回归**：`R-T`（`tests/workflow-invariant.test.ts:71`、`tests/skills-hygiene.test.ts:29`）。
- **Norma 对照**：Norma 有 98 个 `*_test.go` 覆盖代码，但**无**「把文档契约钉成测试」的等价实践。属**设计缺失**。
- **不可回退理由**：把**提示词文本**也纳入回归（`wit:71` 证明可行），是防止“文档与代码静默漂移”的最低成本路径——本册 `DOC-DRIFT-01` 正是缺此护栏的实例。
- **回退护栏**：`tests/workflow-invariant.test.ts:71`、`tests/skills-hygiene.test.ts:29`。

### ADV-10 任务生命周期状态机（`workflow.md` + `task.py` 可脚本查询）

- **myflow 机制**：`.myflow/workflow.md` 是状态机**单一事实源**（3 Phase / 10 Step）；`task.py` 提供可脚本查询的当前任务 / 阶段
  （`task.py:13-17` 的命令面；`task.py current`）；替代 Norma 的 `TodoWrite`。
- **强制层级**：`E-C[myflow]`（`task.py` 的越界/空 jsonl 返回非零，`task.py:444-448,493-508`）+ `E-P[myflow]`（阶段顺序文字）。
  **回归**：`R-T`（`tests/task-gate.test.ts:81`、`tests/task-bridge.test.ts`）。
- **Norma 对照**：Norma `tool/todo.go` 的 `TodoWrite` 是**模型维护的待办**，非持久状态机，也无脚本查询面。属**设计缺失**（Norma 无工作流概念）。
- **不可回退理由**：阶段状态是「注入的阶段约束」与「门禁」的共同基础；回退为模型自维护待办会失去可脚本查询与门禁可比对的对象。
- **回退护栏**：`tests/task-gate.test.ts`、`tests/task-bridge.test.ts`、`tests/workflow-invariant.test.ts:71`。

---

## 2. 优势 ↔ 缺口的关系（补足时**不得**牺牲的既得行为）

> 用途：`03-gap-register.md` 的每个 `GAP-*`/`QGAP-*` 在实现时需对照本节，避免「补一个洞、砸一个优势」。

| 缺口 | 不得牺牲的优势 | 约束 |
| --- | --- | --- |
| `GAP-PERM-01..05`（权限三态 / mode / deny 优先 / 四阶段 / 中途翻转） | ★ `ADV-01`（路径级 fail-closed 写范围门） | 新的规则表 / mode 状态机必须**内嵌**而非**替换**现有 `writesUnder` 路径守卫；`ix:420-452` 的 `{block:true}` 路径不得被削弱为可选步骤 |
| `GAP-PLAN-01`（只读探索阶段代码强制） | ★ `ADV-04`（递归守卫三层） | 只读门应**复用** `tool_call` `{block:true}` 的既有模式，而非退回提示词；且不得放宽 `myflow-research` 的 `tools:` 白名单 |
| `GAP-PLAN-02`（审批门升级） | ★ `ADV-08`（verify gate） | 新增的「已批准」字段必须与 verify 门**并存**，不能以「有审批就免验证」替代 |
| `GAP-TOOL-06`（工具输出上限 / 全局 net） | ★ `ADV-02`（逐 run 日志） | 截断 `myflow_subagent` 结果时**必须**保留并回报 `logPath`（`sb:286-310` 既有机制）；截断不得导致日志丢失 |
| `GAP-LOOP-06`（主会话预算 + 结算） | ★ `ADV-02`（墙钟上限 + kill 树）+ ★ `ADV-08`（verify 门） | 结算步骤与 900s 超时**并存**；结算不得取消 `killChildTree` 与 verify 门的有界重试 |
| `GAP-CTX-04`（键-指针一致性） | `ADV-05`（escape hatch） | 新增告警/自愈必须**保留** `MYFLOW_SKIP_BREADCRUMB` 与跳过关键字逃生路径（`ix:310-315`） |
| `QGAP-CMPT-05`（注入存活时序） | ★ `ADV-03`（注入预算显式降级） | 去掉事件时序依赖时**不得**改成「无条件全量注入」，否则会绕过预算降级 |
| `QGAP-COORD-02`（信号量限流） | ★ `ADV-01`（有界写者才可并行） | 引入信号量不得放宽「无界写者并行即拒绝」；限流是**第二层**，不替代写者闸门 |
| `GAP-SKILL-04`（skill→MCP 解锁） | `ADV-01`（写范围门）+ `RISK-04` 的低耦合 | 解锁动作必须**收窄到声明集合**；且如 §A-EXT 依赖所述，会新增 `A-EXT:pi-mcp-adapter` 核心依赖，须在 `04-risk-register.md` 重新评估 |
| `GAP-NOA-01..09` / `GAP-NOAA-03..07`（ref/tier/保护/紧急截断/账本） | ★ `ADV-03`（预算降级）+ `ADV-09`（回归护栏） | 新增的分层压缩 / 保护 / 截断层必须有独立测试（`R-T`），不得以「不改原文」掩盖「改变模型可见上下文」的语义 |

---

## 3. 需新证据 / 未完成

**需新证据：无。** 本册全部条目与护栏均可回溯到 `research/contract-risks-and-advantages.md`、`02-matrix.md` 表 B 与各域分片；
唯一新增内容是对既有条目按 `design.md` §8.6 模板补全**不可回退理由**与**回退护栏**字段（属格式补全，非新结论）。

**未完成：无。** `ADV-01..10` 均写全五字段；不可回退 6 条 ≥ PRD 要求的 3 条；`ADV-07` 的 `R-∅` 已显式声明并给补护栏建议。
