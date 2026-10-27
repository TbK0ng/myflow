# 02 — 能力归属矩阵与 myflow 承担度

> **版本锚点**：myflow@`0a702fa`、Norma@`52f17dd`、Pi **1.2.0**（`E0`/`E1`/`E2`，见 `research/00-baseline.md`）。
> **判定规则**：`design.md` §2.2 归属域、§4 强制层级/回归、§5 归属码/结论码、§7 ID、§8.2/8.3/8.7。
> **数据来源**：12 个 research 分片（S1–S8、T1–T3）+ `00-baseline.md`。**本文件不引入分片外的新结论**。
> **路径前缀**：Pi 证据省略前缀 `~/.bun/install/global/node_modules/@earendil-works/`；`docs/…` 即
> `pi-coding-agent/docs/…`，`dist/…` 即 `pi-coding-agent/dist/…`。Norma 证据省略前缀 `../Norma/`；
> myflow 证据省略前缀 `.pi/extensions/myflow/`（`ix`=index、`sb`=subagent、`ci`=context-injection、
> `tc`=turn-cache、`st`=status、`ag`=agents），测试省略前缀 `tests/`。
> **符号**：`E-C` 代码强制 / `E-G` 门控 / `E-P` 提示词 / `E-N` 无；`R-T` 有测试 / `R-∅` 无。

---

## 0. 关键归属判定（先读，防止域码错配）

| 名称 | 域码 | 注册者证据 |
| --- | --- | --- |
| `Agent` / `StopAgent` / `MessageAgent` / `AgentStatus` | **`A-EXT:pi-subagents-lite`**（非 `A-PI`、非 `A-MF`） | `~/.pi/agent/npm/node_modules/pi-subagents-lite/src/registration.ts:66,121,132,143`（`name:` 字面量）+ `:112,129,140,149`（`pi.registerTool`）；版本 1.17.0 |
| `myflow_subagent` | `A-MF` | `sb:573-574` |
| MCP 工具（`mcp__*`、代理） | `A-EXT:pi-mcp-adapter`（本环境） | `~/.pi/agent/settings.json` 的 `extensions:["-builtin:mcp"]` + `cc`→`pi-builtin-mcp.ts:10-25`、`index.ts:1725`（S7 F1） |
| `codebase-memory` 15 个裸名工具（`search_graph` 等） | `A-EXT`（`cbmem.ts`，非 MCP、非 core） | `~/.pi/agent/extensions/cbmem.ts:1-60`（S7 F2） |
| `bash`（本环境） | `A-PI` 原语，被 `A-EXT:pi-rounded-tools` 重注册 | `pi-rounded-tools/extensions/rounded-tools.ts:38-47,286-294`（须转发 `shellPath`，见 RISK-04） |
| 核心工具 `read/write/edit/bash/grep/find/ls` | `A-PI` | `docs/extensions.md §Tools`、`docs/settings.md:46` |

> 本表是表 A「归属域」列的判据来源；凡表 A 中出现 `A-EXT` 的行均以此为准。

---

## 1. 表 A — 能力归属矩阵（design.md §8.2）

覆盖 design.md §7.2 全部 **19 域 / 82 个 `CAP-*`**。每格证据均为 `路径:行号` 或 `路径 §小节`。

