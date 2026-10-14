# 06 — 非缺口清单（`NG-*`）与「看似缺口实际不是」专题

> **版本锚点**：myflow@`0a702fa`、Norma@`52f17dd`、Pi **1.2.0**（`E0`/`E1`/`E2`，见 `research/00-baseline.md`）。
> **判定规则**：`design.md` §5.2（`V-PI`/`V-EXT`/`V-UP`/`V-NA` 的定义与动作）、§2.2（归属域，含 `A-EXT` 分级规则）、§6（误判防呆三测）。
> **取材**：`02-matrix.md` 表 A/表 B/表 C（主索引）、`research/pi-surface-completeness.md`（T1）、`research/contract-risks-and-advantages.md`（T3）、各域分片。
> **路径前缀**同 `04-risk-register.md`。本文件不引入 12 个分片、`02-matrix.md`、`03-gap-register.md` 之外的新结论。
> **与 `03-gap-register.md` 无重复计数**：本册承载 `V-PI`/`V-EXT`/`V-UP`/`V-NA`（依 `design.md` §5.2 均记为「不补」），缺口册承载 `V-GAP`/`V-QUAL`，两者互斥。

---

## 1. `NG-*` 非缺口清单

### 1.1 `V-PI` 宿主内建（32 项）

> 判定：`A-PI` 且 `E1`/`E2` 正向命中（`O-1`）或 `O-3`（原语在 Pi、语义由 myflow 补齐）。
> **「重复造轮子」核查**：myflow 在这些行**一律记 `E-N[myflow]`、完全委托 Pi**，**未重复实现任何宿主能力**（`02-matrix.md §3.3`）。

