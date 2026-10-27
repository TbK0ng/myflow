# 01 — 横评结论（Verdict）

> **来源戳**（发布时由主会话改写为实际值）：
> `myflow@0a702fa`（主会话在发布时替换为实际 HEAD）、`Norma@52f17dd52d95b087265e5d5b306fe85c1ea05599`、`pi 1.2.0`。
> Pi 侧一律以**当前运行本会话的已安装 1.2.0 产物**为准（`C:/Users/wocai/.bun/install/global/node_modules/@earendil-works/*`）。
> **警告**：源码工作区 `Desktop/pi` 为 **1.0.4**，落后于运行中的 1.2.0，**不作为权威依据**（凡以其为据者一律降级为推断）。
> 本文是整份横评的入口，可独立阅读；支撑细节见 `02-matrix.md` 及各登记册。全文中文，术语保留英文原名。

---

## 1. 一段话结论

myflow 相对 Norma 的实况可以概括为三点。**第一，myflow 强在「工作流编排层」而非「引擎层」**：
`SUB` / `COORD` / `OBS` / `TEST` 四个域整体不低于甚至强于 Norma（7 项 `V-OWNED` + 4 项 `V-ADV`），
其有界写者并行、路径级 fail-closed 写范围门、逐 run 可回溯日志、verify 门、durable channel 通信，
构成 **6 条不可回退的相对优势**。**第二，真缺口的主体不是「引擎能力不足」，而是两类别的性质**：
29 项 `V-GAP` 中最集中的是 `NOA`（7）与 `PERM`（5），二者的大多数子项恰是 **Pi 与 myflow 共同空白**（`O-5`，全表 21 项）；
而带 **P0** 的仅 2 项、且都只需 myflow 侧小改动（`GAP-TOOL-06` 结果不截断、`GAP-CTX-04` 指针缺失静默零注入）。
**第三，最大的实际威胁是「静默」性质**：唯一 `R-HARD` 是 `.myflow/.runtime/` 的机器本地性导致子代理静默零 spec 注入，
另有两类半静默失效（压缩吃掉注入的 1 回合窗口、channel peer worker 旁路递归/写范围守卫）。
换言之，myflow 与 Norma 的差距主要不在「有没有」，而在**「是否被代码强制」与「Pi 契约是否稳」**。

---

## 2. 记分卡（19 域逐行）

> 列义：`缺口/质量差` 为该域 `GAP-*` / `QGAP-*` 条数；`主导结论码` 为该域条目最多的 `V-*`；
> 「最强证据或风险」为该域最值得记住的一条。判据见 `02-matrix.md` 表 A/表 B，条目见 `03`/`04`/`05`/`06`。