| # | 能力项 | Norma 机制 | Norma 证据 | Pi 1.2.0 现状 | Pi 证据 `[v1.2.0]` | 归属域 | 归属码 |
|---|---|---|---|---|---|---|---|
| 1 | `CAP-LLM-01` 多协议归一 | `Format` 三值 anthropic/openai/openai-responses；归一消息模型 | `llm/provider.go:43,47`、`llm/types.go:32,69` | 多端点协议配置；自定义协议走 provider 扩展 | `docs/models.md:45-63`、`docs/custom-provider.md:7-18` | `A-PI` | `O-1` |
| 2 | `CAP-LLM-02` 流式增量归一 | 归一事件 + SSE 分帧 + 增量装配 | `llm/provider.go:16,30`、`llm/sse.go:15`、`llm/accumulate.go:12,26` | 增量流 + `stopReason:"pending"`；custom stream 须 emit 归一终止事件 | `docs/message-types.md:118-141`、`docs/custom-provider.md:126-135` | `A-PI` | `O-1` |
| 3 | `CAP-LLM-03` provider 无关消息模型 | `ContentBlock` 联合(text/thinking/tool_use/tool_result) + `Usage` | `llm/types.go:24-67,102` | `AssistantMessage.content:(Text/Thinking/ToolCall)[]`、`ToolResultMessage` | `docs/message-types.md:118-134,161-175` | `A-PI` | `O-1` |
| 4 | `CAP-LLM-04` 重试/限流/SSE 容错 | 建连重试 + Provider 级共享限流 | `llm/retry.go:21,64,79`、`llm/ratelimit.go:18`、`llm/provider.go:71-92` | agent 级重试 `retry.*` + 429/5xx transient；**无限流**（S1 NEG-1） | `docs/settings.md:126-135`、`docs/rpc-commands.md:423` | `A-PI` | `O-1`（限流= `O-5`） |
| 5 | `CAP-TOOL-01` 注册表 | 有序 name-indexed `Registry`；`CoreTool` | `tool/registry.go:6-44`、`tool/tool.go:85` | `registerTool()` + `exposure`/active set | `docs/extensions.md:135-183`、`pi-coding-agent.d.ts:49,55` | `A-PI` | `O-1` |
| 6 | `CAP-TOOL-02` 参数 schema 校验 | JSON-Schema 子集，调用前强制 | `tool/schema.go:10-72`、`harness/tools.go:42-43` | TypeBox `parameters`；nested 走 argument validation | `docs/extensions.md:135,149` | `A-PI` | `O-1` |
| 7 | `CAP-TOOL-03` fail-closed 默认 | `Build` 未声明字段取保守默认 | `tool/tool.go:9,98-124` | 仅 MCP `annotations` 有保守默认；自定义工具**无** Pi 强制 | `docs/extensions.md:165-172` | `A-PI`(部分) | `O-3` |
| 8 | `CAP-TOOL-04` 延迟工具 | schema 扣留 + `SearchExtraTools`/`ExecuteExtraTool` + `UnlockSet` | `tool/deferred.go:18-30,32-76,102,221` | `exposure:"deferred"` + `tool_search` | `docs/extensions.md:153-160`、`docs/cli.md:156,182` | `A-PI` | `O-1` |
| 9 | `CAP-TOOL-05` 核心工具集 | `DefaultTools()` 9 个 | `tool/registry.go:62-68` | 内建 `read,bash,powershell,edit,write,grep,find,ls` + codemode/tool_search | `docs/settings.md:46` | `A-PI` | `O-1` |
| 10 | `CAP-TOOL-06` 工具输出上限与截断 | 默认 30000 头尾截断/spill + **全局** `capOutput` net | `tool/helpers.go:12,31,70,77`、`harness/tools.go:104-108,126` | 内建工具各自有界；**无跨工具 net**，截断责任交给工具作者（S1 NEG-3） | `docs/codemode.md:43`、`docs/mcp.md:232`、`docs/compaction.md:291`、`docs/extensions.md:145` | `A-PI`(内建) | `O-2` |
| 11 | `CAP-PERM-01` allow/deny/ask | 三态 + 建议回传 | `permission/permission.go:18-31` | 无逐调用审批；审批被点名外包 | `docs/security.md:3`、`docs/extensions.md:167,176`、`docs/mcp.md:252` | `A-NONE` | `O-2` |
| 12 | `CAP-PERM-02` mode 系统(6 种) | 6 种 mode | `permission/permission.go:51-58` | 无 mode，仅进程 allowlist | `docs/cli.md:120-122`、`docs/settings.md:42` | `A-NONE` | `O-5` |
| 13 | `CAP-PERM-03` deny 优先 | Stage1 先于 mode/bypass | `permission/permission.go:85-90,145-158` | 无规则表；`--exclude-tools` 无优先级 | `docs/cli.md:121-122` | `A-NONE` | `O-5` |
| 14 | `CAP-PERM-04` 四阶段 `Evaluate` | 4 阶段权限管线 | `permission/permission.go:85-140` | 无核心求值器，扩展在 `tool_call` 自建；**决策点由 core 提供**（`tool_call`→`{block,reason}`） | `docs/extensions.md:169-178`、`:170-178` | `A-NONE` | `O-2` |
| 15 | `CAP-PERM-05` 中途切换模式 | 逐调用重读 `PermissionModeFunc` | `harness/tools.go:47-49`、`harness/query.go:75` | 原语 `pi.setActiveTools()`，无 mode 语义 | `docs/extensions.md:163-165,185-189` | `A-PI`(原语) | `O-3` |
| 16 | `CAP-LOOP-01` 循环迭代协议 | `iter.Seq2` + 事件 | `harness/query.go:201-208`、`harness/event.go:8-29` | 内建 agent 循环 + 事件流 | `docs/how-pi-works.md:9-13`、`docs/json.md:37-58` | `A-PI` | `O-1` |
| 17 | `CAP-LOOP-02` 只读并行/写串行 | FIFO + 排他，缺省不安全 | `harness/streaming.go:9-18,59-84`、`tool/tool.go:140-152` | 无调度器；同消息工具可并行；**但** core 提供互斥原语 `withFileMutationQueue()` 与 `readOnlyHint`/`destructiveHint` 注解 | `docs/extensions.md:124,143-144,167,172-174`、`docs/mcp.md:254` | `A-PI(原语)` | `O-3` |
| 18 | `CAP-LOOP-03` tool pair 配对 | 丢未配对块 + 中断合成 | `harness/streaming.go:124-180`、`harness/tools.go:57-64` | 有配对结构；中断合成未文档化 | `docs/message-types.md:161-169`、`docs/json.md:58` | `A-PI`(部分) | `O-3` |
| 19 | `CAP-LOOP-04` 终止原因建模 | 11 `TerminalReason` + 7 `ContinueReason` | `harness/event.go:32-58` | `stopReason` 7 值；无「为何续跑」 | `docs/message-types.md:134` | `A-PI`(部分) | `O-3` |
| 20 | `CAP-LOOP-05` 取消传播 | `ctx`/`toolCtx` + 中断合成 | `harness/query.go:379-389`、`harness/streaming.go:124-165` | SDK/RPC/扩展层均有 abort 原语 | `docs/sdk.md:70`、`docs/rpc-commands.md:513`、`docs/extensions.md:126` | `A-PI` | `O-1` |
| 21 | `CAP-LOOP-06` 结算与超时 | `Settlement` + `MaxTurns`/`MaxDuration` | `harness/query.go:34-38,104-127,563-570,594-618` | 无 turn/时长预算；`agent_before_settle` 一次续跑 | `docs/settings.md:127-133`、`docs/extensions.md:67` | `A-NONE` | `O-5` |
| 22 | `CAP-SUB-01` 复用主循环 + 隔离环境 | 同 `harness.Query`，带 System/Messages/Tools/MaxTurns/PermissionMode + `filterTools` | `subagent/subagent.go:5-8,120-135,161` | core 无子代理；有 `createAgentSession` 原语，无 sidechain | `README.md:19`、`docs/sdk.md:8,28` | `A-EXT:pi-subagents-lite` / `A-NONE`(core) | `O-6` / `O-2` |
| 23 | `CAP-SUB-02` 递归深度守卫 | 代码 `depth>=MaxDepth` → `tool.Errorf`，默认 3 | `subagent/subagent.go:54,84` | core 无；`pi-subagents-lite` 永不嵌套 | `docs/extensions.md:106,170-178`；`pi-subagents-lite/agent-types.ts:196-197` | `A-EXT` / `A-PI`(原语) | `O-6` / `O-2` |
| 24 | `CAP-SUB-03` 结果回传 | 终态文本 → `tool.Text` | `subagent/subagent.go:88-95` | core 无；`agent_settled` 可观测 | `docs/extensions.md:67-68` | `A-EXT` | `O-6` |
| 25 | `CAP-COORD-01` LLM 驱动 Agent 工具 | `AgentTool()` 复用 subagent + `SystemSegment()` 注入「不直接实现」 | `coordinator/coordinator.go:81-99` | core 无并明示跳过 | `README.md:19`、`docs/packages.md:21` | `A-EXT` / `A-PI`(明示 `O-2`) | `O-6` / `O-2` |
| 26 | `CAP-COORD-02` 编程式扇出 | `RunParallel` 信号量限流 + 保序 | `coordinator/coordinator.go:41,112-116,125` | core 无并行代理编排 | `docs/codemode.md:3` | `A-EXT` | `O-6`（core `O-2`） |
| 27 | `CAP-CMPT-01` 多级压缩策略 | Micro(清旧工具结果,keep5)/Auto/Reactive 三层 | `compaction/compaction.go:62,69,173,249,295` | 阈值 AutoCompact + overflow/length 恢复，共 2 层 | `docs/compaction.md:32,37,39` | `A-PI` | `O-3` |
| 28 | `CAP-CMPT-02` 熔断 | `maxAutoCompactFails=3` + `tripped` 连败停压 | `compaction/compaction.go:69,304` | 仅 `session_compact_failed` 遥测；已有**有界单次恢复重试**，无连败计数熔断 | `docs/compaction.md:372,39` | `A-PI(原语)` | `O-3` |
| 29 | `CAP-CMPT-03` prompt-too-long 反应式恢复 | Reactive 复用 Auto + 摘要 PTL 重试(≤3, 丢最老 20%) | `compaction/compaction.go:200,212`、`compaction/summarizer.go:14,151` | overflow / `stopReason:"length"` → 一次 compact-and-retry | `docs/compaction.md:39,85` | `A-PI` | `O-1` |
| 30 | `CAP-CMPT-04` 非破坏 boundary | 留全历史，tail 前插 boundary+summary | `compaction/compaction.go:295,344` | `CompactionEntry`+`firstKeptEntryId`，原文不删 | `docs/compaction.md:79,152`、`docs/sessions.md:40` | `A-PI` | `O-1` |
| 31 | `CAP-CMPT-05` 压缩与注入共存语义 | summary 后逐条重注入 skill 原文(5k/25k) | `compaction/compaction.go:349,370` | `custom_message` 是合法切割点，Pi 不重注入扩展消息 | `docs/compaction.md:130,134` | `A-PI` + `A-MF` | `O-3` |
| 32 | `CAP-NOA-01` ref 寻址 | `mNNNNN` 永不重编号 + BLOCKED 硬保护 + 双向 map | `noa/refs.go:15,25,74,78`、`noa/const.go:5,12` | 模型无 ref；仅 Pi entry id 可经 `context_edit.targetId` 定位 | `docs/session-format.md:143,235` | `A-NONE` | `O-5` |
| 33 | `CAP-NOA-02` tier 分层（一次一层） | tier 创建即固定；终层重写检测 | `noa/tier.go:22,30,78`、`noa/types.go:56,61`、`noa/config.go:105` | 单层；重复压缩靠 `previousSummary` 迭代 | `docs/compaction.md:83` | `A-NONE` | `O-5` |
| 34 | `CAP-NOA-03` block 与 rebuild | `bN` 块 + 原子尺寸门 + 回放得字节一致摘要 | `noa/compress.go:77,225`、`noa/state.go:38`、`noa/rebuild.go:37,45` | 无块模型，摘要落 `CompactionEntry`，原文留 JSONL | `docs/compaction.md:79`、`docs/session-format.md:226` | `A-NONE` | `O-5` |
| 35 | `CAP-NOA-04` nudge 节律 | 双波段成长节律 + 压缩后重锚 + tier 独立节律 | `noa/nudge.go:11,20,56,114,206,300`、`noa/config.go:99-116` | 无压缩 nudge，只有阈值自动压缩与 `/compact` | `docs/compaction.md:32,37,41` | `A-NONE` | `O-5` |
| 36 | `CAP-NOA-05` turn 完整性 | `TurnGroup`=reasoning+acts+results，撤整轮不拆半 | `noa/turnintegrity.go:12,33,75`、`noa/prune.go:78,225,269`、`noa/compress.go:405` | 消息粒度天然保护；切点只落整条 user/assistant 消息 | `docs/message-types.md:42-50`、`docs/compaction.md:130-136` | `A-PI` | `O-3` |
| 37 | `CAP-NOA-06` tool pair 完整性 | 边界双向扩张 + 定点两轮 + prune 双侧孤儿剥离 + 硬保护配对 | `noa/toolpairs.go:12,56,91`、`noa/const.go:40`、`noa/prune.go:154-210`、`noa/protected.go:61-77` | 切割点禁则「Never cut at tool results」+ length 合成失败 result | `docs/compaction.md:130-136,39` | `A-PI` | `O-1` |
| 38 | `CAP-NOA-07` 硬保护 vs 软保护 | 硬: `AlwaysProtectedTools`+`cfg.ProtectedTools`；软: `PreserveRecentMessages/Tokens` | `noa/const.go:54`、`noa/protected.go:13,33,74`、`noa/compress.go:371-377,381-400`、`noa/config.go:115-116` | 无**命名**工具硬保护；仅软尾部 `keepRecentTokens`。**但有原语**：`session_before_compact` 可自选 `firstKeptEntryId` | `docs/compaction.md:82,443,302-320,138` | `A-PI(原语)` | `O-3` |
| 39 | `CAP-NOA-08` 紧急截断标记 | 使用率≥.95 对最大未截断 tool result 保头尾+插标记，只改发出的 | `noa/truncate.go:12-15,35,108`、`noa/processturn.go:87-88`、`noa/nudgetext.go:132`、`noa/config.go:109` | 建时每工具上限；**运行期原语** `context_edit` 可 append-only 改写已存 tool-result（只改未来 model context、原文不变），可由 `turn_end`/`agent_before_settle` 链式追加；缺**压力触发判定** | `docs/codemode.md:12,43`、`docs/mcp.md:232`、`docs/session-format.md:143-147,235`、`docs/extensions.md:118` | `A-PI(原语)` | `O-3` |
| 40 | `CAP-NOA-09` 压缩建议与死区 | `BuildRecommendation` + `ViableRanges`(<200 token 死区) + 死区重复拒绝 | `noa/recommend.go:256,267`、`noa/const.go:31,43` | 无对模型暴露的压缩建议面 | （S4 §2 NEG-A/B 命中 0） | `A-NONE` | `O-5` |
| 41 | `CAP-NOA-10` 归档与 state 持久化 | `state.json`(版本守卫+原子写) + tier 原子归档 + `reuseArchiver` 不覆盖 + 回放兜底 | `noaadapter/state_store.go`、`noa/archive.go`、`noaadapter/materialize.go` | 原文永不删可回溯；无「摘要块↔归档文件」产物 | `docs/sessions.md:40` | `A-PI` | `O-1` |
| 42 | `CAP-NOA-11` 常驻提示词 | 常驻 system 段只收 3 条永久规则，一次性指令随 nudge 走 | `noa/prompts_system.go:10-35,104`、`noa/nudgetext.go:20,30` | system prompt section 机制；`--append-system-prompt`；压缩写 system checkpoint，system 段存活于压缩 | `docs/session-format.md:80,134`、`docs/message-types.md:107`、`docs/cli.md:231`、`docs/compaction.md:125` | `A-PI` | `O-1` |
| 43 | `CAP-NOAA-01` 接管 `ContextView`/`Compactor` | `Compactor` 实现 Pre/View/IsOverflow/Reactive；`Enable` 三件套同生共死 | `noaadapter/noa.go:8-46` | `context` 改消息、`context_with_system` 独占 transcript | `docs/extensions.md:114-116` | `A-PI` | `O-1` |
| 44 | `CAP-NOAA-02` 内容哈希身份 | `DeriveMessageID`(sha256) + `ClusterCounter` | `noaadapter/identity.go:23-57` | entry 写入期稳定 id/parentId；`context_edit` 按 `targetId` | `docs/session-format.md:54-59,141-147` | `A-PI` | `O-1` |
| 45 | `CAP-NOAA-03` 子代理状态继承与边界 | `DeriveChildState` 继承 Blocks/Refs/Snapshot，上溯≤8 | `noaadapter/inherit.go:47-108` | core 无子代理；A-EXT 子代理 `--no-session` | `docs/sessions.md`；`sb:394` | `A-NONE` | `O-5` |
| 46 | `CAP-NOAA-04` 溢出学习窗口 | 从错误文本解析真实窗口(4 正则)+95% ceiling，Reactive 验证确实变小 | `noaadapter/overflow.go`、`noaadapter/compactor.go §Reactive` | 有 overflow 压缩+重试序；**未文档化**从错误取数值窗口 | `docs/compaction.md:39,85-96` | `A-PI`(部分) | `O-4` |
| 47 | `CAP-NOAA-05` `materialize` 无状态降级 | 纯函数(幂等/可逆/不写 transcript) | `noaadapter/materialize.go` | 派生视图持久化于 session，resume 即生效 | `docs/session-format.md:141-147,226-233` | `A-PI` | `O-1` |
| 48 | `CAP-NOAA-06` 工具输出压缩 | 溢出落盘+头部指针；截断计数 | `agentcore/agentcore.go:155-160`、`noaadapter/session.go` | bash 2000 行/50KB、>1MiB 留首尾+`full_output_path`；MCP >20KB 去中间 | `docs/codemode.md:43`、`docs/mcp.md:232` | `A-PI` | `O-1` |
| 49 | `CAP-NOAA-07` ref tag 渲染与剥离 | 尾置 `<noa-ref id="m\d{5}">`，先剥再哈希、首渲染冻结 | `noaadapter/tags.go` | 无等价机制 | （S5 §4 NEG 命中 0） | `A-NONE` | `O-5` |
| 50 | `CAP-TRANS-01` append-only JSONL | `Record{uuid,parent_uuid,session_id,agent_id,is_sidechain}` + O_APPEND | `transcript/transcript.go:1-11,38-47,74-94` | JSONL + entry 树，原始 entry 不删 | `docs/session-format.md:3,11,141-147` | `A-PI` | `O-1` |
| 51 | `CAP-TRANS-02` 冷启动重建压缩后视图 | `Messages()` 跳 boundary；`RebuildFromHistory` 回放，摘要字节一致 | `transcript/transcript.go`、`noa/rebuild.go:45` | `buildContextEntries` 取最新 compaction+`firstKeptEntryId` | `docs/session-format.md:226-233` | `A-PI` | `O-3` |
| 52 | `CAP-TRANS-03` 子代理 sidechain 分离 | `<sid>/subagents/agent-<id>.jsonl`，token 独立 | `transcript/transcript.go:59-72,146-196` | core 无子代理；A-EXT 子代理无会话 | （core 无） | `A-NONE` | `O-5` |
| 53 | `CAP-TRANS-04` 边界与工作集持久化语义 | `RecordBoundary` 仅观测、重建跳过；工作集不落盘 | `transcript/transcript.go:128-137,208-216` | boundary/summary/编辑均为持久 entry | `docs/session-format.md:128-147` | `A-PI` | `O-1` |
| 54 | `CAP-CORE-01` `Session` 抽象 | `Session.Prompt` 可重复、状态跨调用 | `agentcore/agentcore.go §Session` | `SessionManager` | `docs/sdk.md:44-52` | `A-PI` | `O-1` |
| 55 | `CAP-CORE-02` 一次性 `Run` | `Run(ctx,opts,input)` | `agentcore/agentcore.go §Run` | `pi --mode json -p` | `docs/json.md:9,26` | `A-PI` | `O-1` |
| 56 | `CAP-CORE-03` 转录与恢复 | `Options.Transcript/SessionID` | `agentcore/agentcore.go:163-169` | 默认自动存会话 | `docs/sessions.md:7,50-54` | `A-PI` | `O-1` |
| 57 | `CAP-CORE-04` `Resume` | `Resume`+`cleanResumed` 丢弃未落盘尾 tool_use | `agentcore/agentcore.go §Resume` | `--continue/--resume` | `docs/sessions.md:10-14` | `A-PI` | `O-1` |
| 58 | `CAP-HOOK-01` 生命周期回调集合(8 个) | 8 点 `Registry` | `hook/hook.go:17-25,29,41` | `pi.on()` **41** 事件 | `docs/extensions.md:96-128`、`dist/core/extensions/types.d.ts:1186-1228` | `A-PI` | `O-1` |
| 59 | `CAP-HOOK-02` 可 block | `Decision=="block"`；首个 block 即停，以 error tool_result 回给模型 | `hook/hook.go:57,89-98`、`harness/tools.go:78-80` | `tool_call`→`{block,reason}`；handler 抛错亦 fail-safe 阻塞 | `docs/extensions.md:263`、`dist/core/extensions/types.d.ts:1089-1098` | `A-PI` | `O-1` |
| 60 | `CAP-HOOK-03` 可改写/注入 | `UpdatedInput` + `AdditionalContext` + Stop block 注入续跑 | `hook/hook.go:89-98,115-131,135-143` | 改 `event.input`；`before_agent_start→{message}`；`tool_result` 换 content；`turn_end`/`agent_before_settle`→`entries+continue` | `dist/core/extensions/types.d.ts:1090,1114-1120,1125-1129,786-795` | `A-PI` | `O-1` |
| 61 | `CAP-HOOK-04` Stop 门控 | `PreventContinuation` 硬停 vs `block` 续跑；`stopHookActive` 防死循环 | `hook/hook.go:115-131`、`harness/query.go:472-478` | `agent_before_settle` 最后可动作边界，一次续跑；`agent_settled` 纯通知 | `docs/extensions.md:67,118`、`dist/core/extensions/types.d.ts:796-805` | `A-PI` | `O-1`（无硬停原语） |
| 62 | `CAP-MCP-01` stdio JSON-RPC 客户端 | JSON-RPC 2.0 换行分帧 + `NewStdioClient` + 权限 `AskUser` | `mcp/mcp.go:179-208`、`mcp/stdio.go:32,41-43` | core **有**内建 stdio+HTTP/OAuth/resources；本环境 `-builtin:mcp` **关闭**，由 A-EXT 接管 | `docs/mcp.md:9-31,32,111,141,232,236,264`；`~/.pi/agent/settings.json` | `A-EXT:pi-mcp-adapter`（core 有但停用） | `O-6`（core `O-1`） |
| 63 | `CAP-MCP-02` 进程内 server | `InProcessServer` 把 Pi 函数适配为 `mcp__<server>__<tool>` | `mcp/mcp.go:21,34-57` | 无此概念；等价物 `pi.registerTool()`+namespace 分组。官方明示 server 侧不在内建范围 | `docs/extensions.md:133-151,163`、`pi-mcp/README.md:132` | `A-PI` | `O-3` |
| 64 | `CAP-MCP-03` 工具暴露与命名 | 三段式 `mcp__<server>__<tool>` | `mcp/mcp.go:21` | 同名三段式 + 四档 `exposure` + `--tools 'mcp__x__*'`；本环境由 A-EXT 自建代理 | `docs/mcp.md:77,191-217,225`；`pi-mcp-adapter/namespace-tools.ts` | `A-EXT:pi-mcp-adapter`（core 有但停用） | `O-6`（core `O-1`） |
| 65 | `CAP-SKILL-01` `SKILL.md` + frontmatter | YAML 头 + 坏头降级不丢 skill | `skill/skill.go:207-245,248-293` | agentskills.io 规范；坏文件**不加载**，同名保留首个并警告 | `docs/skills.md:5,70-78,85` | `A-PI` | `O-1` |
| 66 | `CAP-SKILL-02` 按需注入 | `Skill` 工具：listing 常驻，正文作独立 user 消息，listing 预算 8000 字符**永不丢弃** | `skill/skill.go:94-96,100-163,174-201` | 启动放 name+description+path 进 system prompt；正文由模型 `read` 按需加载 | `docs/skills.md:43-47`、`docs/how-pi-works.md:19-21`、`docs/settings.md:158` | `A-PI` | `O-1` |
| 67 | `CAP-SKILL-03` 存活于压缩 | `reinjectSkills` 逐字重放边界前每个 skill 最新一次调用，预算 5000/25000 | `compaction/compaction.go:346-350,363+`、`llm/skillmsg.go:9-56` | **Pi 给一半**（C1 修正）：roster（name+description+path）经 `sections.skills` 随 `CompactionEntry.systemMessage` checkpoint 存活于压缩；**正文**无逐字 re-inject（摘要时截 2000 字符） | `docs/session-format.md:84,127-131,248`、`docs/skills.md:43-45`、`docs/compaction.md:130-136,291`（S7 NEG-3，C1 改判；与 `CAP-NOA-11` 的 system checkpoint 判定对齐） | `A-PI(部分)` | `O-3` |
| 68 | `CAP-SKILL-04` 解锁 skill 声明的 MCP 工具 | frontmatter `mcps:`；调用时把 deferred 工具加入 unlock 集合并附名单 | `skill/skill.go:48-53,149-156,255-258` | 方向相反：`allowed-tools` 是预授权列表；MCP 侧由 deferred/tool_search 驱动，与 skill **无联动** | `docs/skills.md:78`、`docs/mcp.md:191-217`（S7 NEG-4） | `A-PI`(部分) | `O-5` |
| 69 | `CAP-PLAN-01` 只读探索阶段 | `EnterTool`；只读由权限层**代码**强制 | `plan/plan.go:81-98`、`permission/permission.go:52,100-103` | core 无（`README.md` 明示跳过）；原语充足；随包示例**未装载** | `README.md:19`、`docs/extensions.md:106,165,170-178,187,263` | `A-NONE` | `O-2` |
| 70 | `CAP-PLAN-02` `ExitPlanMode`+审批门 | `Approver` 回调；拒绝则 `tool.Errorf` 且留在 plan | `plan/plan.go:100-144` | 无内建；审批原语 `before_agent_start` 改 prompt/工具 | `docs/extensions.md:104` | `A-NONE` | `O-2` |
| 71 | `CAP-PLAN-03` 中途权限翻转 | approve→target；每轮经 `PermissionModeFunc` 读取 | `plan/plan.go:68-72`、`agentcore/agentcore.go:269-276` | 无常驻 mode；扩展可在 `tool_call` 动态放行/阻断 | `docs/extensions.md:170-178` | `A-NONE` | `O-2`（依赖 PERM） |
| 72 | `CAP-MEM-01` frontmatter markdown 存储 | `parseFrontmatter`/`renderFrontmatter` + `Save` 自动重建索引 | `memory/memory.go:1-6,103-118,146-196` | 无 memory store；最近似纯文本 context file / skills frontmatter | `docs/configuration.md:18,45`、`docs/cli.md:224,231`、`docs/skills.md:24,67` | `A-NONE` | `O-5` |
| 73 | `CAP-MEM-02` `MEMORY.md` 索引 | `Index`/`rebuildIndex`/`buildIndex`，每次 `Save` 自动重建 | `memory/memory.go:119-145` | 无索引文件；skills 仅靠 `description` 供发现 | `docs/skills.md:53,85` | `A-NONE` | `O-5` |
| 74 | `CAP-MEM-03` 相关度选择与自动注入 | `score`(name×3/desc×2/body×1)+recency；自动注入 `MaxInject` 默认 3 | `memory/relevant.go:31-83`、`agentcore/agentcore.go:223,438-445`、`memory/tools.go:20-96` | 无相关性召回：skills 由模型自选；context files 无条件全量加载 | `docs/skills.md:45`、`docs/configuration.md:18` | `A-NONE` | `O-5` |
| 75 | `CAP-MEM-04` 陈旧告警 | `Age`+`stalenessNote`(>48h 附 point-in-time note) | `memory/relevant.go:85-108,115-132` | 无（无 memory 即无陈旧概念） | （S8 NEG-2） | `A-NONE` | `O-5` |
| 76 | `CAP-CTX-01` 状态注入的持久与恢复 | 每会话 `state.json` + `RebuildStateFromLog` 冷启动重建 | `noaadapter/state_store.go:74-90,131-152`、`noaadapter/materialize.go:9-30,73-84` | `custom_message` 参与 LLM context 但是合法压缩切点；压缩可被扩展拦截 | `docs/session-format.md:178`、`docs/compaction.md:134,293-320` | `A-PI`(原语)/`A-MF`(语义) | `O-3` |
| 77 | `CAP-CTX-02` 会话身份↔任务指针绑定 | 账本带 sessionId；子会话 `DeriveChildState` 换 id 继承，父链回溯 | `noaadapter/state_store.go:16-27`、`noaadapter/inherit.go:29-36,63-84` | id 来自 `sessionManager.getSessionId()`；bash 侧 `PI_SESSION_ID`；`/fork`·`/clone` 新会话新 id，`/tree` 同文件 | `pi-coding-agent.d.ts:16-18`、`docs/environment-variables.md:20-31`、`docs/session-format.md:72-75`、`docs/sessions.md:20-26` | `A-PI` | `O-3` / `O-4` |
| 78 | `CAP-CTX-03` 注入预算与降级 | 分层压缩 + 溢出学习窗 + `OnWarn` | `noa/tier.go`、`noaadapter/overflow.go:9-57` | 无「注入预算」，只有压缩阈值 | `docs/compaction.md:43-49` | `A-MF` | `O-5` |
| 79 | `CAP-OBS-01` 状态可观测 | 无对应目录（跨切面） | — | 无工作流状态等价物（`/session`、UsageEntry 为用量账目，非阶段状态；T1 P12） | `docs/rpc-commands.md:526-560`、`docs/session-format.md:113-128` | `A-MF` | `O-5` |
| 80 | `CAP-OBS-02` 子代理日志与可追溯 | 无对应目录（跨切面） | — | core 无子代理；A-EXT 给结果文本 + 可选 log | `pi-subagents-lite/README.md:219-221` | `A-MF` | `O-5` |
| 81 | `CAP-TEST-01` 自查/门禁（verify gate） | 无对应目录（跨切面） | — | 无 Pi verify 门 | — | `A-MF` | `O-5` |
| 82 | `CAP-TEST-02` harness 自身回归 | 无对应目录（跨切面） | — | 无 Pi 等价 | — | `A-MF` | `O-5` |