| # | 能力项 | 域 / 归属码 | 归属证据 `[v1.2.0]` | 为什么不补 | 重复造轮子核查 |
| --- | --- | --- | --- | --- | --- |
| `NG-01` | `CAP-LLM-01` 多协议归一 | `A-PI` / `O-1` | `docs/models.md:45-63`、`docs/custom-provider.md:7-18` | Pi 已给；myflow 不实现 provider 层 | 未重复（`sb:395-399` 只传 `--model`） |
| `NG-02` | `CAP-LLM-02` 流式增量归一 | `A-PI` / `O-1` | `docs/message-types.md:118-141` | 同上 | 未重复 |
| `NG-03` | `CAP-LLM-03` provider 无关消息模型 | `A-PI` / `O-1` | `docs/message-types.md:118-134,161-175` | 同上 | 未重复 |
| `NG-04` | `CAP-TOOL-01` 注册表 | `A-PI` / `O-1` | `docs/extensions.md:135-183`、`pi-coding-agent.d.ts:49,55` | Pi 已给 `registerTool()`；myflow 用其注册 1 个工具 | 未重复（`sb:573` 是**注册动作**，非自建 Registry，`02-matrix.md §5.2 C-1`） |
| `NG-05` | `CAP-TOOL-02` 参数 schema 校验 | `A-PI` / `O-1` | `docs/extensions.md:135,149` | Pi 已给 TypeBox/argument validation | 未重复 |
| `NG-06` | `CAP-TOOL-04` 延迟工具 | `A-PI` / `O-1` | `docs/extensions.md:153-160`、`docs/cli.md:156,182` | Pi 已给 `exposure:"deferred"` + `tool_search` | 未重复（myflow 未用，也非缺口） |
| `NG-07` | `CAP-TOOL-05` 核心工具集 | `A-PI` / `O-1` | `docs/settings.md:46` | Pi 已给内建工具；myflow 经 `--tools` 收窄 | 未重复 |
| `NG-08` | `CAP-LOOP-01` 循环迭代协议 | `A-PI` / `O-1` | `docs/how-pi-works.md:9-13`、`docs/json.md:37-58` | Pi 已给内建循环与事件流 | 未重复 |
| `NG-09` | `CAP-CMPT-03` PTL 反应式恢复 | `A-PI` / `O-1` | `docs/compaction.md:39,85` | Pi 已给 overflow / `stopReason:"length"` → compact-and-retry | 未重复（myflow 委托 Pi） |
| `NG-10` | `CAP-CMPT-04` 非破坏 boundary | `A-PI` / `O-1` | `docs/compaction.md:79,152`、`docs/sessions.md:40` | Pi 已给 `CompactionEntry`+`firstKeptEntryId`，原文不删 | 未重复 |
| `NG-11` | `CAP-NOA-05` turn 完整性 | `A-PI` / `O-3` | `docs/message-types.md:42-50`、`docs/compaction.md:130-136` | Pi 以**消息粒度 + 只切整条消息**等价覆盖；任务粒度够用 | 未重复（myflow 不自建，靠 Pi 切割规则） |
| `NG-12` | `CAP-NOA-06` tool pair 完整性 | `A-PI` / `O-1` | `docs/compaction.md:130-136` | Pi 明示「Never cut at tool results」等价覆盖 | 未重复 |
| `NG-13` | `CAP-NOA-10` 归档与 state 持久化 | `A-PI` / `O-1` | `docs/sessions.md:40` | Pi 原文永不删、可回溯；目标等价 | 未重复 |
| `NG-14` | `CAP-NOA-11` 常驻提示词（机制） | `A-PI` / `O-1` | `docs/session-format.md:80,134`、`docs/cli.md:231` | Pi 已给 system prompt section 机制且**存活于压缩**；myflow 机制上可用（用法偏弱，见 `GAP-*`/`QGAP-*` 未涉及项） | 未重复；主会话未用 `--append-system-prompt` 属**用法**问题，非缺口 |
| `NG-15` | `CAP-NOAA-01` 接管 `ContextView` | `A-PI` / `O-1` | `docs/extensions.md:114-116` | Pi 已给 `context` / `context_with_system` 钩子 | 未重复（`ix:340-392` 用 `context`） |
| `NG-16` | `CAP-NOAA-02` 内容哈希身份 | `A-PI` / `O-1` | `docs/session-format.md:54-59,141-147` | Pi entry 写入期有稳定 `id/parentId`，`context_edit` 按 `targetId` 定位 | 未重复（myflow 未用 `context_edit`） |
| `NG-17` | `CAP-NOAA-05` `materialize` 无状态降级 | `A-PI` / `O-1` | `docs/session-format.md:141-147,226-233` | Pi 派生视图持久化于 session，resume 即生效 | 未重复 |
| `NG-18` | `CAP-NOAA-06` 工具输出压缩（建时） | `A-PI` / `O-1` | `docs/codemode.md:43`、`docs/mcp.md:232` | Pi 内建工具各自有界。**注意**：跨工具统一 net 仍是 `GAP-TOOL-06`，本行只判「建时上限已给」 | 未重复 |
| `NG-19` | `CAP-TRANS-01` append-only JSONL | `A-PI` / `O-1` | `docs/session-format.md:3,11,141-147` | Pi JSONL + entry 树，原始 entry 不删 | 未重复 |
| `NG-20` | `CAP-TRANS-02` 冷启动重建压缩后视图 | `A-PI` / `O-3` | `docs/session-format.md:226-233` | Pi `buildContextEntries` 取最新 compaction + `firstKeptEntryId` | 未重复 |
| `NG-21` | `CAP-TRANS-04` 边界与工作集语义 | `A-PI` / `O-1` | `docs/session-format.md:128-147` | Pi boundary/summary/编辑均为持久 entry | 未重复 |
| `NG-22` | `CAP-CORE-01` `Session` 抽象 | `A-PI` / `O-1` | `docs/sdk.md:44-52` | Pi 已给 `SessionManager` | 未重复 |
| `NG-23` | `CAP-CORE-02` 一次性 `Run` | `A-PI` / `O-1` | `docs/json.md:9,26` | Pi 已给 `pi --mode json -p` | 未重复 |
| `NG-24` | `CAP-CORE-03` 转录与恢复 | `A-PI` / `O-1` | `docs/sessions.md:7,50-54` | Pi 默认自动存会话 | 未重复 |
| `NG-25` | `CAP-CORE-04` `Resume` | `A-PI` / `O-1` | `docs/sessions.md:10-14` | Pi 已给 `--continue/--resume`；子代理故意 `--no-session` | 未重复 |
| `NG-26` | `CAP-HOOK-01` 生命周期回调集合 | `A-PI` / `O-1` | `docs/extensions.md:96-128`、`types.d.ts:1186-1228` | Pi `pi.on()` **41** 事件（C1 `F-1` 更正原记 42），myflow 注册 7 个 | 未重复（myflow 注册的 7 个是**自有事件接线**，非重建 Pi 事件系统） |
| `NG-27` | `CAP-HOOK-02` 可 block | `A-PI` / `O-1` | `docs/extensions.md:263`、`types.d.ts:1089-1098` | Pi `tool_call`→`{block,reason}` + handler 抛错 fail-safe | 未重复（myflow 用它实现守卫，`ix:420-453`） |
| `NG-28` | `CAP-HOOK-03` 可改写/注入 | `A-PI` / `O-1` | `types.d.ts:1090,1114-1120,1125-1129,786-795` | Pi 已给原地改 input / `before_agent_start.message` / `tool_result` 改写 / `entries+continue` | 未重复 |
| `NG-29` | `CAP-HOOK-04` Stop 门控 | `A-PI` / `O-1`（无硬停原语） | `docs/extensions.md:67,118`、`types.d.ts:796-805` | Pi 已给 `agent_before_settle` 一次续跑；语义等价 | 未重复 |
| `NG-30` | `CAP-MCP-02` 进程内 server | `A-PI` / `O-3` | `docs/extensions.md:133-151,163` | Pi 无该概念，但 `registerTool()`+`namespace` 可替代（非缺口） | 未重复 |
| `NG-31` | `CAP-SKILL-01` `SKILL.md` + frontmatter | `A-PI` / `O-1` | `docs/skills.md:5,70-78,85` | Pi 实现 agentskills.io 规范 | 未重复；myflow 用自家测试**加固**（`ADV-09`，`sh:29-65`） |
| `NG-32` | `CAP-SKILL-02` 按需注入 | `A-PI` / `O-1` | `docs/skills.md:43-47`、`docs/how-pi-works.md:19-21` | Pi 已给「system prompt 公告 + 模型 `read` 正文」 | 未重复；myflow 自建物是 agent `tools:` 白名单（收窄），非重建 listing |