| # | 域 | 一句话判词 | 主导结论码 | 缺口/质量差 | 最强证据或风险 |
| --- | --- | --- | --- | --- | --- |
| 1 | `LLM` | 全部委托 Pi；唯一空白是 **provider 级限流**（重试 Pi 已给） | `V-PI` | 1 / 0 | 限流无人提供：`docs/settings.md:126-135` 只有 `retry.*`；`GAP-LLM-04` |
| 2 | `TOOL` | 4 项 Pi 已给；2 项真缺：**保守默认**与**跨工具输出 net** | `V-PI` | 2 / 0 | `myflow_subagent` 结果**不截断**（`sb:275-310`）→ `GAP-TOOL-06`（`P0`） |
| 3 | `PERM` | 权限系统整体缺失（三态 / 6 mode / deny 优先 / 四阶段 / 中途翻转） | `V-GAP` | 5 / 0 | 仅单条硬 deny（`writesUnder`）；`docs/security.md:3` 明示内核不逐调用审批（`O-2`） |
| 4 | `LOOP` | 循环委托 Pi；缺消息级读写调度与主会话预算/结算 | `V-UP` / `V-GAP` 混合 | 2 / 0 | Pi 同消息工具**可并行**、不区分 read/write（`docs/extensions.md:124,143-144`）→ `GAP-LOOP-02` |
| 5 | `SUB` | 三项全部 ≥ Norma，**已承担** | `V-OWNED` | 0 / 0 | 递归守卫是 `E-C`+`E-G`+`E-P` 三层（`ix:420-432`、`sb:403`），比 Norma 单层代码守卫更硬 |
| 6 | `COORD` | 有并发上限与保序；缺信号量限流语义与 per-run 结算 | `V-OWNED` | 0 / 1 | `Promise.all` 保序 + `maxItems=6`（`sb:57,673`）；`QGAP-COORD-02` |
| 7 | `CMPT` | Pi 覆盖 3/5；缺 **MicroCompact 层**与**熔断**；注入共存有质量差 | `V-GAP` / `V-PI` | 2 / 1 | `custom_message` 既是合法压缩切点又是上下文（`compaction.md:134`、`session-format.md:178`）→ `QGAP-CMPT-05` |
| 8 | `NOA` | **最大真缺口域**：分层压缩引擎（ref/tier/block/nudge/硬保护/紧急截断）全空 | `V-GAP` | 7 / 0 | Pi 无命名硬保护名单、无紧急截断**触发判定**（但已给 `session_before_compact` 自选边界与 `context_edit` 原语）→ `GAP-NOA-07/08`（`P1`） |
| 9 | `NOAA` | 4 项 Pi 已给；缺子代理账本继承 / 溢出学习窗 / ref tag | `V-PI` | 3 / 0 | `DeriveChildState` 上溯 ≤8、重置节律（`inherit.go:47-108`）；myflow 仅继承任务指针（`sb:446`） |
| 10 | `TRANS` | 3 项 Pi 已给；缺子代理 sidechain 分离 | `V-PI` | 1 / 0 | myflow 只有原始 stdout 日志（`sb:67`），无结构化 sidechain / token 分离 |
| 11 | `CORE` | 4 项全部 Pi 已给 | `V-PI` | 0 / 0 | `SessionManager` / `--mode json -p` / `--continue`（`docs/sdk.md:44-52`、`docs/sessions.md:10-14`） |
| 12 | `HOOK` | 4 项全部 Pi 已给，myflow 注册 7 个事件且可 block/改写 | `V-PI` | 0 / 0 | Pi `pi.on()` **41** 事件（C1 更正原记 42）；myflow 的 verify 门用它做 `continue:true`（`ix:464-500`） |
| 13 | `MCP` | 本环境 MCP 由 `A-EXT:pi-mcp-adapter` 接管（内建被 `-builtin:mcp` 关闭） | `V-EXT` | 0 / 0 | **MIS-02**：极易误记为 `A-PI`；卸载该扩展则 MCP 全无 |
| 14 | `SKILL` | 加载/按需注入 Pi 已给；缺 **压缩后正文重放**与 **skill→MCP 解锁** | `V-PI` | 2 / 0 | roster 经 system checkpoint 存活于压缩（`session-format.md:248`），但**正文**无逐字 re-inject、摘要时截 2000 字符（`compaction.md:291`） |
| 15 | `PLAN` | 只读探索**无代码强制**（`V-GAP`）；审批门有代码门但位置偏后（`V-QUAL`） | `V-GAP` | 2 / 1 | 只读仅文字（`myflow-brainstorm/SKILL.md:9-13`）；这是「名义有、实际靠约定」实证反例 |
| 16 | `MEM` | 无召回/无陈旧告警（`V-GAP`）；元数据与索引人工维护（`V-QUAL`） | `V-GAP` / `V-QUAL` | 2 / 2 | 模型自行 `cat .myflow/spec/index.md`（`myflow-before-dev/SKILL.md:14,27-29`），无排序无上限 |
| 17 | `CTX` | 状态注入自愈（`V-OWNED`）+ 键派生质量差（`V-QUAL`）+ **指针缺失静默**（`V-GAP`/`P0`） | `V-OWNED` | 1 / 1 | `RISK-03`（`R-HARD`）：`.runtime/` 被 gitignore → 换树即静默零注入 → `GAP-CTX-04` |
| 18 | `OBS` | `/myflow-status` 无模型调用 + 逐 run 日志，Norma 无等价 | `V-ADV` | 0 / 0 | `phaseBlockFound` 暴露 workflow 漂移（`ix:254-271`、`st:69-115`） |
| 19 | `TEST` | verify gate + 把文档契约钉成测试，Norma 无等价 | `V-ADV` | 0 / 0 | `workflow-invariant.test.ts:71` 把提示词文本纳入回归（可复用于升级 `E-P` 条目） |