**覆盖自检**：19 域 / 82 项（`LLM`4 + `TOOL`6 + `PERM`5 + `LOOP`6 + `SUB`3 + `COORD`2 + `CMPT`5 + `NOA`11 + `NOAA`7 + `TRANS`4 + `CORE`4 + `HOOK`4 + `MCP`3 + `SKILL`4 + `PLAN`3 + `MEM`4 + `CTX`3 + `OBS`2 + `TEST`2）。
满足 AC：Norma 16 个实现包全覆盖；`NOA`≥9（实为 11）、`NOAA`≥5（实为 7）、`TRANS`≥3（实为 4）。

---

## 2. 表 B — myflow 承担度与强度（design.md §8.3）

> 「强制层级」标出**施加强制者**：`E-C[myflow]`、`E-G[myflow→Pi]`、`E-N[myflow]`（有效 Pi 强制括注 `(有效=E-*[Pi])`）。
> 「优先级」按 `design.md` §9 规则给出的**初判**，最终以 `03-gap-register.md`（B2）为准；
> `P0-R` 依据 `research/contract-risks-and-advantages.md` 的 `RISK-*` 码，最终以 `04-risk-register.md`（B3）为准。

| # | 能力项 | myflow 现状 | myflow 证据 | 强制层级 | 回归 | 与 Norma 强度差 | 结论码 | 优先级 |
|---|---|---|---|---|---|---|---|---|
| 1 | `CAP-LLM-01` | 不实现 provider 层，全委托 Pi | `sb:395-399` | `E-N[myflow]`(有效 `E-C[Pi]`) | `R-∅` | 无自有协议层，无可比实现 | `V-PI` | 不补 |
| 2 | `CAP-LLM-02` | 同上 | `sb:395-399` | `E-N[myflow]`(有效 `E-C[Pi]`) | `R-∅` | 同上 | `V-PI` | 不补 |
| 3 | `CAP-LLM-03` | 同上 | `sb:395-399` | `E-N[myflow]`(有效 `E-C[Pi]`) | `R-∅` | 同上 | `V-PI` | 不补 |
| 4 | `CAP-LLM-04` | 无重试/限流；Pi 提供重试，限流无人（S1 NEG-1） | `sb:395-399` | `E-N[myflow]` | `R-∅` | 限流子项 Pi 与 myflow 皆无；重试子项 `V-PI` | `V-GAP`(限流) / `V-PI`(重试) | P2 |
| 5 | `CAP-TOOL-01` | 无自有注册表；经 `pi.registerTool` 注册 1 个工具 | `sb:573` | `E-N[myflow]`（注册动作 `E-C[myflow]`）**[分片冲突 T2×S1]** | `R-T sbt:167` | 无 Registry 抽象 | `V-PI` | 不补 |
| 6 | `CAP-TOOL-02` | 无参数校验 | — | `E-N[myflow]` | `R-∅` | 无 | `V-PI` | 不补 |
| 7 | `CAP-TOOL-03` | 无工具定义保守默认；有 `writesUnder` fail-closed 写范围守卫 | `ix:122-140`、`sb:452-453` | `E-N[myflow]`（写范围门 `E-C[myflow]`）**[分片冲突 T2×S1]** | `R-T sbt:525,554,581` | 缺 Norma 式保守默认 | `V-GAP` | P2 |
| 8 | `CAP-TOOL-04` | 未用 `deferred`/`tool_search` | — | `E-N[myflow]` | `R-∅` | 无 | `V-PI` | 不补 |
| 9 | `CAP-TOOL-05` | 无自有工具集；白名单经 `--tools` 下发 | `sb:403`、`.pi/agents/myflow-research.md:5` | `E-G[myflow→Pi]` | `R-T sh:133` | 无 | `V-PI` | 不补 |
| 10 | `CAP-TOOL-06` | `myflow_subagent` 结果**不截断** | `sb:275-310` | `E-N[myflow]` | `R-∅` | 缺全局 net；Pi 已把责任外包给工具作者 | `V-GAP` | **P0**（仅需 myflow 侧改动、代价小） |
| 11 | `CAP-PERM-01` | 无 ask，仅硬 block | `ix:420-452` | `E-N[myflow]` | `R-∅` | 无 | `V-GAP` | P2 |
| 12 | `CAP-PERM-02` | 无 mode；代替法=agent `tools:` 经 `--tools` 由 Pi 强制 | `sb:403` | `E-G[myflow→Pi]` | `R-T sh:133` | 无 mode 语义 | `V-GAP` | P2 |
| 13 | `CAP-PERM-03` | 无规则表；单条硬 deny=`writesUnder` | `ix:116,420-452` | `E-C[myflow]` | `R-T sbt:456,525,554,581` | 有单条 deny，无 deny 优先级表 | `V-GAP` | P2 |
| 14 | `CAP-PERM-04` | 无 | — | `E-N[myflow]` | `R-∅` | 无 | `V-GAP` | P2 |
| 15 | `CAP-PERM-05` | 未用 `setActiveTools` | — | `E-N[myflow]` | `R-∅` | 无 | `V-GAP` | P2 |
| 16 | `CAP-LOOP-01` | 依赖 Pi 循环 | — | `E-N[myflow]`(有效 `E-C[Pi]`) | `R-∅` | 无 | `V-PI` | 不补 |
| 17 | `CAP-LOOP-02` | dispatch 级写者互斥（无界写者禁并行） | `sb:636-648` | `E-C[myflow]` | `R-T sbt:308,334` | 仅 dispatch 粒度，无消息级只读/写调度 | `V-GAP` | P2 |
| 18 | `CAP-LOOP-03` | 依赖 Pi 切割/配对，无校验 | — | `E-N[myflow]`(有效 `E-C[Pi]`) | `R-∅` | 只能靠 Pi | `V-UP` | 不补 |
| 19 | `CAP-LOOP-04` | 只读 `agent_before_settle.outcome` | `ix:472-473` | `E-G[myflow]` | `R-∅` | 只读 Pi 终态，无自有建模 | `V-UP` | 不补 |
| 20 | `CAP-LOOP-05` | `signal`+`timeoutMs` 杀进程树 | `sb:456-476,527-538,545` | `E-C[myflow]` | `R-∅` | 子代理取消有代码强制 | `V-OWNED` | 不补 |
| 21 | `CAP-LOOP-06` | 墙钟 900s 杀进程/exit124/留日志；verify 门控续跑 | `sb:64,473-484,519`、`ix:464-495` | `E-C[myflow]` / `E-G[myflow]` | `R-T sbt:208,269` | 仅子代理与 verify；主会话无 turn/时长预算 | `V-GAP` | P2 |
| 22 | `CAP-SUB-01` | 单/并行/链子代理；子进程带隔离 prompt/工具 | `sb:394,403,431,573` | `E-C[myflow]` | `R-T sbt:415` | myflow 有独立实现且带隔离（带 log 更强） | `V-OWNED` | 不补 |
| 23 | `CAP-SUB-02` | `tool_call` 命中 `myflow_subagent` 即 block + frontmatter `tools:` | `ix:420-432`、`sb:403` | `E-C[myflow]` + `E-G[myflow→Pi]` | `R-T sbt:434-454,sh:133` | ≥ Norma（文字+白名单+代码三层） | `V-OWNED` | 不补 |
| 24 | `CAP-SUB-03` | 取最后 assistant text + exitCode/log 回报 | `sb:322-331,425-440` | `E-C[myflow]` | `R-T sbt:208` | 带 log 路径，更强 | `V-OWNED` | 不补 |
| 25 | `CAP-COORD-01` | `parallel`/`chain` + channel peer worker | `sb:672-706`、`.pi/skills/myflow-channel/SKILL.md:33-46` | `E-C[myflow]` | `R-T sbt:389` | durable log 为额外优势 | `V-OWNED` | 不补 |
| 26 | `CAP-COORD-02` | `Promise.all` 保序；prompt 上限 6；channel 并发 3 | `sb:57,262,633,673`、`channel.py:77,506` | `E-C[myflow]` | `R-T sbt:389,ch:179` | 无 Norma 式信号量限流语义 | `V-QUAL` | P2 |
| 27 | `CAP-CMPT-01` | 全委托 Pi（2 层），无 Micro 层 | — | `E-N[myflow]`(有效 `E-C[Pi]`) | `R-∅` | 缺 Micro 层（清旧工具结果） | `V-GAP`(Micro) / `V-PI`(其余) | P2 |
| 28 | `CAP-CMPT-02` | 无熔断 | — | `E-N[myflow]`(有效 `E-C[Pi]`) | `R-∅` | 缺连败熔断 | `V-GAP` | P2 |
| 29 | `CAP-CMPT-03` | 委托 Pi | — | `E-N[myflow]`(有效 `E-C[Pi]`) | `R-∅` | — | `V-PI` | 不补 |
| 30 | `CAP-CMPT-04` | 委托 Pi | — | `E-N[myflow]`(有效 `E-C[Pi]`) | `R-∅` | — | `V-PI` | 不补 |
| 31 | `CAP-CMPT-05` | 每回合重注入 + `lastInjectionTs>lastCompactionTs` 重挂 + 缺失扫描 | `ix:319-338,384-406,455-457` | `E-C[myflow]` | `R-T ext:224` | 有补偿但依赖 Pi 事件时序 | `V-QUAL` | P1（核心流程：状态注入） |
| 32 | `CAP-NOA-01` | 无 | — | `E-N[myflow]` | `R-∅` | — | `V-GAP` | P2 |
| 33 | `CAP-NOA-02` | 无 | — | `E-N[myflow]` | `R-∅` | — | `V-GAP` | P2 |
| 34 | `CAP-NOA-03` | 无 | — | `E-N[myflow]` | `R-∅` | — | `V-GAP` | P2 |
| 35 | `CAP-NOA-04` | 无压缩 nudge | — | `E-N[myflow]` | `R-∅` | — | `V-GAP` | P2 |
| 36 | `CAP-NOA-05` | 无自身机制，靠 Pi 消息粒度 | — | `E-N[myflow]` | `R-∅` | 任务粒度够用 | `V-PI` | 不补 |
| 37 | `CAP-NOA-06` | 无自身机制，靠 Pi 禁切 tool result | — | `E-N[myflow]` | `R-∅` | — | `V-PI` | 不补 |
| 38 | `CAP-NOA-07` | 无工具级硬保护/尾部保护 | — | `E-N[myflow]` | `R-∅` | 上下文完整性缺口 | `V-GAP` | P1 |
| 39 | `CAP-NOA-08` | 无上下文级紧急阀；`ci` 截断仅作用于**注入的 task 文件** | `ci:22-26,250-256` | `E-N[myflow]` | `R-∅`（邻近 `cit`，C1 `F-3` 统一口径） | 模型工具输出无紧急阀（Pi 给原语、无触发） | `V-GAP` | P1 |
| 40 | `CAP-NOA-09` | 无 | — | `E-N[myflow]` | `R-∅` | — | `V-GAP` | P2 |
| 41 | `CAP-NOA-10` | 无自建账本/归档 | — | `E-N[myflow]` | `R-∅` | Pi 原文可回溯，等价 | `V-PI` | 不补 |
| 42 | `CAP-NOA-11` | 子代理 system prompt 经 `--append-system-prompt`；主会话**无常驻** myflow 提示词 | `sb:427-431`、`ix:319-337` | `E-C[myflow]` | `R-T ext` | 机制 Pi 已给，主会话未用 | `V-PI`（机制）/ 用法偏弱 | P2 |
| 43 | `CAP-NOAA-01` | `context` 注入 | `ix:340-392` | `E-C[myflow]` | `R-T ext:110,203` | — | `V-PI` | 不补 |
| 44 | `CAP-NOAA-02` | 无 | — | `E-N[myflow]` | `R-∅` | — | `V-PI` | 不补 |
| 45 | `CAP-NOAA-03` | 仅继承任务指针 | `sb:446` | `E-C[myflow]` | `R-T sbt` | 无账本继承 | `V-GAP` | P2 |
| 46 | `CAP-NOAA-04` | 无 | — | `E-N[myflow]` | `R-∅` | — | `V-GAP` | P2 |
| 47 | `CAP-NOAA-05` | 无 | — | `E-N[myflow]` | `R-∅` | — | `V-PI` | 不补 |
| 48 | `CAP-NOAA-06` | 无 | — | `E-N[myflow]` | `R-∅` | — | `V-PI` | 不补 |
| 49 | `CAP-NOAA-07` | 无 | — | `E-N[myflow]` | `R-∅` | — | `V-GAP` | P2 |
| 50 | `CAP-TRANS-01` | 无 | — | `E-N[myflow]` | `R-∅` | 靠 Pi JSONL | `V-PI` | 不补 |
| 51 | `CAP-TRANS-02` | 无 | — | `E-N[myflow]` | `R-∅` | 靠 Pi | `V-PI` | 不补 |
| 52 | `CAP-TRANS-03` | 仅原始 stdout 日志 | `sb:67` | `E-C[myflow]` | `R-T sbt:208` | 无 sidechain token 分离 | `V-GAP` | P2 |
| 53 | `CAP-TRANS-04` | 无 | — | `E-N[myflow]` | `R-∅` | 靠 Pi | `V-PI` | 不补 |
| 54 | `CAP-CORE-01` | 无自有 `Session` | — | `E-N[myflow]`(有效 `E-C[Pi]`) | `R-∅` | — | `V-PI` | 不补 |
| 55 | `CAP-CORE-02` | 无自有 `Run` | — | `E-N[myflow]`(有效 `E-C[Pi]`) | `R-∅` | — | `V-PI` | 不补 |
| 56 | `CAP-CORE-03` | 无自有转录接线 | — | `E-N[myflow]`(有效 `E-C[Pi]`) | `R-∅` | — | `V-PI` | 不补 |
| 57 | `CAP-CORE-04` | 无自有 `Resume`；子代理 `--no-session` | `sb:394` | `E-N[myflow]`(有效 `E-C[Pi]`) | `R-∅` | — | `V-PI` | 不补 |
| 58 | `CAP-HOOK-01` | 注册 **7** 个 Pi 事件 | `ix:273,302,319,340,420,455,464` | `E-C[myflow]` | `R-T ext:166-168` | 覆盖充分；无 `SubagentStart` 等价 | `V-PI` | 不补 |
| 59 | `CAP-HOOK-02` | `tool_call` 递归 + 写范围守卫返回 `{block,reason}` | `ix:420-453` | `E-C[myflow]` | `R-T sbt:434,456,525` | 等价/更强 | `V-PI` | 不补 |
| 60 | `CAP-HOOK-03` | `before_agent_start` message + `context` 替换 + `agent_before_settle` custom_message | `ix:319-338,340-418,478-500` | `E-C[myflow]` | `R-T ext` | 等价 | `V-PI` | 不补 |
| 61 | `CAP-HOOK-04` | verify 门控 `myflow-check` 至通过，有界重试 | `ix:464-500` | `E-C[myflow]` | `R-T ext:285,318,356` | Pi 亦无硬停原语 | `V-PI` | 不补 |
| 62 | `CAP-MCP-01` | 无 MCP 集成 | `sb:69`（仅注释） | `E-N[myflow]` | `R-∅` | — | `V-EXT`（本环境）/ `V-PI`(core 有但停用) | 不补（登记 A-EXT 核心依赖 → `RISK-*`） |
| 63 | `CAP-MCP-02` | 无 | — | `E-N[myflow]` | `R-∅` | 直接 `registerTool` 替代 | `V-PI` | 不补 |
| 64 | `CAP-MCP-03` | 无 | — | `E-N[myflow]` | `R-∅` | — | `V-EXT`（本环境）/ `V-PI`(core 有但停用) | 不补 |
| 65 | `CAP-SKILL-01` | 8 个 `SKILL.md` 仅 `name`/`description`；结构卫生由测试锁定 | `sh:29-65` | `E-C[myflow]` | `R-T sh:29,54` | 强于 Pi（Pi 仅警告） | `V-PI` | 不补 |
| 66 | `CAP-SKILL-02` | 依赖 Pi 按需加载；自建物是 agent/prompt 解析 `tools:` | `ag:164-171` | `E-C[Pi]`(加载) + `E-G[myflow]`(白名单) | `R-T sh` | — | `V-PI` | 不补 |
| 67 | `CAP-SKILL-03` | 无 re-inject；状态靠 `context` 重注入（属 `CTX`）；roster 侧由 Pi checkpoint 承担 | — | `E-N[myflow]` | `R-∅` | 缺**正文**逐字 re-inject（roster 已由 Pi 覆盖） | `V-GAP` | P2 |
| 68 | `CAP-SKILL-04` | 无（无 `mcps:`，无 MCP） | — | `E-N[myflow]` | `R-∅` | 缺 | `V-GAP` | P2 |
| 69 | `CAP-PLAN-01` | 无只读阶段代码守卫；仅文字 | `.pi/skills/myflow-brainstorm/SKILL.md:9-13` | `E-P[myflow]` | `R-∅` | 缺只读强制 | `V-GAP` | P1 |
| 70 | `CAP-PLAN-02` | 评审门 + `task.py` 空 jsonl 拒绝 `start` | `.myflow/workflow.md:20,106-107`、`task.py:493-508` | `E-P[myflow]` / `E-C[myflow]` | `R-T tgt:81` | myflow 门在编码**开始前**，非探索期 | `V-QUAL` | P1（核心流程：任务生命周期） |
| 71 | `CAP-PLAN-03` | 无；子代理权限 spawn 时固定 | `sb:394` | `E-N[myflow]` | `R-∅` | 缺 | `V-GAP` | P2 |
| 72 | `CAP-MEM-01` | `.myflow/spec/**/*.md` 无 frontmatter/type | — | `E-P[myflow]` | `R-∅` | 有意选 spec 路线（`myflow-before-dev/SKILL.md:61`） | `V-QUAL` | P2 |
| 73 | `CAP-MEM-02` | `.myflow/spec/index.md` 人工维护 | `.pi/skills/myflow-update-spec/SKILL.md:50` | `E-P[myflow]` | `R-∅` | 无自动重建，有漂移风险 | `V-QUAL` | P2 |
| 74 | `CAP-MEM-03` | 让模型 `cat .myflow/spec/index.md`，纯提示词，无排序/上限 | `.pi/skills/myflow-before-dev/SKILL.md:14,27-29` | `E-P[myflow]` | `R-∅` | 缺召回 | `V-GAP` | P2 |
| 75 | `CAP-MEM-04` | 无运行时告警 | — | `E-N[myflow]` | `R-∅` | 缺 | `V-GAP` | P2 |
| 76 | `CAP-CTX-01` | 每回合重注入 + 压缩后重挂 + 缺失扫描 | `ix:319-338,384-406,455-457` | `E-C[myflow]` | `R-T ext:88,110,123,203,224` | 无独立账本（→ `RISK-02`） | `V-OWNED` | 不补 |
| 77 | `CAP-CTX-02` | 两侧各派生 `pi_<sanitize(id)>`；越界/投毒→`no_task` | `ix:161-193`、`task.py:96-117`、`tc:22-33,84-98` | `E-C[myflow]`（会话 id 来自 `E-G[Pi]`） | `R-T tct:172,189,207,256` | 无父链继承、无 fork 交接 | `V-QUAL` | P1 + `P0-R`（`RISK-03` 硬依赖） |
| 78 | `CAP-CTX-03` | 三级字节上限 + 截断标记 + 汇总提示；项目外拒收 | `ci:20-33,148-176,349-394,492-493` | `E-C[myflow]` | `R-T cit:131,142,226,443` | 显式降级，优于静默丢弃 | `V-OWNED` | 不补 |
| 79 | `CAP-OBS-01` | `/myflow-status` 无模型调用，输出 phase/task/git/next + `phaseBlockFound` | `ix:254-271`、`st:69-115` | `E-C[myflow]` | `R-T ext:172,stt:31` | Norma 无工作流状态概念（`ADV-05`） | `V-ADV` | P2 |
| 80 | `CAP-OBS-02` | 子代理日志 + 进度事件 + 超时回报 `logPath` | `sb:67,286-310,439-443` | `E-C[myflow]` | `R-T sbt:208` | Norma 无逐 run 命名日志（`ADV-02`） | `V-ADV` | P2 |
| 81 | `CAP-TEST-01` | verify gate；本仓无 `worktree.yaml` → 空跑 | `ix:464-495,221-232`、`worktree.py:478-507` | `E-C[myflow]` | `R-T ext:285,318,356` | Norma 无等价 | `V-ADV` | P2 |
| 82 | `CAP-TEST-02` | 17 个测试文件；含把**文档契约**钉成测试 | `wit:71` | `E-C[myflow]` | `R-T wit:71` | Norma 无等价 | `V-ADV` | P2 |

