# 03 — 缺口登记册（`GAP-*` 真缺口 + `QGAP-*` 质量差）

> **版本锚点**：myflow@`0a702fa`、Norma@`52f17dd`、Pi **1.2.0**（`E0`/`E1`/`E2`，见 `research/00-baseline.md`）。
> **判定规则**：`design.md` §4（强制层级/回归轴）、§5.1/§5.2（归属码/结论码）、§8.4（条目模板）、§9（优先级规则）、§3（证据等级）。
> **主索引**：`02-matrix.md` 表 A（归属与证据）、表 B（myflow 现状/层级/结论码）。**本文件不引入 12 个分片与 `02-matrix.md` 之外的新结论**。
> **路径前缀**：Pi 证据省略 `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/`；Norma 证据省略 `../Norma/`；
> myflow 证据省略 `.pi/extensions/myflow/`（`ix`=index、`sb`=subagent、`ci`=context-injection、`tc`=turn-cache、`st`=status、`ag`=agents），测试省略 `tests/`。
> **最终条数**：`GAP-*` = **29** 条；`QGAP-*` = **6** 条；合计 **35** 条。
> **优先级定稿**：`P0` = 2、`P0-R` = 1、`P1` = 6、`P2` = 27（其中 `QGAP-CTX-02` 同时记 `P1` 与 `P0-R`，合计仍为 35 条）。
> **C1 复核修正（B5）**：按 `research/c1-neg-recheck.md`，4 条条目的「Pi 现状」`O-*` 由 `O-5` 上调为 `O-3`（`GAP-CMPT-02`、`GAP-LOOP-02`、`GAP-NOA-07`、`GAP-NOA-08`）；`GAP-SKILL-03` 按 C1 拆为 roster（宿主已给）/ 正文（缺口）并改 `O-5` → `O-3`。**条数（29/6/35）与优先级分布不变**。

---

## 0. 判定修正记录（B1 冲突裁定 + 本批去重/补登记）

> 来源：`02-matrix.md` §5.2 的 8 条跨分片冲突，逐条给出最终裁定。**去重是硬要求**，同一条缺口不得在本册出现两次。

| # | 冲突内容 | 裁定 | 依据 |
| --- | --- | --- | --- |
| `C-1` | `TOOL-01` 强制层级（T2：`E-N[mf]` vs S1：`E-C[myflow]`） | **采 `E-N[myflow]` 为主**，注册动作括注 `E-C[myflow]` | 两者所指层次不同：T2 判「无自有 `Registry` 抽象」，S1 判「`pi.registerTool` 的注册动作由代码执行」。本条 `V-PI`（不补），不进入本册 |
| `C-2` | `TOOL-03` 强制层级（T2：`E-C` vs S1：`E-N`） | **本册写 `E-N[myflow]`（工具定义保守默认缺）+ 现存的 `writesUnder` 写范围门为 `E-C[myflow]`** | T2 的 `E-C` 指写范围守卫（`ix:122-140`），S1 的 `E-N` 指工具定义行为默认（`tool/tool.go:9,98-124` 的对应物）。两者同域不同关注点，见 `GAP-TOOL-03` |
| `C-3` | `PERM-03` 强制层级（T2：`E-N[mf]` vs S2：`E-C[M]`） | **本册写 `E-C[myflow]`（单条硬 deny=`writesUnder`）+ 明确「无 deny 优先级规则表」** | S2 判「单条写范围硬 deny」是代码（`ix:116,420-452`）；T2 判「无 allow/deny/ask 求值管线」。冲突为口径差，非真矛盾，见 `GAP-PERM-03` |
| `C-4` | myflow 注册 hook 数（T2 记 6 vs S7/T3 记 7） | **以 7 为准**（`session_start`/`input`/`before_agent_start`/`context`/`tool_call`/`session_before_compact`/`agent_before_settle`） | S7 `research/norma-ext-integrate.md §2`（`index.ts:273,302,319,340,420,455,464`）+ T3 `DOC-DRIFT-01`。`references/harness-conventions.md:101-102`「all six hooks」为**文档漂移**（非 `RISK-*`，建议以测试钉死）。本册不涉及 HOOK 缺口 |
| `C-5` | `PERM-05` 与 `PLAN-03` 重叠 | **合并为单条 `GAP-PERM-05`**（中途权限模式翻转），`PLAN` 侧不再单列 | S2 覆盖 `PERM-05`（逐调用重读 `PermissionModeFunc`），S8 覆盖 `PLAN-03`（`approve→target` 翻转）。同一关注点两处登记，合并后 `GAP-*` 计数减 1（见 `GAP-PERM-05` 的「去重声明」）。`PLAN` 域实际缺口仅 `PLAN-01`（`V-GAP`）与 `PLAN-02`（`V-QUAL`） |
| `C-6` | `CMPT-05` 的 `V-QUAL` vs `R-OK` | **结论码取 `V-QUAL`（出 `QGAP-CMPT-05`），同时并记回归 `R-T`（`tests/extension.test.ts:224`），不得写 `R-∅`** | `design.md` §4.2：`V-QUAL` 判「强度弱于 Norma」，`R-OK` 判「风险已自愈」——两轴正交，非真冲突。见 `QGAP-CMPT-05` |
| `C-7` | `NOA-10` 与 S4 state 条目重叠 | **无缺口重复**：`CAP-NOA-10` 在表 A 仅一行（`02-matrix.md` 表 A #41），结论 `V-PI`（不补），本册不列 | S4 表未列 `NOA-10`，`NOA-10` 由 S5 显式承担（`research/norma-noaa-trans-core.md §1` 末行）。去重结果为「不存在两条同缺口条目」，无需合并代码 |
| `C-8` | PRD `Q3` 的「递归守卫仅靠提示词」反例 | **修正**：递归守卫实为 `E-C[myflow]`（`ix:420-432`）+ `E-G[myflow→Pi]`（`--tools` 白名单），**非**仅提示词 | S3 `research/norma-sub-coord.md §1/§0`、T3 §2、T2 §4。本册「名义有、实际靠提示词」的实证反例改指：`PLAN-01`（只读仅文字）、`MEM-03`（召回仅文字）、`MEM-02`（索引人工维护）、以及 T2 §2 的 `P3`/`P5`（workflow 提示词约定） |
| `C-9` | C1 对抗复核推翻/降级 `NEG` | **本册 5 条 `O-*` 码上调**：`GAP-CMPT-02`/`GAP-LOOP-02`/`GAP-NOA-07`/`GAP-NOA-08` 的 `O-5` → `O-3`；`GAP-SKILL-03` 拆为 roster（`V-PI`，非缺口）/ 正文（`V-GAP`）并改 `O-3` | `research/c1-neg-recheck.md` §2（`#11`/`#13`/`#14`/`#21`/`#33`）；各条「Pi 现状」已同步 |

**本批受控偏离与计数口径（已授权，显式登记）**：

1. **新增 `GAP-CTX-04`**（不在 `02-matrix.md` 表 A 的 82 项内）：源自 `research/contract-risks-and-advantages.md` 的 `RISK-03`（键在而 `.runtime/sessions/<key>.json` 指针缺失 → 静默零注入）与 `RISK-05`（无键回退两侧口径不一致）。B2 dispatch 明确要求将「键在而指针文件缺失无告警」登记为 `GAP-CTX-*` 候选（`P0`）。证据全部来自 T3 分片，未引入新证据。
2. **`GAP-LOOP-06` 吸收 `ADV-02` 提示的「结算（settlement）缺失」**：T3 `ADV-02` 指出 myflow「无收尾阶段」，而 `CAP-LOOP-06`（结算与超时）在表 B 已判 `V-GAP`。为免重复计数，**不另立 `QGAP-LOOP-*`**，将该子项作为 `GAP-LOOP-06` 的核心内容登记（见其「能力描述」与「补足标准」）。
3. **`PERM-05` 合并 `PLAN-03`** 后，实际条目数 = 表 B 的 29 条 `V-GAP` − 1（合并）+ 1（`GAP-CTX-04`）= **29**；`V-QUAL` 6 条不变。

---

## 1. `GAP-*` / `QGAP-*` 主表

> 域顺序（`design.md` §7.2 全集顺序，仅列有 `V-GAP`/`V-QUAL` 的域）：
> `CTX` → `CMPT` → `NOA` → `PERM` → `PLAN` → `MEM` → `LOOP` → `TOOL` → `SKILL` → `LLM` → `COORD` → `NOAA` → `TRANS`。

### 1.1 `CTX`

#### GAP-CTX-04 上下文键-指针一致性告警与自愈