**合计**：`V-GAP` 29、`V-QUAL` 6、`V-OWNED` 7、`V-PI` 32、`V-EXT` 2、`V-UP` 2、`V-NA` 0、`V-ADV` 4 = **82**。

---

## 3. 十条最重要结论（按重要性排序）

1. **myflow 的价值层是「编排与门禁」，不是「引擎」。**
   `SUB`/`COORD`/`OBS`/`TEST` 全域 ≥ Norma：`myflow_subagent` 带隔离、递归守卫三层、
   逐 run 日志 + 墙钟上限（`sb:57,64,394-431,573`、`ix:420-432`）、verify 门（`ix:464-500`）。
   这些不是「补差项」，而是不可回退项（见 `05-advantage-register.md` 的 6 条 ★）。

2. **真缺口只有 2 项需要立即动手，且都在 myflow 侧、代价小。**
   `GAP-TOOL-06`（`myflow_subagent` 结果无上限，`sb:275-310`）与
   `GAP-CTX-04`（键在而 `.runtime/sessions/<key>.json` 缺失时静默零 spec 注入）。
   两者均满足「状态/数据丢失风险 ∨ 仅 myflow 侧改动且代价小」，故记 `P0`。

3. **缺口最集中的 `NOA`(7) + `PERM`(5) 多为 Pi 与 myflow 的共同空白（`O-5`，全表 21 项），少数为「Pi 给原语、语义待补」（`O-3`）。**
   `NOA` 的分层压缩（ref `mNNNNN` / tier 一次一层 / block 回放 / nudge 节律）与 `PERM` 的三态/mode/deny 优先/四阶段，
 Pi `docs/` 均无对应**求值/调度**能力；但硬保护与紧急截断 Pi 已给原语（`session_before_compact` 自选保留边界、
   `context_edit` 改写发出视图），myflow 缺的是「命名名单 / 压力触发判定」（见 `08-coverage.md` 的 NEG 清单与 `research/c1-neg-recheck.md`）。
   这说明补足成本高、优先级低（多为 `P2`），应作为「增强路线」而非「救火」。

4. **32 项 `V-PI` 证明 myflow 未重复造轮子。**
   表 C §3.3 核查：`V-PI` 的 32 项中 myflow **一律记 `E-N[myflow]`、完全委托 Pi**。
   唯一「部分自建」的是 `CMPT-05`（压缩后重注入）与 `CTX-01`（状态注入），属 `O-3`——Pi 只给原语、语义需 myflow 补齐，
   不构成重复实现。这是对「myflow 是否白造轮子」的正面回答。

5. **归属域误判是本任务最大陷阱：`Agent`/`StopAgent`/`MessageAgent`/`AgentStatus` 既非 Pi core 也非 myflow。**
   它们是 `A-EXT:pi-subagents-lite` v1.17.0 注册的（`registration.ts:66,121,132,143` + `:112,129,140,149`），
   而 `myflow_subagent` 才是 `A-MF`（`sb:573`）。不做域码区分，`CAP-SUB-*` 必然错判——
   这正是本横评增设 `A-EXT` 域码的直接动机（归属域规则见 `07-method.md` §2；见 `06-non-gaps.md` MIS-01）。

6. **唯一 `R-HARD`：`.myflow/.runtime/` 的机器本地性 → 子代理静默零 spec 注入。**
   `.runtime/` 被 gitignore（`.gitignore:5`），`worktree.py create` 只复制 `copy:` 白名单（`:279-289`）且本仓无 `worktree.yaml`；
   换机/新 clone/新 worktree 后扩展判 `no_task`，**无任何「键在而文件缺」告警**，子代理静默失去 spec 语境。
   它与上一轮 P0「空上下文门禁」同成因，是本任务最应优先钉住的风险（`RISK-03`）。