**表 B 完成判据自检**：每条「有」判定均带层级与施加强制者；`E-P` 条目（#69、#70、#72、#73、#74）按 `design.md` §4.3 `R-STR-3` **一律未记为已覆盖**。

---

## 3. 表 C — 判定统计（design.md §8.7）

### 3.1 `V-*` × `O-*` 交叉计数

> 计数口径：每个 `CAP-*` 计一次，取**主归属码**（`O-*`）；双码项在 §3.3 脚注列出。共 82 项。

| `V-*` \ `O-*` | `O-1` Pi 内建 | `O-2` 刻意外包 | `O-3` Pi 部分 | `O-4` 契约依赖 | `O-5` 双方皆无 | `O-6` 扩展提供 | 合计 |
|---|---|---|---|---|---|---|---|
| `V-GAP` 真缺口 | 1 | 5 | 8 | 1 | 14 | 0 | **29** |
| `V-QUAL` 质量差 | 0 | 1 | 2 | 0 | 2 | 1 | **6** |
| `V-OWNED` 已承担 | 1 | 0 | 1 | 0 | 1 | 4 | **7** |
| `V-PI` 非缺口 | 29 | 0 | 3 | 0 | 0 | 0 | **32** |
| `V-EXT` 扩展已给 | 0 | 0 | 0 | 0 | 0 | 2 | **2** |
| `V-UP` 运行时约束 | 0 | 0 | 2 | 0 | 0 | 0 | **2** |
| `V-ADV` 相对优势 | 0 | 0 | 0 | 0 | 4 | 0 | **4** |
| `V-NA` 场景无关 | 0 | 0 | 0 | 0 | 0 | 0 | **0** |
| **合计** | **31** | **6** | **16** | **1** | **21** | **7** | **82** |