> **脚注（`NG-04a`，`CAP-LLM-04` 的子项）**：`CAP-LLM-04` 整行在 `02-matrix.md` 表 C 计为 **`V-GAP`**（**限流**子项无人提供，已由 `GAP-LLM-04` 承载）；
> 其**重试**子项为 `V-PI`（Pi 已给 `retry.*`，`docs/settings.md:126-135`、`docs/rpc-commands.md:423`），myflow 委托 Pi、未重复。此处单列以避免口径混淆。

### 1.2 `V-EXT` 用户级扩展已给（2 项）

> 判定：`A-EXT` 命中、`A-PI` 未命中（`O-6`）。依 `design.md` §2.2：`A-EXT` 能力**不得**记为 `V-PI`，只记 `V-EXT`。
> 动作：记录 + 检核心流程依赖 → 触发 `RISK-*`（本册 §2 与 `04-risk-register.md §5` 已承接）。

| # | 能力项 | 域 / 归属码 | 归属证据 | 为什么不补 |
| --- | --- | --- | --- | --- |
| `NG-33` | `CAP-MCP-01` stdio JSON-RPC 客户端 | `A-EXT:pi-mcp-adapter`（core 有但停用）/ `O-6`（core `O-1`） | `~/.pi/agent/settings.json` 的 `extensions:["-builtin:mcp"]` + `pi-mcp-adapter/pi-builtin-mcp.ts:10-25`、`index.ts:1725`；`docs/mcp.md:264`「Replace the built-in MCP support」 | 扩展已接管；myflow **无 MCP 集成**（`sb:69` 仅注释），不构成 myflow 缺口。若未来 `GAP-SKILL-04` 补足将新增此依赖 → 已在 `04-risk-register.md §5` 标注 |
| `NG-34` | `CAP-MCP-03` 工具暴露与命名 | `A-EXT:pi-mcp-adapter` / `O-6`（core `O-1`） | `pi-mcp-adapter/namespace-tools.ts:12-18`、`mcp-references.ts:38-40`；`docs/mcp.md:77,191-217,225` | 同上 |