7. **第二类静默风险是「Pi 契约依赖」：压缩事件时序与 channel worker 旁路。**
   `RISK-02`（`R-OK`）——`custom_message` 是合法压缩切点（`compaction.md:134`），
   myflow 靠 `lastInjectionTs > lastCompactionTs` 自愈（`ix:384,455-457`），最坏有 1 回合失败窗口；
 Pi 一旦改切点规则或事件时序即**静默**失效。
   `RISK-06`（`R-SOFT`）——`channel.py` 启动 peer worker 时不设 `MYFLOW_AGENT_TYPE`，
   使 `ix:241` 判 `isSubAgent=false`，递归守卫与 `writesUnder` 路径守卫对其**旁路**。

8. **「名义有、实际靠约定」的实证反例不是递归守卫，而是 `PLAN-01` / `MEM-03` / `MEM-02`。**
   PRD `Q3` 原将递归守卫判为提示词，实证为 `E-C[myflow]` + `E-G[myflow→Pi]`（`02-matrix.md` 裁定 `C-8`）。
   真正只靠 `E-P` 的是：只读探索（`myflow-brainstorm/SKILL.md:9-13`）、
   召回（`myflow-before-dev/SKILL.md:14,27-29`）、索引（`myflow-update-spec/SKILL.md:50` 人工步骤）。
   按 `R-STR-3`，这三处**不得**记为已覆盖。

9. **`O-2`（刻意外包）的唯一权威原文在包根 `README.md:19`，不在 `docs/`。**
 Pi 1.2.0 `docs/` 40 篇**无** sub-agent / plan mode 的语义表述（`08-coverage.md` NEG 清单）；
   「skips features like sub-agents and plan mode」只出现在包根 `README.md:19`。
   这是 docs 的覆盖缺口，也是 `SUB`/`COORD`/`PLAN` 判 `O-2` 而非 `O-5` 的唯一依据（`06-non-gaps.md` MIS-06）。

10. **本任务是「重做并升级」，不是「续做」。**
    上一轮审计的分析产物不可恢复（`4dd6f7d` 无 `p0-summary.md`、无 `research/`），只留下 4 条 P0 修复。
    本次把语料从 README 13 包扩到 **16 个实现包**（+`noa` 5392 行 / `noaadapter` 1918 行 / `transcript` 268 行，
    约占全仓非测试代码 20%），新增 `NOA`/`NOAA`/`TRANS` 三域——
    没有这一步，最该对照的 `CTX` 域会被**系统性跳过**（`06-non-gaps.md` MIS-07）。

---

## 4. 必补清单 / 不补清单

### 4.1 必补（`P0` + `P0-R` + `P1`，共 8 条）

> 「为什么必须」一句话；条目全文与补足标准见 `03-gap-register.md`，风险钉住见 `04-risk-register.md`。

| 优先级 | 条目 | 一句话「为什么必须」 |
| --- | --- | --- |
| `P0` | `GAP-CTX-04` 上下文键-指针一致性告警与自愈 | 键在而指针缺失时静默零 spec 注入，是最贵的静默失败；仅需 myflow 侧小改 |
| `P0` | `GAP-TOOL-06` 工具输出上限与全局 net | 单次 `myflow_subagent` 输出可挤爆上下文；仅需 myflow 侧小改（可复用现有 `logPath`） |
| `P0-R` | `QGAP-CTX-02` 会话身份↔任务指针绑定强度对齐 | `RISK-03`（`R-HARD`）+ `RISK-01`（键派生等价）的钉住动作，纯 myflow 侧断言测试 |
| `P1` | `QGAP-CMPT-05` 压缩与注入共存语义强度对齐 | 状态注入在核心流程上；去掉对 Pi 事件时序的依赖（`RISK-02`） |
| `P1` | `GAP-PLAN-01` 只读探索阶段的代码强制 | 唯一「名义有、实际靠约定」还在裸奔的核心门；补足即复用既有 `{block}` 模式 |
| `P1` | `QGAP-PLAN-02` `ExitPlanMode` + 审批门强度对齐 | 任务生命周期核心门；把「已批准」变成可判定字段（与 verify 门并存） |
| `P1` | `GAP-NOA-07` 硬保护 vs 软保护 | 上下文完整性缺口，直接关系状态注入能否存活 |
| `P1` | `GAP-NOA-08` 紧急截断标记 | 上下文完整性缺口，Pi 给 `context_edit` 原语但**无压力触发判定**（`O-3`） |