### 3.2 各结论码汇总

| 指标 | 数量 |
| --- | --- |
| 真缺口数（`V-GAP`） | **29** |
| 质量差数（`V-QUAL`） | **6** |
| 已承担数（`V-OWNED`） | **7** |
| 非缺口数（`V-PI`） | **32** |
| 扩展已给数（`V-EXT`） | **2** |
| 运行时约束数（`V-UP`） | **2** |
| 场景无关数（`V-NA`） | **0** |
| 相对优势数（`V-ADV`） | **4** |
| **合计** | **82** |

### 3.3 脚注与口径

- **双归属码项**（在表 A 同时标两码）：
  - `SUB-01`、`SUB-02`、`COORD-01`：`O-6`（本环境由 `A-EXT:pi-subagents-lite` 提供）为主码，兼 `O-2`（core 刻意外包）。
  - `MCP-01`、`MCP-03`：`O-6`（本环境由 `A-EXT:pi-mcp-adapter` 生效）为主码，兼 `O-1`（core 有内建但被 `-builtin:mcp` 停用）。
  - `CTX-02`：`O-3` 为主码，兼 `O-4`（依赖 `PI_SESSION_ID` ↔ `getSessionId()` 的未文档化等价，见 `RISK-01`）。
  - `LLM-04`：`O-1` 为主码（重试），兼 `O-5`（限流无人提供）。