- **能力描述**：当会话键存在、而 `.myflow/.runtime/sessions/<key>.json` 任务指针缺失（换机 / 新 clone / 新 worktree），或两侧「无键」回退口径不一致时，产出**可观测告警**并**自愈**（重建指针或显式降级），而非静默降级为 `no_task` / 零 spec 注入。
- **Norma 机制与证据**：`noaadapter/state_store.go:74-90,131-152` — 每会话 `state.json` 有版本守卫 + 原子写；sidecar 缺失时 `RebuildStateFromLog` **冷启动重建**；`noaadapter/materialize.go:9-30,73-84`；`noaadapter/inherit.go:29-36,63-84` 父链继承。
- **Pi 现状（为什么宿主不给）**：`O-4`（宿主契约依赖）+ `O-3`。`PI_SESSION_ID` 形状见 `docs/environment-variables.md:20-31`，扩展侧 id 来自 `sessionManager.getSessionId()`（`pi-coding-agent.d.ts:16-18`），二者等价**未文档化**；`/fork`·`/clone` 生成新会话新 id（`docs/session-format.md:72-75`）、`/tree` 同文件（`docs/sessions.md:20-26`）。宿主不提供「键 ↔ 外部指针」一致性的任何原语。
- **myflow 现状**：`E-N[myflow]` / `R-∅`。每回合从 `getSessionId()` 派生键（`ix:161-193`）；指针读取失败即 `no_task`（`tc:45-51`）；`get_context.py:118-127` 记 `context-missing` 但**无告警**；无键回退两侧口径不一——扩展要求「恰好一个会话文件」（`tc:52-60`），脚本取 mtime 最新（`get_context.py:129-130`）。T3 `RISK-03`（`R-HARD`）、`RISK-05`（`R-SOFT`）。
- **缺口判定**：`V-GAP`（Norma 有等价重建/告警语义 ∧ Pi 无 ∧ myflow 无）。
- **补足标准**（逐条可验收）：
  1. 目标**强制层级**：`E-C[myflow]`（键存在而 `<key>.json` 缺失时，代码必须进入显式告警路径并拒绝静默零注入；不依赖提示词自律）。
  2. 目标**回归护栏**：`R-T`，测试用例新增于 `tests/task-bridge.test.ts`（「键在而指针缺失」）与 `tests/session-context.test.ts`（「无键回退两侧同口径」）。
  3. 行为规格：Given 某会话键存在且对应指针文件缺失；When 扩展解析 `session-context`；Then 输出显式告警（含键与缺失路径），且 `get_context.py` 与扩展对同一会话返回**同一**活动任务或同一 `no_task`。
  4. **不作弊条件**：只在日志里打印一行不算完成；必须使「扩展」与「脚本」两条路径的判定可被同一测试同时断言，且保留 `MYFLOW_SKIP_BREADCRUMB` / 跳过关键字逃生路径（`ix:310-315`）。
- **依赖与代价**：不需新依赖；不触碰 Pi 契约（仅断言 `O-4`）；规模**小**。
- **优先级**：`P0`。依据 §9：`V-GAP` ∧ 状态静默丢失 ∨ 补足仅需 myflow 侧改动且代价小——两条同时满足。
- **证据等级**：`E0`/`E1`/`E2`/`E3`（无 `E5`）。

#### QGAP-CTX-02 会话身份 ↔ 任务指针绑定的强度对齐

- **能力描述**：myflow 的任务指针应与会话身份**强绑定**，并在 `/fork`、`/clone`、子代理派生时提供明确的继承/交接语义。
- **Norma 机制与证据**：`noaadapter/state_store.go:16-27` — 账本带 `sessionId`；`noaadapter/inherit.go:29-36,63-84` — 子会话 `DeriveChildState` 换自身 id 继承 Blocks/Refs，父链可回溯。
- **Pi 现状（为什么宿主不给）**：`O-3` / `O-4`。id 原语齐备（`pi-coding-agent.d.ts:16-18`、`docs/environment-variables.md:20-31`），但**无父链继承、无 fork 交接**语义；`/fork`·`/clone` 换新 id（`docs/session-format.md:72-75`），`/tree` 同文件（`docs/sessions.md:20-26`）。
- **myflow 现状**：`E-C[myflow]` / `R-T tct:172,189,207,256`。两侧各派生 `pi_<sanitize(id)>`（`ix:161-193` ↔ `task.py:96-117`、`get_context.py:101-111`）；越界/投毒 → `no_task`（`tc:22-33,84-98`）。**无父链继承、无 fork 交接**（子代理靠 `MYFLOW_CONTEXT_ID` 显式继承，`sb:446`）。
- **缺口判定**：`V-QUAL`（Norma 有 ∧ Pi 无 ∧ myflow **有但覆盖更弱**）。
- **差距实证**：`Norma:E-C + R-T`（`state_store.go:16-27` + `state_store_test.go`）**vs** `myflow:E-C + R-T`（`ix:161-193` + `tests/task-bridge.test.ts:27-56`）——强度同层，差在 **fork/父链继承缺失**，非机制有无。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（fork/换 id 时以代码检测「父指针可继承」并写入交接记录；拒绝路径 = 找不到父指针时显式告警，与 `GAP-CTX-04` 共用）。
  2. 目标**回归护栏**：`R-T`，`tests/task-bridge.test.ts` 增「fork 后新键可继承父任务指针」用例。
  3. 行为规格：Given 会话由 `/fork` 产生新 id；When 扩展解析 `session-context`；Then 按父链回退到父会话的任务指针并告警一次（不静默 `no_task`）。
  4. **不作弊条件**：不得用「把父键写进子键文件」的一次性脚本冒充；必须由代码在解析期按父链判定。
- **依赖与代价**：不需新依赖；触碰 Pi 会话身份契约（`O-4`）；规模**小**。
- **优先级**：`P1 + P0-R`。依据 §9：`V-QUAL` 且位于**核心流程**（状态注入 / 任务生命周期），并对应 T3 `RISK-03` 的 `R-HARD` 钉住。
- **证据等级**：`E1`/`E2`/`E3`。

### 1.2 `CMPT`

#### GAP-CMPT-01 MicroCompact 轻量压缩层

- **能力描述**：在重型摘要之前，先做「清理旧工具结果」的轻量压缩层，保留最近 N 条（Norma 为 5）。
- **Norma 机制与证据**：`compaction/compaction.go:62,69,173,249` — `Micro(清旧工具结果, keep5)` / Auto / Reactive 三层；`compactableTools` 白名单。
- **Pi 现状（为什么宿主不给）**：`O-3`。Pi 只有阈值 AutoCompact + overflow/length 恢复共 2 层（`docs/compaction.md:32,37,39`），无「清旧工具结果」独立层。
- **myflow 现状**：`E-N[myflow]`（有效 `E-C[Pi]`）/ `R-∅`。全委托 Pi。
- **缺口判定**：`V-GAP`（Micro 层：Norma 有 ∧ Pi 无 ∧ myflow 无）。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（在 `context` 钩子内以代码改写旧 `tool_result` 为占位符；拒绝路径 = 白名单外工具、或改写会破坏 tool pair 完整性时放弃本层）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/compaction.test.ts`（或扩展 `tests/context-injection.test.ts`）。
  3. 行为规格：Given 上下文含 >N 条旧工具结果；When myflow 预压缩层运行；Then 最旧的结果被替换为可识别占位符，最近 N 条与全部 tool pair 保持不变。
  4. **不作弊条件**：不得只在提示词里让模型「忽略旧结果」；必须真正改写**发出的** `messages`，且**不修改** Pi 的持久化原文。
- **依赖与代价**：不需新依赖；触碰 Pi `context` 契约（`O-3`）；规模**中**。
- **优先级**：`P2`。依据 §9：`V-GAP` 代价中等，非核心流程。
- **证据等级**：`E1`/`E4`。

#### GAP-CMPT-02 压缩熔断

- **能力描述**：连续多次自动压缩失败后停用自动压缩，避免「压缩-失败-再压缩」死循环。
- **Norma 机制与证据**：`compaction/compaction.go:69,304` — `maxAutoCompactFails=3` + `tripped` 连败停压。
- **Pi 现状（为什么宿主不给）**：`O-3`。无**连败计数**熔断；已有**有界单次恢复重试**（`docs/compaction.md:39`）与 `session_compact_failed` 遥测（`:372`）。原语在 Pi、熔断语义由 myflow 补（C1 `#11`）。
- **myflow 现状**：`E-N[myflow]`（有效 `E-C[Pi]`）/ `R-∅`。无熔断。
- **缺口判定**：`V-GAP`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（在 `session_before_compact` / 遥测处计数，连败达阈值即代码停用自动压缩；拒绝路径 = 熔断期内拒绝再次发起自动压缩）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/compaction.test.ts`。
  3. 行为规格：Given 连续 3 次自动压缩失败；When 再次触发阈值压缩；Then myflow 以代码阻止并显式告警，直到人工介入。
  4. **不作弊条件**：不得只发一次通知；必须有计数状态并在阈值内真正拦截。
- **依赖与代价**：不需新依赖；触碰 Pi 压缩事件契约（`O-3`）；规模**小**。
- **优先级**：`P2`。依据 §9：`V-GAP` 代价中等、非核心流程。
- **证据等级**：`E1`/`E4`。

#### QGAP-CMPT-05 压缩与注入共存语义的强度对齐

- **能力描述**：myflow 注入的 workflow-state 在宿主压缩后仍然存活，且不依赖「压缩恰好未被触发」的时序侥幸。
- **Norma 机制与证据**：`compaction/compaction.go:349,370` — summary 后按 5k/25k 预算**逐条重注入** skill 原文；`llm/skillmsg.go` 提供自识别信封。
- **Pi 现状（为什么宿主不给）**：`O-3`。`custom_message` 既参与 LLM context（`docs/session-format.md:178`）**又是合法压缩切点**（`docs/compaction.md:130,134`）；Pi **不重注入**扩展消息。压缩可被扩展拦截（`docs/compaction.md:293-320`）。
- **myflow 现状**：`E-C[myflow]` / `R-T`（`tests/extension.test.ts:224-255`）。每回合重注入（`ix:319-338`）+ 压缩后按 `lastInjectionTs > lastCompactionTs` 重挂（`ix:384-406`）+ `session_before_compact` 记时（`ix:455-457`）。
- **缺口判定**：`V-QUAL`（并记 `R-T`，**不写 `R-∅`**——见裁定 `C-6`）。
- **差距实证**：`Norma:E-C + R-T`（`compaction.go:349,370` + `compaction_test.go:55,84,105`）**vs** `myflow:E-C + R-T`（`ix:319-338,384-406,455-457` + `tests/extension.test.ts:224`）——强度同层，但 myflow 的补偿**依赖宿主事件时序**，最坏情况有 1 回合失败窗口。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（把缺失判定从 `ix:395` 提到早退 `ix:384` 之前，去掉「必须先触发压缩事件」的时序依赖）。
  2. 目标**回归护栏**：`R-T`，扩展 `tests/extension.test.ts:224-255`，新增「压缩标记先置、无后续事件仍能重挂」用例。
  3. 行为规格：Given `lastCompactionTs` 已更新但本回合 `context` 钩子先于压缩后事件触发；When myflow 构造注入；Then 状态块仍被重挂，无需等待额外事件。
  4. **不作弊条件**：不得把「每回合无条件重注入」当成修复（那会掩盖缺失检测逻辑失效）；必须证明重挂判定本身不依赖事件到达顺序。
- **依赖与代价**：不需新依赖；触碰 Pi 事件时序契约（`O-3`/`O-4`）；规模**小**。
- **优先级**：`P1`。依据 §9：`V-QUAL` 且位于**核心流程**（状态注入）。
- **证据等级**：`E1`/`E2`/`E3`。

### 1.3 `NOA`

#### GAP-NOA-01 ref 寻址（`mNNNNN` 稳定引用）

- **能力描述**：给进入模型的上下文块分配**稳定、永不重编号**的引用（ref），使模型可在后续轮次按 ref 精确定位消息。
- **Norma 机制与证据**：`noa/refs.go:15,25,74,78` + `noa/const.go:5,12` — `mNNNNN` 双向 map，`BLOCKED` 硬保护，ref 永不重编号。
- **Pi 现状（为什么宿主不给）**：`O-5`。模型无 ref 概念；只有宿主 entry id（8hex）可经 `context_edit.targetId` 定位（`docs/session-format.md:143,235`），非模型可寻址面。
- **myflow 现状**：`E-N[myflow]` / `R-∅`。无 ref 层。
- **缺口判定**：`V-GAP`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（myflow 侧 ref 分配器，发号前检查「已发 ref 未被改写」；拒绝路径 = 检测到映射漂移时拒绝重编号并保留原 ref）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/context-injection.test.ts` 用例（ref 稳定性）。
  3. 行为规格：Given 某上下文块已获 ref `m00001`；When 发生压缩/重排；Then 该块 ref 不变，且模型可按 ref 引用它。
  4. **不作弊条件**：不得用「每回合重新编号」冒充稳定 ref；不得只在注入文本里写序号而无映射。