> `P1` 共 6 条（其中 `QGAP-CTX-02` 同时记 `P1` 与 `P0-R`）；去重后必补条目 = **8**。

### 4.2 不补（`V-PI` 32 + `V-EXT` 2 + `V-UP` 2 + `V-NA` 0 = **36**）

- **`V-PI`（32 项）**：Pi 内建已给，myflow 一律委托、未重复实现。理由与逐项证据见 `06-non-gaps.md` §1.1。
  典型：`LLM-01..03`（多协议归一）、`CORE-01..04`（Session/Run/Resume）、`HOOK-01..04`（生命周期回调）、
  `TRANS-01/02`（JSONL 与冷启动重建）、`CMPT-03/04`（PTL 恢复与非破坏 boundary）。
- **`V-EXT`（2 项）**：`MCP-01`/`MCP-03` 由 `A-EXT:pi-mcp-adapter` 提供（内建被 `-builtin:mcp` 关闭）。
  依 `07-method.md` §2 的 `A-EXT` 分级规则，`A-EXT` **不得**记为 `V-PI`；其卸载后果见 `04-risk-register.md` §5。
- **`V-UP`（2 项）**：`LOOP-03`（运行期 tool pair 孤儿修复）、`LOOP-04`（ContinueReason 建模），
  修复原语在 Pi 执行器内，myflow 补不了，只能依赖或规避。
- **`V-NA`（0 项）**：无任何条目被判「与 myflow 场景无关」。

**「看似缺口实际不是」**（8 项，`06-non-gaps.md` §2）：最关键的 `MIS-01`（Agent 类工具是 `A-EXT`）、
`MIS-02`（MCP 被扩展接管）、`MIS-07`（`noa`/`noaadapter`/`transcript` 是实现包而非示例）。
**补足时不得牺牲的优势**（6 条 ★，`05-advantage-register.md`）：

- ★ `ADV-01` 有界写者才可并行 + 路径级 fail-closed 写范围门 —— 新增权限规则表/mode 时必须**内嵌**、不得替换 `writesUnder` 路径守卫。
- ★ `ADV-02` 派发上限 + 逐 run 可回溯日志 —— 截断 `myflow_subagent` 结果时必须保留并回报 `logPath`。
- ★ `ADV-03` 注入预算显式降级 —— 去掉压缩时序依赖时不得改成「无条件全量注入」。
- ★ `ADV-04` 递归守卫三层 —— 只读门应复用 `{block}` 模式，不得放宽 `myflow-research` 的 `tools:` 白名单。
- ★ `ADV-06` channel durable JSONL 通信 —— 回退即退回「一次性派发-回传」的最弱协作模型。
- ★ `ADV-08` verify gate（含 channel review worker）—— 新增审批门必须与 verify 门**并存**。

> 逐缺口 × 优势的约束矩阵见 `05-advantage-register.md` §2。

---

## 5. 一页速览：16 个 Norma 实现包 → 域 → 判定分布

> 语料 = `research/00-baseline.md §5` 的 16 个实现包（README 13 + `noa` + `noaadapter` + `transcript`）。
> 判定分布按 `02-matrix.md` 表 B 的 `V-*` 计数（含跨域项归主域）。`CTX`/`OBS`/`TEST` 为跨切面域，不绑定单包。