- **按域统计**：真缺口最集中域 = `NOA`(7: 01/02/03/04/07/08/09) + `PERM`(5: 01–05) + `PLAN`(2) + `MEM`(2) + `CMPT`(2) + `NOAA`(3) + `TOOL`(2) + `SKILL`(2) + `LOOP`(2) + `TRANS`(1) + `LLM`(1)。
- **C1 复核修正（B5）**：5 项主归属码由 `O-5` 上调为 `O-3`（`CAP-LOOP-02`、`CAP-CMPT-02`、`CAP-NOA-07`、`CAP-NOA-08`、`CAP-SKILL-03`）——它们并非「双方皆无」，而是 Pi 给原语/半边、语义靠 myflow 补齐；故 `O-3` 由 11 升至 16、`O-5` 由 26 降至 21（`V-GAP` 行：`O-3` 3→8、`O-5` 19→14）。依据见 `research/c1-neg-recheck.md`。
- **`V-PI` 的「重复造轮子」检查**：`V-PI` 的 32 项中，myflow **未重复实现**任何 Pi 能力（myflow 在这些行一律记 `E-N[myflow]`、完全委托 Pi）。唯一「部分自建」的是 `CMPT-05`（压缩后重注入）与 `CTX-01`（状态注入），属 `O-3`/`V-OWNED`，为 Pi 只给原语、语义需 myflow 补齐，不构成重复造轮子。