- **依赖与代价**：不需新依赖；触碰 Pi `context` 契约；规模**大**。
- **优先级**：`P2`。依据 §9：`V-GAP` 代价高。
- **证据等级**：`E1`/`E4`。

#### GAP-NOA-02 tier 分层压缩（一次一层）

- **能力描述**：压缩分层推进，**一次只压一层**，层创建后内容固定，终层不可重写。
- **Norma 机制与证据**：`noa/tier.go:22,30,78`、`noa/types.go:56,61`、`noa/config.go:105` — `bN` tier 1..3，创建即固定，终层重写被检测。
- **Pi 现状（为什么宿主不给）**：`O-5`。单层；重复压缩靠 `previousSummary` 迭代（`docs/compaction.md:83`），无「同层不合压」约束。
- **myflow 现状**：`E-N[myflow]` / `R-∅`。
- **缺口判定**：`V-GAP`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（分层状态机；拒绝路径 = 同一层被重复压缩时由代码拒绝）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/compaction.test.ts`。
  3. 行为规格：Given 已存在 tier-1 压缩块；When 再次触发压缩；Then 新内容进入 tier-2 而非重写 tier-1。
  4. **不作弊条件**：不得用「摘要里写 tier 字样」冒充分层；必须有可断言的层状态。
- **依赖与代价**：不需新依赖；触碰 Pi 压缩契约；规模**大**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

#### GAP-NOA-03 block 模型与 rebuild

- **能力描述**：压缩产物是**可回放重建**的块（block）；从日志回放应得到**字节一致**的摘要。
- **Norma 机制与证据**：`noa/compress.go:77,225`（原子尺寸门）、`noa/state.go:38`、`noa/rebuild.go:37,45`（回放字节一致）。
- **Pi 现状（为什么宿主不给）**：`O-5`。无块模型；摘要落 `CompactionEntry`，原文留 JSONL（`docs/compaction.md:79`、`docs/session-format.md:226`），可读但不可按 ref 重建。
- **myflow 现状**：`E-N[myflow]` / `R-∅`。
- **缺口判定**：`V-GAP`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（块模型 + 回放校验；拒绝路径 = 回放摘要与存档字节不一致则拒绝写入 state）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/compaction.test.ts`（回放一致性）。
  3. 行为规格：Given 已写块的会话；When 冷启动回放日志；Then 得到与写入时字节一致的块内容。
  4. **不作弊条件**：不得以「重新摘要一次」冒充回放；必须证明两路径产物一致。
- **依赖与代价**：不需新依赖；触碰 Pi 会话格式契约；规模**大**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

#### GAP-NOA-04 nudge 节律

- **能力描述**：按**上下文增长节律**（而非固定轮数）主动催促模型压缩，压缩后重锚。
- **Norma 机制与证据**：`noa/nudge.go:11,20,56,114,206,300`、`noa/config.go:99-116` — 双波段成长节律 + 压缩后重锚 + tier 独立节律。
- **Pi 现状（为什么宿主不给）**：`O-5`。无压缩 nudge，只有阈值自动压缩与人工 `/compact`（`docs/compaction.md:32,37,41`）。
- **myflow 现状**：`E-N[myflow]` / `R-∅`；每回合注入 workflow-state（`ix:319-337`，`context` 兜底 `ix:384-417`）与压缩无关。
- **缺口判定**：`V-GAP`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（节律由代码按 token 增长量计算并在 `context` 注入；拒绝路径 = 未达节律门时由代码抑制 nudge）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/compaction.test.ts`（节律门控）。
  3. 行为规格：Given 上下文增长未达节律门；When myflow 构造注入；Then 不发出压缩 nudge；反之在跨越门限时发出且带「勿重跑」提示。
  4. **不作弊条件**：不得用「每 N 轮固定提醒」冒充节律（Norma 的判据是成长量而非轮数）。
- **依赖与代价**：不需新依赖；触碰 Pi `context` 契约；规模**中**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

#### GAP-NOA-07 硬保护 vs 软保护

- **能力描述**：区分「**某些工具结果恒不进压缩**」的硬保护与「最近 N 条/若干 token 保尾」的软保护。
- **Norma 机制与证据**：`noa/const.go:54`、`noa/protected.go:13,33,74`、`noa/compress.go:371-377,381-400`、`noa/config.go:115-116` — 硬保护名单（含 `Compress` 工具本身 + 可配置 `ProtectedTools`）+ 软尾部区（`PreserveRecentMessages/Tokens`）。
- **Pi 现状（为什么宿主不给）**：`O-3`。**无命名工具硬保护名单**；只有软尾部 `keepRecentTokens`（`docs/compaction.md:82,443`）。**但有原语**：`session_before_compact` 可返回 `{compaction:{summary,firstKeptEntryId,…}}` 自选保留边界（`docs/compaction.md:302-320`；`:138` 为保护性不变量）。缺的是「命名名单 + 强制跳过」（C1 `#13`）。
- **myflow 现状**：`E-N[myflow]` / `R-∅`。无工具级硬保护或尾部保护。
- **缺口判定**：`V-GAP`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（受保护工具结果在压缩改写时由代码跳过；拒绝路径 = 若某次压缩必然触及受保护结果，则代码放弃该次压缩）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/compaction-protection.test.ts`。
  3. 行为规格：Given 某工具在硬保护名单内；When 触发压缩；Then 其历史结果**不被摘要**（或其 tool pair 整体保留）。
  4. **不作弊条件**：不得只把「保留原文在 JSONL」算作保护（Norma 判的是**进入模型可见上下文**的完整性）。
- **依赖与代价**：不需新依赖；触碰 Pi `context`/压缩契约；规模**中**。
- **优先级**：`P1`。依据 §9：`V-GAP` 且位于**核心流程**（上下文完整性，影响状态注入存活）。
- **证据等级**：`E1`/`E4`。

#### GAP-NOA-08 紧急截断标记

- **能力描述**：上下文使用率逼近上限时，对**最大**的未截断工具结果做「保头保尾」改写，插入截断标记并附「勿重跑」提示；只改发出的、不改存储。
- **Norma 机制与证据**：`noa/truncate.go:12-15,35,108`、`noa/processturn.go:87-88`、`noa/nudgetext.go:132`、`noa/config.go:109` — 使用率 ≥ `.95` 触发，标记 + 通知。
- **Pi 现状（为什么宿主不给）**：`O-3`。**建时**每工具上限（bash 2000 行/50KB `docs/codemode.md:43`；MCP >20KB `docs/mcp.md:232`；codemode `max_output_tokens` `docs/codemode.md:12`）。**运行期原语已给**：`context_edit` 可 append-only 改写**已存** entry（`replacement:null` 省略 / 非空替换；targets 可为 tool-result；原文与元数据不变，`docs/session-format.md:143-147,235`），并可由 `turn_end`/`agent_before_settle` 链式追加（`docs/extensions.md:118`）。宿主不决定**何时**改写；缺口是「**谁来自动触发** + 选最大未截断结果」（C1 `#14`）。
- **myflow 现状**：`E-N[myflow]` / `R-∅`。`ci` 的截断只作用于**注入的 task 文件**（`ci:22-26,250-256`），与模型工具输出无关。
- **缺口判定**：`V-GAP`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（myflow 侧做**压力检测与触发判定**，复用 Pi `context_edit` 或 `context` 钩子落地改写；拒绝路径 = 压力未达阈值时不改写、且截断后必附标记与「勿重跑」）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/context-injection.test.ts` 用例（压力触发）。
  3. 行为规格：Given 上下文使用率 ≥ 阈值；When myflow 构造请求；Then 最大未截断工具结果被保头保尾并带截断标记；压力回落后自动复原。
  4. **不作弊条件**：不得改写持久化原文；不得对全部结果无差别截断（必须选**最大**未截断者）。
- **依赖与代价**：不需新依赖；**复用 Pi `context_edit` 或 `context` 钩子二选一，两者均落在 Pi 契约上（`O-3`），须登记为宿主契约**；规模**中**。
- **优先级**：`P1`。依据 §9：`V-GAP` 且位于**核心流程**（上下文完整性）；C1 修正后仍为 `P1`（缺口从「无原语」变为「无触发判定」，代价仍属中等）。
- **证据等级**：`E1`/`E4`。

#### GAP-NOA-09 压缩建议与死区（`ViableRanges`）

- **能力描述**：向模型暴露**可压缩区间建议**，并排除过小（<200 token）死区；对死区重复选择予以拒绝。
- **Norma 机制与证据**：`noa/recommend.go:256,267`、`noa/const.go:31,43` — `BuildRecommendation` + `ViableRanges` + 死区重复拒绝（2 次）。
- **Pi 现状（为什么宿主不给）**：`O-5`。无对模型暴露的压缩建议面（`research/norma-cmpt-noa-core.md §2` NEG-A/B 命中 0）。
- **myflow 现状**：`E-N[myflow]` / `R-∅`。
- **缺口判定**：`V-GAP`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（区间判定与死区拒绝在代码内；拒绝路径 = 死区被重复选择达阈值即由代码拒绝）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/compaction.test.ts`。
  3. 行为规格：Given 存在多个可压缩区间；When 模型选择死区区间；Then myflow 拒绝该选择并返回可行区间清单。
  4. **不作弊条件**：不得只在提示词里写「请勿选小区间」；死区判定必须可被测试断言。