### 1.3 `V-UP` 上游约束（2 项）

> 判定：只能改 Pi 才能补 → 登记 `UP-*`，**不列为缺口**（`design.md` §5.2）。

| # | 能力项 | 约束内容 | 证据 `[v1.2.0]` | 为什么不补 | 上游依赖登记 |
| --- | --- | --- | --- | --- | --- |
| `NG-35` | `CAP-LOOP-03` tool pair 配对（运行期孤儿修复） | Pi 以「禁切 tool result」**预防**孤儿（`docs/compaction.md:136`），但**无运行期孤儿修复**；myflow 不用 `context_edit`，未触发该场景 | `docs/compaction.md:130-136`、`docs/message-types.md:161-169` | 修复原语在 Pi 执行器内；myflow 补不了，只能靠 Pi 或避免使用 `context_edit` | 已在 `02-matrix.md` 表 B #18 记 `V-UP`；若未来 myflow 使用 `context_edit`，转为 `RISK-*` 候选（`research/norma-noa-integrity.md §4`） |
| `NG-36` | `CAP-LOOP-04` 终止原因建模（「为何续跑」） | Pi 有 `stopReason` 7 值（`docs/message-types.md:134`），但**无 ContinueReason 建模**；myflow 只**只读** `agent_before_settle.outcome`（`ix:472-473`） | `docs/message-types.md:134`、`docs/extensions.md:67` | 需要在 Pi 循环内部暴露「续跑原因」，属宿主行为 | 已在 `02-matrix.md` 表 B #19 记 `V-UP`；myflow 不补 |

### 1.4 `V-NA` 场景无关（0 项）

**无。** `02-matrix.md` 表 C 的 `V-NA` 计数为 **0**（没有任何条目被判「与 myflow 场景无关」）。

### 1.5 计数与对账

| 结论码 | 本册条数 | `02-matrix.md` 表 C | 对账 |
| --- | --- | --- | --- |
| `V-PI` | **32**（`NG-01..NG-32`） | 32 | ✅ 一致（`CAP-LLM-04` 整行计 `V-GAP`，其重试子项作 `NG-04a` 脚注单列） |
| `V-EXT` | **2**（`NG-33..NG-34`） | 2 | ✅ 一致 |
| `V-UP` | **2**（`NG-35..NG-36`） | 2 | ✅ 一致 |
| `V-NA` | **0** | 0 | ✅ 一致 |
| **合计** | **36** | 36 | ✅ |

---

## 2. 「看似缺口实际不是」专题（8 项）

> 这些是最容易被误判为「宿主或 myflow 缺了 X」的条目。每项写清「为什么看起来像缺口 / 实际归属 / 证据 / 误判后果」。
> 判据来源为 `design.md` §6 的误判防呆三测（测 A 卸载测试 / 测 B 归属方向 / 测 C 自证 vs 推断）。

### MIS-01 `Agent`/`StopAgent`/`MessageAgent`/`AgentStatus` 看起来像 Pi 内建子代理

- **为什么像缺口**：四个工具名都直接叫「代理」，且从**会话内部**看与 Pi core 工具**融合**在同一个工具表里；若误判为 `A-PI`，则 `CAP-SUB-*` 会被记为「非缺口」，myflow 的 `myflow_subagent` 就成了「重复造轮子」。
- **实际归属**：**`A-EXT:pi-subagents-lite`**（v1.17.0），既非 `A-PI` 也非 `A-MF`。
- **证据**：`~/.pi/agent/npm/node_modules/pi-subagents-lite/src/registration.ts:66,121,132,143`（四个 `name:` 字面量）+ `:112,129,140,149`（`pi.registerTool`）；`(NEG)` 卸载测试确认唯一注册者（`research/norma-sub-coord.md` NEG-3，命中仅该包）。
- **误判后果**：`CAP-SUB-*` 被错误记为「宿主已给」，**恰好掩盖真缺口**（`design.md` §3.5 的认知陷阱）。故 `02-matrix.md §0` 专列归属表钉死。