| Norma 实现包 | 非测试文件 | 对应域 | 判定分布（GAP / QGAP / V-PI / V-OWNED / V-ADV / V-EXT / V-UP） | 一句话 |
| --- | --- | --- | --- | --- |
| `llm` | 12 | `LLM` | 1 / 0 / 3 / 0 / 0 / 0 / 0 | 归一已给，限流无人 |
| `tool` | 27 | `TOOL`（+ 输出 net） | 2 / 0 / 4 / 0 / 0 / 0 / 0 | 缺保守默认与统一 net |
| `permission` | 1 | `PERM` | 5 / 0 / 0 / 0 / 0 / 0 / 0 | 整体空白 |
| `harness` | 4 | `LOOP`（+ tool 输出上限） | 2 / 0 / 1 / 1 / 0 / 0 / 2 | 缺消息级调度与预算结算 |
| `compaction` | 2 | `CMPT`（+ skill 重注入） | 2 / 1 / 2 / 0 / 0 / 0 / 0 | 缺 Micro 层与熔断 |
| `hook` | 1 | `HOOK` | 0 / 0 / 4 / 0 / 0 / 0 / 0 | 全部 Pi 已给 |
| `subagent` | 1 | `SUB` | 0 / 0 / 0 / 3 / 0 / 0 / 0 | myflow 全域 ≥ Norma |
| `mcp` | 2 | `MCP` | 0 / 0 / 1 / 0 / 0 / 2 / 0 | 扩展接管（MIS-02） |
| `plan` | 1 | `PLAN` | 1 / 1 / 0 / 0 / 0 / 0 / 0 | 只读无强制 + 审批门偏后（`PLAN-03` 已并入 `GAP-PERM-05`） |
| `memory` | 3 | `MEM` | 2 / 2 / 0 / 0 / 0 / 0 / 0 | 无召回无告警 |
| `skill` | 1 | `SKILL` | 2 / 0 / 2 / 0 / 0 / 0 / 0 | 缺压缩存活与 MCP 解锁 |
| `coordinator` | 1 | `COORD` | 0 / 1 / 0 / 1 / 0 / 0 / 0 | 限流语义弱 |
| `agentcore` | 1 | `CORE` | 0 / 0 / 4 / 0 / 0 / 0 / 0 | 全部 Pi 已给 |
| **`noa`** | **29** | `NOA` | **7 / 0 / 4 / 0 / 0 / 0 / 0** | **最大真缺口域** |
| **`noaadapter`** | **13** | `NOAA`（+ `NOA-10`/`CTX`） | 3 / 0 / 4 / 0 / 0 / 0 / 0 | 缺账本继承与溢出学习窗 |
| **`transcript`** | **2** | `TRANS` | 1 / 0 / 3 / 0 / 0 / 0 / 0 | 缺 sidechain 分离 |
| — | — | `CTX`（跨切面） | 1 / 1 / 0 / 2 / 0 / 0 / 0 | 指针缺失静默（`R-HARD`） |
| — | — | `OBS`（跨切面） | 0 / 0 / 0 / 0 / 2 / 0 / 0 | 状态可观测优势 |
| — | — | `TEST`（跨切面） | 0 / 0 / 0 / 0 / 2 / 0 / 0 | verify + 文档契约回归优势 |
| **合计** | **108** | 19 域 | **29 / 6 / 32 / 7 / 4 / 2 / 2** | 16 包全覆盖 |

> **计数口径**（C4 复核）：本表 GAP 列**不含** `CAP-PLAN-03`（已由 `03-gap-register.md` §0 裁定 `C-5` 并入
> `GAP-PERM-05`，故 `PLAN` 行记 `1`），**含**非 `CAP` 的 `GAP-CTX-04`（故 `CTX` 行记 `1`）；两处相抵后 GAP 合计 = `29`，
> 与 `02-matrix.md` 表 C 的 `V-GAP` 一致。若按纯 `02-matrix.md` 表 B 的 `CAP-*` 口径（含 `PLAN-03`、不含 `CTX-04`），
> 同样为 `29`——两条口径不可混用，本表已显式选定「缺口登记册口径」。

> AC 核对：`NOA` 11 项（≥9）、`NOAA` 7 项（≥5）、`TRANS` 4 项（≥3），且每项均有 Norma 侧证据路径（`02-matrix.md` 表 A）。

---

## 6. 与后续任务的衔接（消费方式）

`03-gap-register.md` 的每条 `GAP-*` / `QGAP-*` 都按统一模板写全 8 个字段，
可**直接复制**为一个后续任务的 PRD 主体；字段映射见 `README.md` §「如何消费缺口条目」。
本任务不创建子任务；`P0`/`P1` 的拆分建议（`myflow-context-pointer-integrity`、`myflow-tool-output-cap` 等）
见 `03-gap-register.md` §3，须在 P4 评审通过后创建。

**本文件不引入任何 `research/`、`02`–`06` 之外的新结论或新证据。**