- **依赖与代价**：不需新依赖；触碰 Pi 压缩契约；规模**中**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

### 1.4 `PERM`

#### GAP-PERM-01 allow/deny/ask 三态

- **能力描述**：工具调用前可给出 allow / deny / ask（征询用户）三态决策，并支持把建议回传给发起方。
- **Norma 机制与证据**：`permission/permission.go:18-31` — 三态 + 建议回传。
- **Pi 现状（为什么宿主不给）**：`O-2`（刻意外包）。Pi 原文：`docs/security.md:3`「it does not ask for approval before every tool call」；`docs/extensions.md:167`「a **permission extension**」；`docs/mcp.md:252`「**permission gates**」。内核**无**逐调用审批。
- **myflow 现状**：`E-N[myflow]` / `R-∅`。只有硬 `block`，无 `ask`（`ix:420-452`）。
- **缺口判定**：`V-GAP`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（在 `tool_call` 内按规则求值返回 `{block}` 或 `ask` 路径；拒绝路径 = deny 规则命中即代码阻断）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/permission.test.ts`。
  3. 行为规格：Given 规则命中 `ask`；When 模型发起该工具调用；Then 进入用户征询且未获批前不执行。
  4. **不作弊条件**：不得只用提示词「请先询问」；`ask` 必须是可拦截的代码路径。
- **依赖与代价**：不需新依赖；触碰 Pi `tool_call` 契约；规模**中**。
- **优先级**：`P2`。依据 §9：`V-GAP` 代价中等、非 myflow 核心流程。
- **证据等级**：`E1`/`E4`。

#### GAP-PERM-02 mode 系统（6 种）

- **能力描述**：定义权限模式集合（如 plan / acceptEdits / bypass 等），模式决定可达工具集。
- **Norma 机制与证据**：`permission/permission.go:51-58` — 6 种 mode。
- **Pi 现状（为什么宿主不给）**：`O-5`。无 mode，仅有进程级 allowlist（`docs/cli.md:120-122`、`docs/settings.md:42`）。
- **myflow 现状**：`E-G[myflow→Pi]` / `R-T sh:133`。无 mode；代替法 = agent frontmatter `tools:` 经 `--tools` 由 Pi 强制（`sb:403`、`.pi/agents/myflow-research.md:5`）。
- **缺口判定**：`V-GAP`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（mode 状态机 + 由代码经 `pi.setActiveTools()` 落地；拒绝路径 = 当前 mode 不允许的工具在 `tool_call` 被阻断）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/permission.test.ts`。
  3. 行为规格：Given 当前 mode 为只读；When 模型发起写工具；Then 被阻断并给出 mode 原因。
  4. **不作弊条件**：不得把「agent 声明 `tools:`」当作 mode（那是启动期白名单，无法中途翻转）。
- **依赖与代价**：不需新依赖；触碰 Pi 工具集契约；规模**中**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

#### GAP-PERM-03 deny 优先级规则表

- **能力描述**：deny 规则集合在评估中**优先**于 mode/bypass，构成有序判定表。
- **Norma 机制与证据**：`permission/permission.go:85-90,145-158` — Stage1 deny 先于 mode/bypass。
- **Pi 现状（为什么宿主不给）**：`O-5`。无规则表；近似物 `--exclude-tools` 无优先级语义（`docs/cli.md:121-122`）。
- **myflow 现状**：`E-C[myflow]` / `R-T sbt:456,525,554,581`。单条硬 deny（`writesUnder` 写范围，`ix:116,420-452`），无优先级表。
- **缺口判定**：`V-GAP`（承接裁定 `C-3`）。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（deny 集合在求值管线最先执行；拒绝路径 = 任一 deny 命中即阻断，即使 mode 为 bypass）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/permission.test.ts`（deny 优先于 bypass）。
  3. 行为规格：Given deny 规则与 bypass mode 同时命中；When 求值；Then 结果为 deny。
  4. **不作弊条件**：不得把现有单条 `writesUnder` 当成规则表（表必须支持多规则与顺序）。
- **依赖与代价**：不需新依赖；触碰 Pi `tool_call` 契约；规模**小**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

#### GAP-PERM-04 四阶段权限 `Evaluate`

- **能力描述**：权限评估为多阶段管线（如 硬 deny → mode → 规则 → 默认），每阶段可短路。
- **Norma 机制与证据**：`permission/permission.go:85-140` — 四阶段 `Evaluate`。
- **Pi 现状（为什么宿主不给）**：`O-2`（刻意外包）。Pi 原文：`docs/extensions.md:169-178` 以 `tool_call` 返回 `{block,reason}` 的**示例**演示审批（「a permission extension」语见 `:167`），把评估管线完全交给扩展自建；`docs/security.md:3`「it does not ask for approval before every tool call」确认内核无管线。
- **myflow 现状**：`E-N[myflow]` / `R-∅`。
- **缺口判定**：`V-GAP`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（四阶段求值函数；拒绝路径 = 任一阶段返回 deny 即短路阻断）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/permission.test.ts`（阶段短路顺序）。
  3. 行为规格：Given 阶段 1 命中 deny；When 求值；Then 后续阶段不被执行（可断言副作用未发生）。
  4. **不作弊条件**：不得用「一个 if 串联」冒充阶段化；必须能断言短路顺序。
- **依赖与代价**：不需新依赖；触碰 Pi `tool_call` 契约；规模**中**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

#### GAP-PERM-05 中途切换权限模式（含 `PLAN-03`）