### MIS-02 MCP 工具看起来像 Pi 内建

- **为什么像缺口**：Pi 1.2.0 **确实有**内建 MCP（`docs/mcp.md` 全篇：stdio+HTTP、OAuth、resources、`pi mcp` CLI），因此极易记为 `A-PI`。
- **实际归属**：本环境内建 MCP 被 `settings.json` 的 `extensions:["-builtin:mcp"]` **显式关闭**，由 **`A-EXT:pi-mcp-adapter`** 接管；配置载体为 `A-PI` 文件 ∪ `A-EXT` 文件。
- **证据**：`~/.pi/agent/settings.json`；`pi-mcp-adapter/pi-builtin-mcp.ts:10-25`、`index.ts:1725`；`docs/mcp.md:264`「Replace the built-in MCP support」。
- **误判后果**：把「扩展接管」记成「宿主内建」，从而**低估**卸载/上游改动风险（`04-risk-register.md §5` 的 `A-EXT` 专节正是为此设立）。

### MIS-03 `cbmem.ts` 注册的裸名工具（`search_graph` 等 15 个）看起来像 MCP

- **为什么像缺口**：工作区 `AGENTS.md` 里那串裸名工具（`search_graph`/`trace_path`/`get_code_snippet`…）与 `~/.pi/agent/mcp.json` 的 `codebase-memory-mcp` **同名同源**，容易记为「MCP 提供」。
- **实际归属**：**`A-EXT`**（`~/.pi/agent/extensions/cbmem.ts:1-60` 用 `spawn` 直接调 `codebase-memory-mcp.exe cli`，把裸名工具注册为 Pi 工具），**与 MCP 路径无关**。两条链证据俱在，两者**均**应记 `A-EXT`。
- **证据**：`cbmem.ts:1-60`；`research/norma-ext-integrate.md` F2。**C3 复核**：分片 `research/norma-plan-mem.md §0` 曾把 `cbmem.ts` 误记为 `A-MCP`（同分片 NEG-3 亦同），与源码（`spawn` 直调 exe、无 MCP 协议）及本判冲突；已按源码判定 `A-EXT` 并修正该分片。
- **误判后果**：把 `A-EXT` 记成 `A-MCP`（或 `A-PI`），污染 `MCP` 域归属与依赖分析。

### MIS-04 `AGENTS.md` 的「persistent instructions」看起来像长期记忆

- **为什么像缺口**：Pi `docs/quickstart.md:108` 称 `AGENTS.md` 为 "persistent instructions"；且 `AGENTS.md` 内容跨会话存在，直觉上像 Norma 的 `memory`。
- **实际归属**：`AGENTS.md`/context files 是**宿主注入的静态文件**（`docs/configuration.md:18`），由**人**维护、无条件全量加载；**不是** agent 自累积、带召回与陈旧告警的长期记忆。故 `CAP-MEM-*` 不能因 `AGENTS.md` 存在而记为「已给」。
- **证据**：`docs/configuration.md:18,45`、`docs/quickstart.md:108`；`research/norma-plan-mem.md` NEG-2（Pi 无 memory store）。
- **误判后果**：`GAP-MEM-03/04`（召回 / 陈旧告警）会被误判为已覆盖。

### MIS-05 `myflow-research` 的递归守卫「看起来只是提示词」

- **为什么像缺口/误判**：`PRD Q3` 曾把 `myflow-research` 的递归守卫判为 agent md 里的**提示词文字**，并据此论证「名义有、实际靠约定」。
- **实际归属**：**`E-C[myflow]`**（`ix:420-432` 的 `tool_call` 对子代理调用 `myflow_subagent` 返回 `{block:true}`）+ **`E-G[myflow→Pi]`**（`.pi/agents/myflow-research.md:5` 的 `tools:` 白名单经 `--tools` 交 Pi 硬门控）；`R-T`（`tests/subagent.test.ts:434-454`、`tests/skills-hygiene.test.ts:133`）。是 myflow 少数「文字 + 白名单 + 代码**三层**」的样板。
- **证据**：`research/norma-sub-coord.md §1`、`research/contract-risks-and-advantages.md §4`、`research/myflow-enforcement-tiers.md §4`；`02-matrix.md §5.2 C-8`。
- **误判后果**：把已达 `E-C` 的机制降级为 `E-P`，既高估缺口、又错失「照此升级其他条目」的可复用样板。**修正**：真正「名义有但仅靠提示词」的反例应改指 `PLAN-01`（只读仅文字）、`MEM-03`（召回仅文字）、`MEM-02`（索引人工维护）及 T2 §2 的 `P3`/`P5`。

