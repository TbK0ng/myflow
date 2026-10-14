# S5 — NOAA / TRANS / CORE（+ NOA-10）

依据 `research/00-baseline.md`。P=Pi 1.2.0（`@earendil-works/pi-coding-agent/docs/*`，行号属安装目录）；N=Norma 52f17dd；M=myflow 0a702fa。码义见 `design.md`。

## 1. 表 A（16 项，含 M 现状）

| CAP | N（E4） | P 1.2.0（E1/E2） | 域 | O | M（E3） | V |
|---|---|---|---|---|---|---|
| NOAA-01 接管 ContextView | `Compactor` 实现 Pre/View/IsOverflow/Reactive；`Enable` 三件套同生共死 `noaadapter/noa.go:8-46` | `context` 改消息、`context_with_system` 独占 transcript `extensions.md:114-116` | A-PI | O-1 | `context` 注入 `index.ts:340-392` | V-PI |
| NOAA-02 内容哈希身份 | `DeriveMessageID`(sha256)+`ClusterCounter` `identity.go:23-57` | entry 写入期稳定 `id/parentId`；`context_edit` 按 `targetId` `session-format.md:54-59,141-147` | A-PI | O-1 | 无 | V-PI |
| NOAA-03 子代理账本继承 | `DeriveChildState` 继承 Blocks/Refs/Snapshot、重置 Nudge/Stats、归档绝对路径可读；上溯≤8 `inherit.go:47-108` | core 无子代理；A-EXT 子代理 `--no-session` `subagent.ts:394` | A-NONE | O-5 | 仅继承任务指针 `subagent.ts:446` | V-GAP |
| NOAA-04 溢出学习窗口 | 从错误文本解析真实窗口(4 正则)+95% ceiling；`Reactive` 验证确实变小否则 false `overflow.go`、`compactor.go §Reactive` | 有 overflow 压缩+重试序 `compaction.md:39,85-96`；**未文档化**从错误取数值窗口 | A-PI(部分) | O-4 | 无 | V-GAP |
| NOAA-05 materialize 降级 | `Materialize` 纯函数(幂等/可逆/不写 transcript) `materialize.go` | 派生视图持久化于 session，resume 即生效 `session-format.md:141-147,226-233` | A-PI | O-1 | 无 | V-PI |
| NOAA-06 工具输出压缩 | 溢出落盘+头部指针 `agentcore.go:155-160`；截断计数 `session.go:lastTruncatedCount` | bash 2000 行/50KB、>1MiB 留首尾+`full_output_path` `codemode.md:43`；MCP >20KB 去中间 `mcp.md:232` | A-PI | O-1 | 无 | V-PI |
| NOAA-07 ref tag 渲染/剥离 | 尾置 `<noa-ref id="m\d{5}">`；先剥再哈希、token 首渲染冻结 `tags.go` | 无等价机制 | A-NONE | O-5 | 无 | V-GAP |
| TRANS-01 append-only JSONL | `Record{uuid,parent_uuid,session_id,agent_id,is_sidechain}`、O_APPEND `transcript.go:1-11,38-47,74-94` | JSONL+entry 树，原始 entry 不删 `session-format.md:3,11,141-147` | A-PI | O-1 | 无 | V-PI |
| TRANS-02 冷启动重建视图 | `Messages()` 跳 boundary；`RebuildFromHistory`+`noa/rebuild.go:45` 回放、摘要字节一致 | `buildContextEntries` 取最新 compaction+`firstKeptEntryId` `session-format.md:226-233` | A-PI | O-3 | 无 | V-PI |
| TRANS-03 子代理 sidechain | `<sid>/subagents/agent-<id>.jsonl`，token 独立 `transcript.go:59-72,146-196` | core 无子代理；A-EXT 子代理无会话 | A-NONE | O-5 | 仅原始 stdout 日志 `subagent.ts:67` | V-GAP |
| TRANS-04 工作集语义 | `RecordBoundary` 仅观测、重建跳过；工作集**不落盘** `transcript.go:208-216,128-137` | boundary/summary/编辑均为持久 entry `session-format.md:128-147` | A-PI | O-1 | 无 | V-PI |
| CORE-01 Session | `Session.Prompt` 可重复、状态跨调用 `agentcore.go §Session` | `SessionManager` `sdk.md:44-52` | A-PI | O-1 | 无 | V-PI |
| CORE-02 一次性 Run | `Run(ctx,opts,input)` `agentcore.go §Run` | `pi --mode json -p` `json.md:9,26` | A-PI | O-1 | 无 | V-PI |
| CORE-03 转录接线 | `Options.Transcript/SessionID` `agentcore.go:163-169` | 默认自动存会话 `sessions.md:7,50-54` | A-PI | O-1 | 无 | V-PI |
| CORE-04 Resume | `Resume`+`cleanResumed` 丢弃未落盘尾 tool_use `agentcore.go §Resume` | `--continue/--resume` `sessions.md:10-14` | A-PI | O-1 | 无自有 resume | V-PI |
| NOA-10 归档与 state | `state.json`(version 守卫+temp/rename+损坏回初始)+`tier<N>/` 原子归档+`reuseArchiver` 不覆盖+回放兜底 `state_store.go`、`archive.go`、`materialize.go` | 原文永不删→可回溯 `sessions.md:40`；无「摘要块↔归档文件」产物 | A-PI | O-1 | 无自建账本 | V-PI |

N 侧 R-T：`state_store_test.go`、`materialize_test.go`、`transcript_test.go`、`longsession_test.go`；M 侧无对应测试。