- **能力描述**：运行中可翻转权限模式（如规划通过后从只读切到可写），且**逐调用**读取最新模式，无需重启会话。
- **Norma 机制与证据**：`harness/tools.go:47-49`、`harness/query.go:75` — 逐调用重读 `PermissionModeFunc`；`plan/plan.go:68-72` — approve → target。
- **Pi 现状（为什么宿主不给）**：`O-3`。原语 `pi.setActiveTools()`（`docs/extensions.md:163-165,185-189`），无 mode 语义。
- **myflow 现状**：`E-N[myflow]` / `R-∅`。未用 `setActiveTools`；子代理权限在 spawn 时固定（`--approve`，`sb:394`）；主会话无 mode 概念。
- **缺口判定**：`V-GAP`。
- **去重声明（裁定 `C-5`）**：本条**同时**吸收 `CAP-PERM-05` 与 `CAP-PLAN-03`（同一关注点的两处分片覆盖），本册不另立 `GAP-PLAN-03`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（mode 状态可变 + 每次 `tool_call` 由代码读取当前 mode；拒绝路径 = 旧 mode 的残留授权被代码清除）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/permission.test.ts`（切换后即时生效）。
  3. 行为规格：Given mode 从只读翻转为可写；When 同一回合内模型随后发起写工具；Then 写被允许（无需重启）。
  4. **不作弊条件**：不得以「spawn 时固定权限」冒充中途切换；必须证明**同一会话内**翻转生效。
- **依赖与代价**：不需新依赖；触碰 Pi 工具集/`tool_call` 契约；规模**中**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

### 1.5 `PLAN`

#### GAP-PLAN-01 只读探索阶段的代码强制

- **能力描述**：规划/探索阶段以**代码**强制只读（写工具不可达或被阻断），而非仅靠提示词。
- **Norma 机制与证据**：`plan/plan.go:81-98`（`EnterTool`）+ `permission/permission.go:52,100-103`（只读由权限层代码强制）；`R-T plan/plan_test.go:13-52`、`agentcore/plan_test.go:17-72`。
- **Pi 现状（为什么宿主不给）**：`O-2`（刻意外包）。Pi 原文：`README.md:19`「skips features like sub-agents and plan mode」；原语充足（`docs/extensions.md:165,187` `setActiveTools`、`:106,170-178` `tool_call` block、`:263` fail-safe），随包 `examples/extensions/plan-mode/` **未装载**。
- **myflow 现状**：`E-P[myflow]` / `R-∅`。无只读代码守卫，仅文字（`.pi/skills/myflow-brainstorm/SKILL.md:9-13`）。这是 §4.3 `R-STR-3` 的**实证反例**（裁定 `C-8`）。
- **缺口判定**：`V-GAP`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（按 `workflow.md` phase 在 `tool_call` 阻断写工具或用 `setActiveTools()` 收窄可达集；拒绝路径 = planning 阶段写工具被代码阻断）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/task-gate.test.ts` 用例 + 扩展 `tests/extension.test.ts`。
  3. 行为规格：Given workflow 处于 planning 阶段；When 模型发起 `write`/`edit`；Then 被阻断并返回阶段原因。
  4. **不作弊条件**：不得只改 `myflow-brainstorm/SKILL.md` 文字；必须能断言「planning 阶段写工具必被拒绝」。
- **依赖与代价**：不需新依赖；触碰 Pi `tool_call`/`setActiveTools` 契约；规模**中**。
- **优先级**：`P1`。依据 §9：`V-GAP` 且位于**核心流程**（任务生命周期）。
- **证据等级**：`E1`/`E4`/`E3`。

#### QGAP-PLAN-02 `ExitPlanMode` + 审批门的强度对齐

- **能力描述**：规划完成需经**可判定的审批门**才能进入执行；拒绝则留在规划态。
- **Norma 机制与证据**：`plan/plan.go:100-144` — `Approver` 回调；拒绝则 `tool.Errorf` 且留在 plan；`R-T plan/plan_test.go:28-52`。
- **Pi 现状（为什么宿主不给）**：`O-2`（刻意外包）。Pi 原文：`README.md:19`「skips features like sub-agents and **plan mode**」；无内建审批门，原语仅 `docs/extensions.md:104`（`before_agent_start` 改 prompt/工具）。
- **myflow 现状**：`E-P[myflow]`（评审门文字：`.myflow/workflow.md:20,106-107`、`.pi/prompts/myflow-continue.md:32-34`）+ `E-C[myflow]`（代码门：`task.py:493-508` 空 jsonl 拒绝 `start`；`R-T tgt:81`）。
- **缺口判定**：`V-QUAL`。门的**位置**不同：myflow 的门在**编码开始前**（jsonl 策展），非探索期的 plan 对象。
- **差距实证**：`Norma:E-C + R-T`（`plan.go:100-144` + `plan_test.go:28-52`）**vs** `myflow:E-P + E-C + R-T`（`workflow.md:20` 文字 + `task.py:493-508` 代码 + `tests/task-gate.test.ts:81`）——myflow 有代码门但**文本门未升级**，且无 plan 对象可拒绝。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（把「已批准」变成 `workflow.md` 中可判定的状态字段；未批准即进入 implement 派发时由代码拒绝）。
  2. 目标**回归护栏**：`R-T`，扩展 `tests/task-gate.test.ts:81`（未批准 → 拒绝派发）。
  3. 行为规格：Given planning 任务未记录批准；When 主会话尝试 `task.py start` 或派发 implement；Then 被代码拒绝。
  4. **不作弊条件**：不得只保留现有「空 jsonl 拒绝」；批准必须是显式、可断言的字段。
- **依赖与代价**：不需新依赖；仅 myflow 侧；规模**小**。
- **优先级**：`P1`。依据 §9：`V-QUAL` 且位于**核心流程**（任务生命周期）。
- **证据等级**：`E1`/`E4`/`E3`。

### 1.6 `MEM`

#### GAP-MEM-03 相关度选择与自动注入

- **能力描述**：对持久知识按相关度打分并**自动注入** top-N，而非依赖模型自行 `cat`。
- **Norma 机制与证据**：`memory/relevant.go:31-83`（`score`：name×3/desc×2/body×1 + recency）、`agentcore/agentcore.go:223,438-445`（`MaxInject` 默认 3）、`memory/tools.go:20-96`。
- **Pi 现状（为什么宿主不给）**：`O-5`。无相关性召回：skills 由模型自选（`docs/skills.md:45`，本身即 `E-P`）；context files 无条件全量（`docs/configuration.md:18`）。
- **myflow 现状**：`E-P[myflow]` / `R-∅`。`myflow-before-dev` 让模型 `cat .myflow/spec/index.md`（`.pi/skills/myflow-before-dev/SKILL.md:14,27-29`）——纯提示词、无排序、无上限。
- **缺口判定**：`V-GAP`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（按关键词对 spec 条目打分并自动注入 top-N；拒绝路径 = 无命中时注入空而非全量）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/context-injection.test.ts` 用例（打分与上限）。
  3. 行为规格：Given 任务上下文含关键词 K；When myflow 构造注入；Then 仅注入相关度最高的 N 条 spec，且 N 有上限。
  4. **不作弊条件**：不得让模型「自行决定读哪些」；排序与上限必须由代码产生并可断言。
- **依赖与代价**：不需新依赖；仅 myflow 侧；规模**中**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

#### GAP-MEM-04 陈旧告警

- **能力描述**：持久知识超过阈值（Norma 为 48h）时附「point-in-time，非实时」告警。
- **Norma 机制与证据**：`memory/relevant.go:85-108,115-132` — `Age` + `stalenessNote`。
- **Pi 现状（为什么宿主不给）**：`O-5`。无 memory 即无陈旧概念。
- **myflow 现状**：`E-N[myflow]` / `R-∅`。无运行时告警；靠 git blame/review。
- **缺口判定**：`V-GAP`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（按 mtime/提交时间计算龄期并在注入时附带 caveat；拒绝路径 = 超龄条目的 caveat 不可被配置关闭至静默）。
  2. 目标**回归护栏**：`R-T`，扩展 `tests/context-injection.test.ts`。
  3. 行为规格：Given spec 条目超过阈值未更新；When 注入；Then 附带陈旧告警文本。
  4. **不作弊条件**：不得只在文档里写「注意时效」；必须由代码计算并可断言。
- **依赖与代价**：不需新依赖；仅 myflow 侧；规模**小**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

#### QGAP-MEM-01 结构化元数据（frontmatter + type）

- **能力描述**：持久知识条目携带结构化元数据（name/description/type），供索引与召回使用。
- **Norma 机制与证据**：`memory/memory.go:1-6,146-196` — `parseFrontmatter`/`renderFrontmatter`；`R-T memory_test.go:13-38`。
- **Pi 现状（为什么宿主不给）**：`O-5`。无 memory store；skills frontmatter 属知识分发（`docs/skills.md:24,67`），非 myflow 长期记忆。
- **myflow 现状**：`E-P[myflow]` / `R-∅`。`.myflow/spec/**/*.md` 无 frontmatter/type；**有意**选 spec 路线（`.pi/skills/myflow-before-dev/SKILL.md:61`「Specs are authoritative over memory」）。
- **缺口判定**：`V-QUAL`。
- **差距实证**：`Norma:E-C + R-T`（`memory.go:146-196` + `memory_test.go:13-38`）**vs** `myflow:E-P`（`myflow-before-dev/SKILL.md:61` 的口头定位，无机器可读元数据）。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（spec 条目 frontmatter 校验：抬头缺失/非法即拒绝纳入索引；拒绝路径由测试锁定）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/spec-hygiene.test.ts`（或纳入 `skills-hygiene` 模式）。
  3. 行为规格：Given 新增 spec 文件缺 frontmatter；When 运行校验；Then 代码报错并要求补齐。
  4. **不作弊条件**：不得强制把所有现有 spec 改写成 memory 形态（保持 spec 定位）；只补最小元数据。
- **依赖与代价**：不需新依赖；仅 myflow 侧；规模**中**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

#### QGAP-MEM-02 `MEMORY.md` 式索引的自动重建