---

## 4. 现有 CAP 清单外的 Pi 能力（T1 反向覆盖，单独一节）

> 来源：`research/pi-surface-completeness.md` §2（T1 逐篇读完 Pi 1.2.0 `docs/` 40 篇）。**不混入表 A 主表**。
> 这些是「Pi 已给、但 design.md §7.2 未列域/未列子项」的能力，供 B2/B4 决定是否扩域。

| # | 能力 | 证据 `[v1.2.0]` | 与 myflow | T1 处置建议 |
|---|---|---|---|---|
| P1 | **project trust** 加载门禁（`trust.json`、`defaultProjectTrust`、`--approve`） | `security.md:27-52,61-82`、`how-pi-works.md:47-49`、`cli.md:237-239` | **高**：myflow 资产全在 `.pi/`，拒信任即整体不加载；Pi 无内建工具审批 | 建议新增域 `TRUST`（≥3 项） |
| P2 | **环境契约**（`PI_*` 解析时机、`AI_AGENT=pi`、shell 解析顺序、终端能力探测） | `environment-variables.md:22-50`、`windows.md:19-25`、`shell-aliases.md:9-25`、`settings.md:137-143`、`terminal-setup.md:171-190` | **高**：`AGENTS.md` 依赖 `shellPath`；`PI_SESSION_ID` 形状/时机是 `RISK-01` 输入 | 建议新增域 `ENV`（≥3 项） |
| P3 | **进程集成协议**（Print/JSON/RPC 四模式 + `RpcClient` + SDK 嵌入） | `cli-integration.md:10-22,32-56`、`json.md:8-30`、`rpc.md:16-30`、`sdk.md:6-31` | 中：myflow 仅 TUI；RPC/JSON 是无人值守通道 | 建议新增域 `IPC`（≥3 项） |
| P4 | **codemode 沙箱**（QuickJS 内 `tools.<n>()`、`Promise.allSettled`、`store/load`、`searchTools`、`models.classify/generateImages`） | `cli.md:155-156`、`codemode.md:5-40,54-60,97-150`、`extensions.md:181-186` | 中高：可替代 myflow 自建批量取数/过滤 | 建议新增域 `CODE`（≥3 项） |
| P5 | **非 LLM 模型 + 请求级路由 + prompt cache** | `models.md:94-100,130-200`、`virtual-models.md:37,93-110`、`settings.md:21` | 低：Pi 已给 | 建议扩 `LLM-06..08` |
| P6 | **会话树与分支**（`/tree`·`/fork`·`/clone`、`label`、`branch_summary`、`get_tree`/`get_entries`） | `sessions.md:20-40,56-70`、`session-format.md:189-200,226-240`、`rpc-commands.md` | **高**：myflow 任务指针/会话键派生建立在会话身份上 | 建议新增域 `SESS` 或扩 `CORE`/`TRANS` |
| P7 | **上下文文件与提示词装配**（`AGENTS.md` 祖先链、`SYSTEM.md` 替换、`APPEND_SYSTEM.md` 追加、模板参数） | `configuration.md:17-39,41-52`、`prompt-templates.md:8-18,28-45` | 中高：myflow 已用 `.pi/prompts/`；**未用** `SYSTEM.md`/`APPEND_SYSTEM.md` 与参数语法 | 建议新增域 `PROMPT`（≥2 项） |
| P8 | **队列与续跑边界**（steering/follow-up 双队列、`queue_update`、`agent_end` vs `agent_settled`、`agent_before_settle` 单次续跑） | `usage.md:30-40`、`settings.md:31-32`、`extensions.md:63-67,118`、`json.md:121`、`cli-integration.md:50` | 中高：myflow **已用** `agent_before_settle` 做 verify gate；**未用**队列 | 建议扩 `LOOP-07` |
| P9 | **扩展点分类学与工具可见性**（`register*` 8 类、`exposure` 五档、`prepareLoadout`、`reachesTools`、`ctx.executeTool` 嵌套） | `extensions.md:72-85,149,153-186,215` | 中：myflow 仅用 `registerTool`/`registerCommand`/`on()` | 建议扩 `HOOK-05/06` |
| P10 | **写并发原语** `withFileMutationQueue()` | `extensions.md:144` | 中：myflow 靠 dispatch 拒绝写者并行（`E-C`），此为第二层 | 建议扩 `TOOL-07` |
| P11 | **append-only 上下文编辑** `context_edit`（不改原始记录、分支相对） | `session-format.md:139-160,235`、`compaction.md:98` | 中高：myflow **未用**；比「每回合重注入」更强的压缩存活手段 | 建议扩 `CMPT-06` |
| P12 | **用量/成本账目**（`get_session_stats`、`UsageEntry`、`/session`、footer context usage） | `rpc-commands.md:526-560`、`session-format.md:113-128`、`usage.md:6` | 中：`/myflow-status` 不报 context/cost 用量 | 建议扩 `OBS-03` |
| P13 | **TUI 组件与 `ctx.ui`**（`select/confirm/input/editor`、`setStatus/setWidget`、`custom()`、`pi-tui`） | `tui.md:8-64`、`rpc-extension-ui.md:3-30` | 中：myflow 仅用 `ctx.ui.notify`（`ix:269`） | 建议新增域 `TUI`(P2) 或扩 `OBS` |
| P14 | **MCP HTTP/OAuth/resources/exposure** | `mcp.md:115,189,236,250-254` | 低中：本机 `mcp.json` 仅 stdio | 建议扩 `MCP-04..05` |

