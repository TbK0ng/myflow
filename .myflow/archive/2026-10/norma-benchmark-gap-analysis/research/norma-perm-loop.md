# S2 · PERM × LOOP 分片（Norma / Pi 1.2.0 / myflow）

锚点 `research/00-baseline.md`：myflow@`0a702fa`、Norma@`52f17dd`、Pi **1.2.0**。
简写：`P`=`Norma/permission/permission.go`、`H`=`Norma/harness/`、`T`=`Norma/tool/tool.go`、
`docs/`=`…/@earendil-works/pi-coding-agent/docs/`。Pi 列全为 `[v1.2.0]`；`E5`(Desktop/pi 1.0.4) 未使用。

## 1. 表 A：归属

| CAP | Norma `E4` | Pi `[v1.2.0]` | 域 | O |
| --- | --- | --- | --- | --- |
| PERM-01 allow/deny/ask | 三态+建议回传 `P:18-31` | 无（`docs/security.md:3` 不问审批）；审批被点名外包 `docs/extensions.md:167,176`、`docs/mcp.md:252` | `A-NONE` | `O-2` |
| PERM-02 6 种 mode | `P:51-58` | 无 mode，仅进程 allowlist `docs/cli.md:120-122`、`docs/settings.md:42` | `A-NONE` | `O-5` |
| PERM-03 deny 优先 | Stage1 先于 mode/bypass `P:85-90,145-158` | 无规则表；近似 `--exclude-tools`(无优先级) `docs/cli.md:121-122` | `A-NONE` | `O-5` |
| PERM-04 四阶段 Evaluate | `P:85-140` | 无；扩展自建 `docs/extensions.md:169-178` | `A-NONE` | `O-2` |
| PERM-05 中途切换模式 | 逐调用重读 `PermissionModeFunc` `H+tools.go:47-49`、`H+query.go:75` | 原语 `pi.setActiveTools()` `docs/extensions.md:163-165,185-189`；无 mode | `A-PI`原语 | `O-3` |
| LOOP-01 迭代协议 | `iter.Seq2`+事件 `H+query.go:201-208`、`H+event.go:8-29` | 内建循环 `docs/how-pi-works.md:9-13`；事件表 `docs/json.md:37-58` | `A-PI` | `O-1` |
| LOOP-02 只读并行/写串行 | FIFO+排他 `H+streaming.go:9-18,59-84`；缺省不安全 `T:140-152` | **无调度器**：同消息工具可并行 `docs/extensions.md:124`；但 core 提供**互斥原语** `withFileMutationQueue()` `:143-144` 与 `readOnlyHint`/`destructiveHint` 注解 `:167,172-174`（C1 修正） | `A-PI(原语)` | `O-3` |
| LOOP-03 tool pair 配对 | 丢未配对块+中断合成 `H+streaming.go:124-180`、`H+tools.go:57-64` | 有结构 `docs/message-types.md:161-169`、`docs/json.md:58`；中断合成未文档化 | `A-PI`部分 | `O-3` |
| LOOP-04 终止原因建模 | 11 `TerminalReason`+7 `ContinueReason` `H+event.go:32-58` | `stopReason` 7 值 `docs/message-types.md:134`；无「为何续跑」 | `A-PI`部分 | `O-3` |
| LOOP-05 取消传播 | `ctx`+`toolCtx` `H+query.go:379-389`；中断合成 `H+streaming.go:124-165` | `docs/sdk.md:70`；`docs/rpc-commands.md:513`；`docs/extensions.md:126` | `A-PI` | `O-1` |
| LOOP-06 结算与超时 | `Settlement`+`MaxTurns`/`MaxDuration` `H+query.go:34-38,104-127,563-570,594-618` | 无 turn/时长预算（`docs/settings.md:127-133` 仅 `retry.*`）；`agent_before_settle` 一次续跑 `docs/extensions.md:67` | `A-NONE` | `O-5` |

## 2. 表 B：myflow 承担度（`E3`；`M`=myflow，`E-*` 见 design §4.1，`R-*` 全为 `R-∅`，优先级全为 P2）

| CAP | myflow 现状 + 证据:行 | 层级 | 结论 |
| --- | --- | --- | --- |
| PERM-01 | 无 ask，仅硬 block | `E-N` | `V-GAP` |
| PERM-02 | 无 mode；代替法=agent `tools:` 经 `--tools` 由 Pi 强制 `subagent.ts:403` | `E-G[M→Pi]` | `V-GAP` |
| PERM-03 | 无规则表；单条硬 deny=`writesUnder` `index.ts:420-452,116` | `E-C[M]` | `V-GAP` |
| PERM-04 | 无 | `E-N` | `V-GAP` |
| PERM-05 | 未用 `setActiveTools` | `E-N` | `V-GAP` |
| LOOP-01 | 依赖 Pi | `E-N` | `V-PI`（不补） |
| LOOP-02 | 仅 dispatch 级写者互斥 `subagent.ts:636-646`(throw)、`MAX_PARALLEL_PROMPTS=6 :57` | `E-C[M]` | `V-GAP` |
| LOOP-03 | 仅依赖 Pi，无校验 | `E-N` | `V-UP` |
| LOOP-04 | 只读 `agent_before_settle.outcome` `index.ts:472-473` | `E-G[M]` | `V-UP` |
| LOOP-05 | `signal`+`timeoutMs` 杀进程树 `subagent.ts:456-476` | `E-C[M]` | `V-OWNED` |
| LOOP-06 | `SUBAGENT_TIMEOUT_MS=900_000 :64`；verify 门控续跑 `index.ts:464-495`(`:65`) | `E-C[M]`/`E-G[M]` | `V-GAP`（仅主会话缺预算） |