- **能力描述**：索引文件由代码从实际条目**重建**，而非人工维护。
- **Norma 机制与证据**：`memory/memory.go:119-145` — `Index`/`rebuildIndex`/`buildIndex`，每次 `Save` 自动重建；`R-T memory_test.go:30-34`。
- **Pi 现状（为什么宿主不给）**：`O-5`。无索引文件；skills 仅靠 `description` 供发现（`docs/skills.md:53,85`）。
- **myflow 现状**：`E-P[myflow]` / `R-∅`。`.myflow/spec/index.md` **人工维护**（`.pi/skills/myflow-update-spec/SKILL.md:50` 步骤 5）→ 有漂移风险。
- **缺口判定**：`V-QUAL`。
- **差距实证**：`Norma:E-C + R-T`（`memory.go:119-145` + `memory_test.go:30-34`）**vs** `myflow:E-P`（`myflow-update-spec/SKILL.md:50` 人工步骤）。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（校验 `index.md` 与实际 spec 文件集合一致；拒绝路径 = 不一致即非零退出并列出差异）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/spec-index.test.ts`（可用 `worktree.py verify` 挂载）。
  3. 行为规格：Given 新增 spec 文件但 `index.md` 未更新；When 运行校验；Then 代码失败并列出缺失条目。
  4. **不作弊条件**：不得只做「生成器但无人运行」；校验必须进入门禁（`verify`）。
- **依赖与代价**：不需新依赖；仅 myflow 侧；规模**小**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

### 1.7 `LOOP`

#### GAP-LOOP-02 消息级只读并行 / 写串行调度

- **能力描述**：同一批次工具调用中，只读工具可并行、写工具必须串行且互斥。
- **Norma 机制与证据**：`harness/streaming.go:9-18,59-84`（FIFO + 排他）、`tool/tool.go:140-152`（缺省不安全）。
- **Pi 现状（为什么宿主不给）**：`O-3`。无**调度器**——同消息工具**可并行**（`docs/extensions.md:124`）；但 core 提供互斥原语 `withFileMutationQueue()`（`:143-144`）与 `readOnlyHint`/`destructiveHint` 注解（`:167,172-174`）。缺的是「按读/写分类并强制串行」的调度语义（C1 `#21`）。
- **myflow 现状**：`E-C[myflow]` / `R-T sbt:308,334`。仅 dispatch 级写者互斥（`sb:636-648` 抛错），无消息级只读/写调度。
- **缺口判定**：`V-GAP`（消息级调度缺席）。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（在 `tool_call` 层对同批次写操作加锁/串行化；拒绝路径 = 检测到并发写即阻塞后到者）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/tool-scheduling.test.ts`。
  3. 行为规格：Given 同一批次含两个写工具；When 执行；Then 二者串行（可断言无交叠），只读工具不受影响。
  4. **不作弊条件**：不得只保留现有 dispatch 级互斥（粒度不同）；必须作用于**同会话内**的工具调度。
- **依赖与代价**：不需新依赖；触碰 Pi `tool_call` 契约；规模**中**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

#### GAP-LOOP-06 结算与超时（含 settlement 收尾）

- **能力描述**：循环结束时有**明确结算步骤**（settlement）与 turn/时长预算；预算耗尽走结算而非硬中断。（T3 `ADV-02` 指出 myflow「无收尾阶段」——本项吸收该点，不另立 `QGAP`。）
- **Norma 机制与证据**：`harness/query.go:34-38,104-127`（`Settlement`）、`:563-570,594-618`（`MaxTurns`/`MaxDuration`）；`R-T` 见 S2 分片（`H*_test.go` 未逐行读，属抽样）。
- **Pi 现状（为什么宿主不给）**：`O-5`。无 turn/时长预算（`docs/settings.md:127-133` 只有 `retry.*`）；`agent_before_settle` 仅一次续跑（`docs/extensions.md:67`）——**无硬停原语**。
- **myflow 现状**：`E-C[myflow]`（子代理墙钟 900s `sb:64,473-484`、`killChildTree`、`exitCode 124`）+ `E-G[myflow]`（verify 门控续跑 `ix:464-495`）；`R-T sbt:208,269`。**主会话无 turn/时长预算，无结算收尾**。
- **缺口判定**：`V-GAP`（主会话预算 + 结算缺席；子代理侧部分已有）。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（主会话/子代理统一的结算步骤，预算耗尽时走结算并落账；拒绝路径 = 预算耗尽后由代码阻止继续派发）。
  2. 目标**回归护栏**：`R-T`，扩展 `tests/subagent.test.ts:208-252` + 新增主会话预算用例。
  3. 行为规格：Given 主会话达到 turn 或时长预算；When 循环尝试继续；Then 触发结算并停止续跑，且结算结果可见。
  4. **不作弊条件**：不得把「子代理 900s 超时」当成主会话预算；必须是会话级预算 + 结算产物。
- **依赖与代价**：不需新依赖；触碰 Pi `agent_before_settle` 契约；规模**中**。
- **优先级**：`P2`（代价中；属核心流程但已有子代理侧部分覆盖，按 §9 不升 `P1`）。
- **证据等级**：`E1`/`E4`/`E3`。

### 1.8 `TOOL`

#### GAP-TOOL-03 工具定义 fail-closed 保守默认

- **能力描述**：工具未声明行为字段时取**保守默认**（非只读 / 非并发 / 需审批），而非乐观默认。
- **Norma 机制与证据**：`tool/tool.go:9,98-124` — `Build` 对未声明字段取保守默认。
- **Pi 现状（为什么宿主不给）**：`O-3`。仅 MCP `annotations` 有保守默认（`docs/extensions.md:165-172`）；自定义工具**无** Pi 强制默认。
- **myflow 现状**：`E-N[myflow]`（工具定义默认）+ 现存 `E-C[myflow]`（写范围 fail-closed 守卫，`ix:122-140`、`sb:452-453`）；`R-T sbt:525,554,581`（承接裁定 `C-2`）。
- **缺口判定**：`V-GAP`（工具定义层的保守默认缺席）。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（Agent 定义/工具注册解析时对未声明字段套用保守默认；拒绝路径 = 声明缺失且落到不安全取值时拒绝加载并报错）。
  2. 目标**回归护栏**：`R-T`，扩展 `tests/skills-hygiene.test.ts:120-131`（agent 三件套 frontmatter 校验）。
  3. 行为规格：Given agent md 缺 `writesUnder` 等安全字段；When 解析；Then 取保守默认（不可写/不可并行）且并行写者被拒。
  4. **不作弊条件**：不得只依赖现有 `writesUnder` 单点守卫；保守默认必须覆盖未声明的全部安全相关字段。
- **依赖与代价**：不需新依赖；仅 myflow 侧；规模**小**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

#### GAP-TOOL-06 工具输出上限与全局 net

- **能力描述**：对模型可见的工具输出有**统一上限/截断**（含 myflow 自己注册的工具），并在截断时告知模型完整输出去处。
- **Norma 机制与证据**：`tool/helpers.go:12,31,70,77`（默认 30000 头尾截断 / spill）、`harness/tools.go:104-108,126`（**全局** `capOutput` net）。
- **Pi 现状（为什么宿主不给）**：`O-2`（刻意外包）。Pi 原文：`docs/extensions.md:145`「Truncate large model-facing results and tell the model where to read the complete output.」——责任交给**工具作者**。Pi **只对其内建工具**套用共享 `truncate` 模块（`DEFAULT_MAX_LINES=2000` / `DEFAULT_MAX_BYTES` 为包公开导出：`dist/index.js:30`、`dist/core/tools/truncate.d.ts:10`），**对第三方/扩展工具无统一 net**（`research/norma-llm-tool.md §3` NEG-3，C1 `#18` 窄化措辞）。
- **myflow 现状**：`E-N[myflow]` / `R-∅`。`myflow_subagent` 的结果文本**不截断**（`sb:275-310`）。
- **缺口判定**：`V-GAP`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（对 `myflow_subagent` 及其他 myflow 注册工具的返回结果强制上限，超限截断并附完整日志路径；拒绝路径 = 超限结果不得原样进入上下文）。
  2. 目标**回归护栏**：`R-T`，扩展 `tests/subagent.test.ts`（超限结果被截断且带回 log 路径）。
  3. 行为规格：Given `myflow_subagent` 返回超上限文本；When 回传父会话；Then 结果被截断并附 `logPath`（`sb:286-310` 已有 log 机制可复用）。
  4. **不作弊条件**：不得只在提示词里写「输出请精简」；截断必须由 myflow 代码执行并可断言。
- **依赖与代价**：不需新依赖；仅 myflow 侧；规模**小**。
- **优先级**：`P0`。依据 §9：`V-GAP` ∧ 补足仅需 myflow 侧改动且代价小 ∨ 有用户可见故障风险（上下文被单次输出挤爆）。
- **证据等级**：`E1`/`E4`/`E3`。

### 1.9 `SKILL`

#### GAP-SKILL-03 skill **正文**存活于压缩（C1 拆分后收窄）