**建议不建独立域**（T1 §1）：`SANDBOX`/`DIST` 与 TUI 主题、键位并入既有域；`containerization`、`packages`、`themes`、`keybindings` 纯清单；`index`、`quickstart` 无能力内容。

**docs 与包根 README 的覆盖差（T1 §4，`O-2` 判据来源）**：Pi `README.md:19` 明示「skips features like sub-agents and plan mode」，而 `docs/` 40 篇**无此语义** → `O-2` 的唯一权威原文在包根 `README.md`，是 docs 覆盖缺口。

---

## 5. 未判定清单、分片冲突与口径说明

### 5.1 未判定清单

**无。** design.md §7.2 的全部 19 域 / 82 个 `CAP-*` 均在至少一个 research 分片中被判定（含 O 码或 V 码）。

### 5.2 分片冲突 / 口径差（保留两者，不静默择一）

| # | 冲突项 | 甲方 | 乙方 | 处理 |
|---|---|---|---|---|
| C-1 | `TOOL-01` 强制层级 | `T2-myflow-tiers`：`E-N[mf]`（无注册表） | `S1-llm-tool`：`E-C[myflow]`（注册 1 个工具） | 两者所指层次不同：T2 判「无自有 Registry 抽象」，S1 判「注册动作由 `pi.registerTool` 代码执行」。表 B 记 `E-N`（主）+ 括注注册动作 `E-C`。 |
| C-2 | `TOOL-03` 强制层级 | `T2`：`E-C[mf]`（fail-closed 守卫 `ix:122-140`） | `S1`：`E-N`（无工具定义默认） | 冲突在于「fail-closed 所指」：T2 指写范围守卫，S1 指工具定义行为默认。表 B 记 `E-N`（主）+ 写范围 `E-C` 括注。 |
| C-3 | `PERM-03` 强制层级 | `T2`：PERM 全域 `E-N[mf]`（无权限系统） | `S2-perm-loop`：`E-C[M]`（单条硬 deny=`writesUnder`） | 口径差：T2 判「无 allow/deny/ask 求值管线」，S2 判「单条写范围硬 deny」。表 B 记 `E-C`（单条 deny）+ 说明无规则表。 |
| C-4 | myflow 注册 hook 数 | `T2`：`6 钩子(ix:254..464)` | `S7-ext-integrate`：**7** 个事件（`:273,302,319,340,420,455,464`）；`T3` `DOC-DRIFT-01` 亦记实际 7 | 以 S7/T3 为准（表 B 记 7）。这同时印证 `harness-conventions.md:101-102` 的「all six hooks」为**文档漂移**，建议以测试钉死（非 `RISK-*`）。 |
| C-5 | `PERM-05` 与 `PLAN-03` 重叠 | `S2`：`PERM-05`（中途切换权限模式） | `S8-plan-mem`：`PLAN-03`（中途权限翻转）；S8 自述「PLAN-03 与 S2 重叠，定稿前须对齐」 | 同一关注点两处覆盖，均为 `V-GAP`、域 `A-NONE`/`O-2`。B2 合并为单条 `GAP-PERM-*`，`PLAN` 侧引用之。 |
| C-6 | `CMPT-05` 结论框架 | `S4-cmpt-noa-core`：`V-QUAL`（质量差） | `T3-risk-adv` `RISK-02`：`R-OK`（已有定向自愈） | 非真冲突：`V-QUAL` 判「强度弱于 Norma」，`R-OK` 判「风险已自愈」。B2 出缺口条目时按 `design.md` §4.2 并记 `R-T`（`ext:224`）、不得写 `R-∅`。 |
| C-7 | `NOA-10` / state 条目重叠 | `S4`：覆盖 `noa/{state,boundaries,pipeline,rebuild}.go` | `S5-noaa-trans-core`：显式承担 `NOA-10`；S5 自述「与 S4 的 state 条目可能重叠，待去重」 | 无结论冲突（S4 表未列 NOA-10）；表 A 以 S5 的 `NOA-10` 行为准，B2 去重。 |
| C-8 | PRD Q3「递归守卫仅靠提示词」 | PRD `Q3`：`myflow-research` 的递归守卫是提示词文字 | `S3-sub-coord` + `T3`：实为 `E-C[myflow]`（`ix:420-432`）+ `E-G` 白名单；`S2` 亦记 `E-C` | 以 S3/T3/S2 为准。「名义有、实际靠约定」的反例应改指仍属 `E-P` 的条目（如 `myflow-research` 的「一文件一主题」纪律、`PLAN-01` 的只读文字）。 |

### 5.3 待 B2/B3/B4 处理的事项

1. 本文件的**优先级**为按 `design.md` §9 的初判；`03-gap-register.md`（B2）须对每个 `GAP-*`/`QGAP-*` 给出带依据的最终优先级。
2. 本文件的 `P0-R` 仅为指向 `RISK-*` 的标记；`04-risk-register.md`（B3）定稿风险码与钉住手段。
3. §4 的 14 项「CAP 清单外 Pi 能力」是否扩域，由 B4 在 `08-coverage.md` 记录决定依据。
4. 表 A 的 `A-PI`/`A-EXT` 判定在卸载测试（`design.md` §6 测 A）下复核；`MCP-*` 与 `SUB-*`/`COORD-*` 是最易错处，B3 的 `C3` 归属复核须重点覆盖。