## 2. 会话身份与状态绑定（三层）

**N**：身份=内容哈希（tag 先剥再算 `project.go §projectBlock`+`tags.go`），随 prune/nudge/resume 不变；`Reassemble` 明确不写回宿主历史。账本按 `ArchiveBaseDir/<SessionID>` 落盘 `session.go:24-58`，压缩即落 `session.go §applyCompression`。子代理继承账本、重置节律、沿用父归档绝对路径 `inherit.go:47-63`。
**P**：单 jsonl，entry 树 `id/parentId`；恢复取当前分支、可见范围由最新 compaction 定。`/tree` 同文件换分支（id 不变）；`/fork`·`/clone` 生成带 `parentSession` 的**新会话**（`sessions.md:24-28`、`session-format.md:75`）→ id 变；ephemeral 时 `PI_SESSION_FILE` 未设 `environment-variables.md:27`。
**M**：键=`pi_<sanitize(getSessionId())>`，退化 `pi_transcript_<sha256(file)[:24]>`（`index.ts:161-193`；类型面 `pi-coding-agent.d.ts:16-21`）；指针=`current_task` 于 `.myflow/.runtime/sessions/<key>.json`（`task.py:16,96-117`；读 `turn-cache.ts:38-108`），runtime 被 gitignore（`.gitignore:5`）→ 指针=机器本地+会话本地。
后果：①`/fork`·`/clone` 或换机/清 runtime → 找不到 `<key>.json` → `no_task`（`turn-cache.ts:45-51`），注入消失；可观测（`/myflow-status`）非静默 → `R-SOFT`。②子代理 `--no-session`，靠显式 `MYFLOW_CONTEXT_ID` 覆盖继承指针（`subagent.ts:446`；`index.ts:181-182`）→ `R-OK`，但属 myflow 自建契约。③键派生不对称：TS 空 sanitize 回落 `hashValue`（`index.ts:174-175`）、Python 回落 `None`→默认文件（`task.py:112-117,381-392`）→ 理论错配，UUID 形状不触发 → `R-SOFT`(低)。④注入可被压缩吃掉：`custom_message` 是合法切割点（`compaction.md:134`）；补偿=每回合重注入（`index.ts:319-337`）+ `lastInjectionTs > lastCompactionTs` 判定（`index.ts:384`）+ `session_before_compact` 记时（`index.ts:455-457`）→ 自愈 `R-OK`，但宿主改切点规则/事件时序即**静默**失效 → 登记 `R-HARD`（O-4）。

## 3. N 有而 M 另法解决

原文回溯：N 靠归档文件（绝对路径可 Read）；M 靠 git 提交+任务目录+Pi 原始 jsonl → 目标等价。子代理绑定：N 继承账本；M 继承任务指针。子代理可追溯：N sidechain 可分离 token；M 仅原始日志（`subagent.ts:67`）→ 部分承担。

## 4. NEG 块

```
(NEG) 语料=pi-coding-agent/docs/*.md(40)+dist 导出 ——【C1 裁决：部分】
      检索式=内容哈希|content hash|sha256|stable id|哈希
      原命中=0 不实；重跑命中=mcp.md:77（工具名冲突时加 **hash suffix**）、rpc-commands.md:691（entry 有
        **stable ids**，可作 durable cursor）
      已排除的同义命中=以上两处均非**内容派生**（sha256/deterministic id → 0）；firstKeptEntryId/parentId
        为写入期 id（session-format.md:54-59,131）
      修正后的结论=「无内容哈希寻址」成立；命中列须补全并显式排除
      残余风险=或作 deterministic/idempotent
(NEG) 语料=同上   检索式=noa|noa-ref|ref tag|addressable reference|message ref   命中=0
      残余风险=compaction.md:134 的 custom_message 切割点易被误算，非同物
(NEG) 语料=同上   检索式=subagent|sub-agent|sidechain|nested agent|spawn   命中=0
      残余风险=仅 A-EXT pi-subagents-lite 命中(域 A-EXT，非 A-PI)
(NEG) 语料=同上   检索式=parse.*window|learned window|actual limit|真实窗口   命中=0
      仅 custom-provider.md:152「recognized context-overflow errors」=仅识别错误
      残余风险=可能内部实现未公开 → 判 V-GAP 前须过归属测试
(NEG) 语料=.pi/ + .myflow/(M)   检索式=state.json|archive|CompressionState|blocks|token snapshot
      命中=0(M 无账本/归档)   残余风险=或作 cache/snapshot(已检 turn-cache)
```

## 5. 自审

- **全量读**：`noaadapter/` 13 个非测试文件；`transcript/` 2；`agentcore/agentcore.go`；`noa/archive.go`、`state.go`、`rebuild.go(1-60)`；Pi 的 `sessions.md`、`session-format.md`、`json.md`、`compaction.md`(§1-2/Cut Point/Entry/Overflow)、`environment-variables.md`、`extensions.md`(events/context/tools)、`sdk.md §SessionManager`、`codemode.md:43`、`mcp.md:232`、`message-types.md:208-213`。
- **仅检索**：Pi 其余 28 篇（按 §4）；`noa/` 其余文件（属 S4/S6）。
- **未读**：`noaadapter/*_test.go`、`transcript_test.go`、`agentcore/*_test.go`、`examples/`、`cmd/`。
- **E5 推断**：无（未用 `Desktop/pi` 1.0.4）。
- **待汇总去重**：NOA-10 与 S4 的 state 条目可能重叠；`pi-coding-agent.d.ts` 是仓库内快照，属弱化 E2。