- **拆分说明（C1 `#33` 修正）**：本关注点拆为两半——**(a) roster 存活**（name+description+path 随 system section
  进 `CompactionEntry.systemMessage` checkpoint，pre-compaction system messages 被折入该 checkpoint）**已由宿主覆盖**
  （`docs/session-format.md:84,127-131,248`、`docs/skills.md:43-45`），判 `V-PI`/`O-1`，**非缺口**；**(b) 正文逐字 re-inject**
  才是本条缺口。原判 `A-NONE`/`O-5` 系检索式只查 `compaction.md` 的字面 `skill` 所致（假阴性）。
- **能力描述**：被调用过的 skill **正文**在压缩后仍能逐字恢复（而非被摘要截断），与 roster 是否存活无关。
- **Norma 机制与证据**：`compaction/compaction.go:346-350,363+`（`reinjectSkills` 逐字重放最新一次调用，预算 5000/25000）、`llm/skillmsg.go:9-56`（自识别信封）；`R-T compaction_test.go:55,84,105`。
- **Pi 现状（为什么宿主不给）**：`O-3`。宿主提供 **roster 侧**保留（system checkpoint，见上）与「扩展可拦截压缩」的原语（`docs/compaction.md:293-320`）；但**正文**（`/skill:name` 展开的 user 消息 / `read SKILL.md` 的 tool_result）被摘要，摘要序列化时还被截到 2000 字符（`docs/compaction.md:291`），**无逐字 re-inject**（`research/norma-ext-integrate.md §3` NEG-3，C1 改判）。
- **myflow 现状**：`E-N[myflow]` / `R-∅`。无 re-inject；状态注入靠 `context` 重注入（属 `CTX` 域）。
- **缺口判定**：`V-GAP`（正文 re-inject：Norma 有 ∧ Pi 无 ∧ myflow 无）。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（记录每个 skill 最近一次正文调用并在压缩后由代码重放正文；拒绝路径 = 预算超限时丢弃最旧并保留「重读 base dir」提示，不得静默丢弃全部）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/skill-reinject.test.ts`。
  3. 行为规格：Given 压缩前调用过 skill S；When 压缩后构造上下文；Then S 的**正文**被逐字重放（或有明确截断提示）。
  4. **不作弊条件**：不得依赖模型「记得去 read SKILL.md」（那是行为，非机制保证）；也不得把「roster 存活」算作本条完成（roster 已由宿主覆盖）。
- **依赖与代价**：不需新依赖；触碰 Pi 压缩/`context` 契约；规模**中**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

#### GAP-SKILL-04 解锁 skill 声明的 MCP 工具

- **能力描述**：skill 可声明其依赖的 MCP 工具集；调用该 skill 时自动解锁对应工具。
- **Norma 机制与证据**：`skill/skill.go:48-53,149-156,255-258` — frontmatter `mcps:`；调用时把对应 server 的 deferred 工具加入 `UnlockSet` 并附名单；`R-T mcps_test.go:10,28`。
- **Pi 现状（为什么宿主不给）**：`O-5`。方向相反：`allowed-tools` 是**预授权**列表（`docs/skills.md:78`）；MCP 侧由 `deferred`/`tool_search` 驱动（`docs/mcp.md:191-217`），与 skill 调用**无联动**（`research/norma-ext-integrate.md §3` NEG-4）。
- **myflow 现状**：`E-N[myflow]` / `R-∅`。8 个 `SKILL.md` 无 `mcps:`；myflow 无 MCP 集成。
- **缺口判定**：`V-GAP`。（本环境 MCP 由 `A-EXT:pi-mcp-adapter` 提供，见 `02-matrix.md §0`；补足时须与之联动，见「依赖与代价」。）
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（解析 skill frontmatter 的 `mcps:` 并在调用时由代码把对应工具加入可用集；拒绝路径 = 未声明者不解锁）。
  2. 目标**回归护栏**：`R-T`，扩展 `tests/skills-hygiene.test.ts` + 新增联动用例。
  3. 行为规格：Given skill 声明 `mcps: [server-x]`；When 调用该 skill；Then 该 server 的受限工具变为可用并附名单。
  4. **不作弊条件**：不得把现有 agent `tools:` 白名单算作解锁（那是收窄，非放开）。
- **依赖与代价**：需依赖 `A-EXT:pi-mcp-adapter` 的工具暴露面（新增核心流程 `A-EXT` 依赖 → 已在 `04-risk-register.md` 登记）；触碰 Pi skill/MCP 契约；规模**中**。另注：Pi 官方明示进程内 server 不在内建范围（`pi-mcp/README.md:132`「servers … outside the initial core」）→ 解锁目标天然落在 `A-EXT` 侧（C1 `F-5`）。
- **优先级**：`P2`。依据 §9：`V-GAP` 代价中等且依赖外部扩展。
- **证据等级**：`E1`/`E2`/`E4`。

### 1.10 `LLM`

#### GAP-LLM-04 Provider 级限流（仅限流子项）

- **能力描述**：provider 调用有共享速率限制，避免突发并发触顶。
- **Norma 机制与证据**：`llm/ratelimit.go:18`（Provider 级共享限流）、`llm/provider.go:71-92`（配置）。重试子项 Norma 亦有 `llm/retry.go:21,64,79`。
- **Pi 现状（为什么宿主不给）**：`O-1`（重试：`docs/settings.md:126-135`、`docs/rpc-commands.md:423`）+ `O-5`（**限流**无人提供；`research/norma-llm-tool.md §3` NEG-1 命中 0）。
- **myflow 现状**：`E-N[myflow]` / `R-∅`。不实现 provider 层，全委托 Pi。
- **缺口判定**：`V-GAP`（**仅限流**子项；重试子项为 `V-PI`）。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（在 myflow 派发/provider 请求前置加令牌桶；拒绝路径 = 超限时由代码排队或拒绝，不得直接放行）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/rate-limit.test.ts`。
  3. 行为规格：Given 速率窗口内已达上限；When 新请求到达；Then 被排队/拒绝并可观测。
  4. **不作弊条件**：不得只处理 429 错误（那是重试，非限流）；必须**事前**限速。
- **依赖与代价**：不需新依赖；若经 `before_provider_request` 事件则触碰 Pi provider 契约（`O-1`）；规模**中**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

### 1.11 `COORD`

#### QGAP-COORD-02 编程式扇出的有界并发与保序

- **能力描述**：编程式扇出（parallel）有并发上限、保序返回，且有 run 内预算/收尾语义。
- **Norma 机制与证据**：`coordinator/coordinator.go:41,112-116,125` — `RunParallel` 信号量限流（默认 4）+ `results[i]` 保序；`R-T coordinator_test.go:49-71`。
- **Pi 现状（为什么宿主不给）**：`O-6`（本环境由 `A-EXT:pi-subagents-lite` 提供）/ core `O-2`（`README.md:19`）。`docs/codemode.md:3` 的 parallel 指脚本内工具调用并行，非代理编排。
- **myflow 现状**：`E-C[myflow]` / `R-T sbt:389,ch:179`。`parallel` 用 `Promise.all`（`sb:673`）→ 保序；prompt 上限 6（`sb:57,633`，schema `maxItems` `:262`）；channel 并发上限 3（`channel.py:77,506`）。
- **缺口判定**：`V-QUAL`（myflow 有并发上限与保序，但**无信号量限流语义、无 run 内预算/收尾**）。
- **差距实证**：`Norma:E-C + R-T`（`coordinator.go:112-116` + `coordinator_test.go:49-71`）**vs** `myflow:E-C + R-T`（`sb:57,633,673` + `tests/subagent.test.ts:389`）——强度同层，差在无 per-run 结算（与 `GAP-LOOP-06` 同源）。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（并发以信号量而非一次性 `Promise.all` 调度；超限即排队；拒绝路径 = 超硬上限时由代码拒绝）。
  2. 目标**回归护栏**：`R-T`，扩展 `tests/subagent.test.ts:389`。
  3. 行为规格：Given 提交 10 个 prompt、上限为 6；When 执行；Then 至多 6 个在跑、其余排队，且结果按原序返回。
  4. **不作弊条件**：不得把「schema `maxItems` 上限」当成限流（那是输入校验，非运行期并发控制）。
- **依赖与代价**：不需新依赖；仅 myflow 侧；规模**中**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

### 1.12 `NOAA`

#### GAP-NOAA-03 子代理状态继承与边界

- **能力描述**：子代理继承父会话的上下文账本（块/引用/快照），并明确继承边界（上溯层数）。
- **Norma 机制与证据**：`noaadapter/inherit.go:47-108` — `DeriveChildState` 继承 Blocks/Refs/Snapshot，重置 Nudge/Stats，归档绝对路径可读，上溯 ≤8。
- **Pi 现状（为什么宿主不给）**：`O-5`。core 无子代理；`A-EXT` 子代理 `--no-session`。Pi 无账本原语。
- **myflow 现状**：`E-C[myflow]` / `R-T sbt`。仅继承任务指针（`sb:446`），无账本继承。
- **缺口判定**：`V-GAP`（账本继承缺席；任务指针继承已存在）。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（子代理启动时由代码注入父账本快照并设上溯边界；拒绝路径 = 父链超界时拒绝继承并显式降级）。
  2. 目标**回归护栏**：`R-T`，扩展 `tests/subagent.test.ts`。
  3. 行为规格：Given 父会话已有压缩账本；When 派发子代理；Then 子代理可读到父账本且在边界内可解析引用。
  4. **不作弊条件**：不得只传 `MYFLOW_CONTEXT_ID`（那是任务指针，非账本）。