反例锚点：`myflow-research.md:11-15` 的递归守卫是 `E-P` 文字，同一保护的代码版在 `index.ts:420-434`（`{block:true}`）。

## 3. NEG 块（不单独支撑判定；已过 design §6 测 A）

```
(NEG1) 语料=docs/40 篇+@earendil-works/* 1.2.0 导出 ——【C1 裁决：部分】
  检索式=permission|approve|deny|allow|mode:(plan|bypass|acceptEdits|dontAsk)|deny.?priorit|gate|guard|policy
  命中=security.md:3,29,33,61,82; cli.md:120-122,237-240; extensions.md:167,176; mcp.md:252; skills.md:78;
       settings.md:36,42,127-133 → 无一条是**内建求值器**   残余风险=「preset/profile」等别称
  正面枚举命中=pi.on("tool_call") → {block:true, reason}（extensions.md:170-178）；mcp.md:252「Every MCP call
    passes through Pi's tool pipeline … including permission gates」= **core 提供的逐调用决策点**
  修正后的结论=「无 per-call 决策**点**」按字面读为假——决策点由 core 给、规则由扩展给；
    PERM-01/04 的「求值器外包」判 O-2 不翻转，但措辞须写「无内建求值器；决策点由 core 提供」
(NEG2) 语料=同上  检索式=mode\b|bypassPermissions|acceptEdits|dontAsk|plan mode
  命中=0   残余风险=「profile」式等价物
(NEG3) 语料=同上 ——【C1 裁决：部分】
  检索式=parallel|sequential|concurren|serial|exclusiv|queue|lock|scheduler
  命中=extensions.md:124,143-144; cli.md:155,174; codemode.md:3（全为「可并行」或作者建议）
  正面枚举命中=withFileMutationQueue()（extensions.md:144）；readOnlyHint/destructiveHint 注解
    （extensions.md:167,172-174）；pi.getAllTools() 暴露 annotations（mcp.md:254）
  修正后的结论=「无区分读写的**调度器**」成立；但不止「可并行+作者建议」——core 提供**互斥原语**与
    **读/写注解** → 该子能力判 O-3（CAP-LOOP-02），非纯「无」
  残余风险=docs 未描述的串行器（故记 A-PI(原语)，属推断）
(NEG4) 语料=同上  检索式=max.?turns|max.?duration|turn.?budget|wall.?clock|deadline
  命中=0（settings.md:127-133 仅 retry.*/provider timeout）   残余风险=SDK 参数未入 docs
```

`O-2` 仅两条明文（`extensions.md:167` a **permission extension**、`mcp.md:252` **permission gates**）→ 只外包「审批」；
mode 集/deny 优先/四阶段无明文，故记 `O-5`。

## 4. Pi 侧原文（O-1/O-2 依据）

- 可 block：`extensions.md:96-131`（`tool_call` 可改写输入或阻断）、`:261-263`（handler 抛错 **fail-safe 阻断**，同 Norma 缺省）。
- 可注入/改写：`message_end`、`tool_result` 复合、`context`、`turn_end`（`:112-118`）；可续跑门控：`agent_before_settle` 一次（`:67`）。
- 权限管线：无核心管线，`security.md:33`「项目信任**不限制**工具可达范围」；全由扩展在 `tool_call` 自建（`:169-178`）。
- 并发：`extensions.md:124`「同消息工具**可并行**」＋`:143-144`（作者责任）——Pi 不区分 read-only/write。

## 5. Norma 有、myflow 另法解决（供 `ADV-*`/`V-OWNED`）

1. `ModePlan`(只读) ⇒ `myflow-research.md:5` 无 `bash` ＋ `subagent.ts:403` `--tools`：读侧代理物理上无执行工具。
2. `ModePlan` 写禁 ⇒ `writesUnder` 路径守卫（`E-C[M]`）。
3. `Settlement` ⇒ verify 门控续跑 `index.ts:464-495`（仅覆盖 verify 失败，不含预算耗尽）。
4. `MaxDuration` ⇒ 子进程 `timeoutMs`+`killChildTree`（粒度=整次 dispatch，非 turn）。

## 6. 取证边界

**全量逐行**：`P`、`H` 四文件、`docs/{extensions,security,how-pi-works}.md`。
**抽样**：`docs/{cli,settings,message-types,session-format,json,sdk,rpc,rpc-commands,mcp,skills,compaction}.md`、`T:134-152`。
**myflow**：`.pi/extensions/myflow/{index,subagent,agents}.ts`、`.pi/agents/*.md`、`.myflow/workflow.md:60-78`。
**未读**：`H*_test.go`(13→Norma 侧 `R-T` 未确认)、`Norma/coordinator/`(属 S3)、docs 中 W1 未点名的 13 篇（交 `T1-pi-surface`）。
**推断（薄弱点）**：PERM-05/LOOP-03/LOOP-04 的 `O-3` 依「原语有、语义无」推断，缺 Pi 执行器细节。