### MIS-06 Pi `docs/` 里没有 plan mode 字样 → 看起来判不出 `O-2`

- **为什么像缺口**：`docs/` 40 篇**逐篇检索**均无 `plan mode` 字样（`research/norma-ext-integrate.md` NEG、`research/norma-plan-mem.md` NEG-1），只扫 `docs/` 会判「无依据」而无法定 `O-2`。
- **实际归属**：`O-2`（刻意外包）的**唯一权威原文在包根 `README.md:19`**：「Pi ships with powerful defaults but skips features like **sub-agents and plan mode**」。这正是 `docs` 的覆盖缺口（T1 §4）。
- **证据**：`README.md:19`（`research/norma-ext-integrate.md` F3、`research/pi-surface-completeness.md §4`）。
- **误判后果**：若不查包根 README，`PLAN-01`/`PLAN-02` 会被误记为 `O-5`（双方皆无）而非 `O-2`，从而错判「宿主是否刻意推给扩展层」——这是 `design.md` §5.1 对 `O-2` 要求引原文的直接动机。

### MIS-07 `noa`/`noaadapter`/`transcript` 未出现在 README Packages 表 → 看起来像示例代码

- **为什么像缺口**：`Norma/README.md` 的「Packages」表只列 13 个包，这三个目录**未列出**；若按 README 定义语料范围，会判「不在对比范围」。
- **实际归属**：它们是**实现包**（非示例）：`noa/` 5392 行、`noaadapter/` 1918 行、`transcript/` 268 行，合计约占全仓非测试代码 20%；`noa` 恰是 myflow 最该对照的 `CTX` 域。
- **证据**：`research/00-baseline.md §5`（逐目录文件计数）；`design.md` ADR-7；`prd.md`「语料修正」。
- **误判后果**：**系统性跳过**最关键的对比对象（`noa` 的 ref/tier/nudge/完整性）。故 AC 从「覆盖 13 包」改为「覆盖 **16 个实现包**」（README 13 + noa + noaadapter + transcript）。

### MIS-08 `.myflow/agents/{architect,reviewer}.md` 看起来是 `myflow_subagent` 的 agent 类型

- **为什么像缺口**：仓库里同时存在 `.pi/agents/` 与 `.myflow/agents/` 两套 agent md，且都被描述为「代理定义」，容易认为 `myflow_subagent` 能派发 `.myflow/agents/` 里的 `architect`/`reviewer`。
- **实际归属**：`myflow_subagent` 的 agent 发现**只扫 `.pi/agents/`**（`ag:228-243`）；`.myflow/agents/` 由 **`channel.py`** 读取（`channel.py:35,75`）用于 channel peer worker。
- **证据**：`research/norma-ext-integrate.md §6`「⚠ 易混淆」；`agents.ts:228-243`、`channel.py:35,75`。
- **误判后果**：会误判「myflow 有两套代理体系」或「派发路径混乱」，从而在缺口分析中引入不存在的能力/缺口。

---

## 3. 需新证据 / 未完成

**需新证据：无。** 本册 `NG-*` 全部条目取自 `02-matrix.md` 表 B/表 C 的既有判定与各域分片的归属证据；
8 个 MIS 条目均取自分片已有的归属判定与 `NEG` 块，未引入新证据。

**未完成：无。** `V-PI`（32）+ `V-EXT`（2）+ `V-UP`（2）+ `V-NA`（0）= **36** 项全部登记，计数与表 C 对账一致；
「看似缺口实际不是」专题写了 **8** 项（≥ PRD 要求的 3 项）。