- **依赖与代价**：不需新依赖；仅 myflow 侧；规模**大**（依赖 `GAP-NOA-01/02/03` 的块/ref 层）。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

#### GAP-NOAA-04 溢出学习窗口

- **能力描述**：从 provider 错误文本解析**真实上下文窗口**并据此校准压缩目标（并验证压缩后确实变小）。
- **Norma 机制与证据**：`noaadapter/overflow.go:9-57`（4 正则 + 95% ceiling）、`noaadapter/compactor.go §Reactive`（验证确实变小否则返回 false）。
- **Pi 现状（为什么宿主不给）**：`O-4`。有 overflow 压缩 + 重试序（`docs/compaction.md:39,85-96`），但**未文档化**从错误取数值窗口。
- **myflow 现状**：`E-N[myflow]` / `R-∅`。
- **缺口判定**：`V-GAP`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（解析 error 文本得窗口并校验压缩后确实变小；拒绝路径 = 未解析到窗口或压缩后未变小则放弃并上报）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/compaction.test.ts`。
  3. 行为规格：Given provider 返回含窗口数值的错误；When myflow 处理溢出；Then 目标窗口被更新，且下次压缩后使用量确实低于阈值。
  4. **不作弊条件**：不得只做固定步长缩减（必须从错误解析真实窗口）。
- **依赖与代价**：不需新依赖；触碰 Pi 压缩/provider 错误契约（`O-4`）；规模**中**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

#### GAP-NOAA-07 ref tag 渲染与剥离

- **能力描述**：ref 标签以尾部标签形式渲染给模型，且在计算内容哈希前先剥离标签（保证标签不改变身份）。
- **Norma 机制与证据**：`noaadapter/tags.go` — 尾置 `<noa-ref id="m\d{5}">`，先剥再哈希、首渲染冻结。
- **Pi 现状（为什么宿主不给）**：`O-5`。无等价机制（`research/norma-noaa-trans-core.md §4` NEG 命中 0）。
- **myflow 现状**：`E-N[myflow]` / `R-∅`。
- **缺口判定**：`V-GAP`（依赖 `GAP-NOA-01` 的 ref 层）。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（渲染前剥离标签再算身份；拒绝路径 = 标签混入哈希时拒绝发表该 ref）。
  2. 目标**回归护栏**：`R-T`，新增 `tests/context-injection.test.ts` 用例。
  3. 行为规格：Given 同一内容在两次渲染中带不同 ref 标签；When 计算身份；Then 身份一致（标签不影响）。
  4. **不作弊条件**：不得把 ref 标签直接写进持久化原文；必须只作用于发出的视图。
- **依赖与代价**：不需新依赖；仅 myflow 侧；规模**中**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

### 1.13 `TRANS`

#### GAP-TRANS-03 子代理 sidechain 分离

- **能力描述**：子代理拥有独立 transcript（sidechain），其 token 与父会话分离、可单独回溯。
- **Norma 机制与证据**：`transcript/transcript.go:59-72,146-196` — `<sid>/subagents/agent-<id>.jsonl`，token 独立。
- **Pi 现状（为什么宿主不给）**：`O-5`。core 无子代理；`A-EXT` 子代理无会话（myflow 子进程以 `--no-session` 启动，`sb:394`）。
- **myflow 现状**：`E-C[myflow]` / `R-T sbt:208`。仅原始 stdout 日志（`sb:67`），无结构化 sidechain、无 token 分离。
- **缺口判定**：`V-GAP`。
- **补足标准**：
  1. 目标**强制层级**：`E-C[myflow]`（子代理运行时由 myflow 写入独立 JSONL sidechain，含 token 用量；拒绝路径 = sidechain 写入失败时不静默丢弃，上报错误）。
  2. 目标**回归护栏**：`R-T`，扩展 `tests/subagent.test.ts:208`。
  3. 行为规格：Given 派发子代理；When 其运行；Then 生成独立 sidechain 文件，父/子 token 可分别统计。
  4. **不作弊条件**：不得把「原始 stdout 日志」算作 sidechain（无结构、无逐消息边界）。
- **依赖与代价**：不需新依赖；仅 myflow 侧；规模**中**。
- **优先级**：`P2`。
- **证据等级**：`E1`/`E4`。

---

## 2. 优先级汇总表

| 优先级 | 条目 | 数量 |
| --- | --- | --- |
| `P0` | `GAP-CTX-04`、`GAP-TOOL-06` | 2 |
| `P0-R`（风险钉住，独立成列） | `QGAP-CTX-02`（同时为 `P1`） | 1 |
| `P1` | `QGAP-CMPT-05`、`QGAP-PLAN-02`、`QGAP-CTX-02`、`GAP-NOA-07`、`GAP-NOA-08`、`GAP-PLAN-01` | 6 |
| `P2` | 其余 27 条 | 27 |
| **合计** | — | **35** |

按域计数（`GAP` + `QGAP`）：`CTX` 2、`CMPT` 3、`NOA` 7、`PERM` 5、`PLAN` 2、`MEM` 4、`LOOP` 2、`TOOL` 2、`SKILL` 2、`LLM` 1、`COORD` 1、`NOAA` 3、`TRANS` 1。

> 与 `02-matrix.md` 表 C 的对照：`V-GAP` 29（−1 合并 `PERM-05`/`PLAN-03` = 28，+1 新增 `GAP-CTX-04` = **29**，一致）；`V-QUAL` 6（不变）。

---

## 3. 后续任务拆分建议（`P0` / `P0-R`）

> 原则（`design.md` §12）：条目已是**可独立验收**的最小单元，不建议把多个 `GAP-*` 合并成一个「大而全」的实现任务——合并会破坏「字段 ↔ PRD 字段」的一对一映射，使验收标准无法逐条核对，且任一子项失败会拖垮整批交付。

| 建议 slug | 覆盖 `CAP-*` | 内容 | 预计代价 |
| --- | --- | --- | --- |
| `myflow-context-pointer-integrity` | `CAP-CTX-02`、`CAP-CTX-03`（间接） | 键在而指针缺失的告警与自愈；两侧无键回退同口径（`GAP-CTX-04`） | 小（仅 myflow 侧；新增 2 组测试） |
| `myflow-tool-output-cap` | `CAP-TOOL-06` | `myflow_subagent` 等 myflow 注册工具结果的统一上限/截断 + log 路径（`GAP-TOOL-06`） | 小（仅 myflow 侧；扩展 `tests/subagent.test.ts`） |
| `myflow-session-key-contract-pin` | `CAP-CTX-02` | 端到端断言「真会话内 `task.py current --source` == `context:pi_<getSessionId>`」+ fork 父链继承（`QGAP-CTX-02`，`P0-R`） | 小（仅 myflow 侧；扩展 `tests/task-bridge.test.ts`） |

**次优先（`P1`）建议**（供排期参考，不属于本批「必建」清单）：`myflow-compaction-injection-timing`（`QGAP-CMPT-05`）、`myflow-readonly-planning-gate`（`GAP-PLAN-01`）、`myflow-approval-state`（`QGAP-PLAN-02`）、`myflow-context-hard-protection`（`GAP-NOA-07`）、`myflow-emergency-truncation`（`GAP-NOA-08`）。

**为什么不合并成一个大任务**：`GAP-CTX-04` / `GAP-TOOL-06` / `QGAP-CTX-02` 三者虽同在「上下文承载」这一主题下，但验收路径互不相交（前者测指针缺失告警、中者测结果截断、后者测键派生等价与 fork 继承），且都只改 myflow 侧、代价小。合并会牺牲「一对一转 PRD」的可追溯性，并让「P0-R 风险钉住」与「P0 功能补足」混在同一任务里——前者是断言测试、后者是行为变更，评审标准不同。

---

## 4. 需新证据（本批未能定论的断言）

**无。** 本批全部条目与判定均可回溯到 `02-matrix.md` 或 12 个 `research/*.md` 的既有证据；两处受控偏离（`GAP-CTX-04`、`GAP-LOOP-06` 吸收 settlement）均由 T3 分片与 `02-matrix.md` §5.3 直接支持。

> 提示（非「需新证据」，属既有分片已声明的薄弱点，供 B3/B4 处理）：
> - 各 `GAP-*` / `QGAP-*` 中标注的「触碰 Pi 契约」项，其**具体契约稳定性**由 `04-risk-register.md`（B3）定稿；本册不重复论证。
> - `GAP-NOA-*` / `GAP-NOAA-*` 的规模估计为「中/大」，其背后是「从零构建分层压缩引擎」，本册未细化工作量。
> - S2/S6 分片声明的「未逐行读 Norma `*_test.go`」使部分 `R-T` 依据为「存在同名用例」，未验证断言强度（`research/myflow-enforcement-tiers.md §6`）。

## 5. 本批未写入的条目清单

**无。** 表 B 中全部 `V-GAP`（29，合并后）与 `V-QUAL`（6）条目均已按 `design.md` §8.4 模板写入本册。

> 未进入本册的结论码（依 design §5.2，非本批取材范围）：`V-PI`（32）、`V-OWNED`（7）、`V-EXT`（2）、`V-UP`（2）、`V-ADV`（4）。其中 `V-ADV` 由 `05-advantage-register.md`（B3）承载，`V-PI`/`V-EXT`/`V-UP` 由 `06-non-gaps.md`（B3）承载。
