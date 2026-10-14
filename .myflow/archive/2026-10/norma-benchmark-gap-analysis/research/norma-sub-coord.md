# S3 — SUB / COORD 域分片

> 基线 `research/00-baseline.md`（myflow@0a702fa、Norma@52f17dd、Pi **1.2.0**）。
> 规则见 `design.md` §2.2（归属域）/§3（证据）/§4（层级）/§5（判定）。证据码 `E0..E4`；`E5` 未用。

## 0 关键归属判定（本片最高优先，做错会污染整域）

**`Agent`/`StopAgent`/`MessageAgent`/`AgentStatus` = `A-EXT`，既非 `A-PI` 也非 `A-MF`。**
注册者证据（`E0`/`E3`）：`~/.pi/agent/npm/node_modules/pi-subagents-lite/src/registration.ts:66,121,132,143`
（四个 `name:` 字面量）+ `:112,129,140,149`（`pi.registerTool`），包版本 1.17.0（`package.json:3`）。
`myflow_subagent` = `A-MF`（`.pi/extensions/myflow/subagent.ts:573-574` 的 `pi.registerTool`）。
Pi core 只提供注册原语：`docs/extensions.md:106`（`tool_call` 可 block）、`:170-178`（返回 `{block,reason}`）、
`:263`（handler 抛错即 fail-closed block）。→ 卸载测试：删该包后四工具消失（NEG-3 确认唯一注册者）⇒ `O-6`。
Pi `README.md:19` 明示「skips features like sub-agents and plan mode … or install a package that does it
your way」⇒ SUB/COORD 在 core 侧为 `O-2`（刻意外包），**不是** `O-5`。

## 1 表 A（Norma 机制+证据 / Pi 1.2.0 现状+证据 / 归属域 / `O-*`）＋ myflow 行

| CAP | Norma 机制+证据 | Pi 1.2.0 现状+证据 `[v1.2.0]` | 归属域 | `O-*` | myflow 现状+证据 | `V-*` |
|---|---|---|---|---|---|---|
| SUB-01 复用循环+隔离 prompt/工具/权限 | `../Norma/subagent/subagent.go:5-8`（包文档）、`:120-135`（同 `harness.Query`，带 `System/Messages/Tools/MaxTurns/PermissionMode`）、`:161` `filterTools` | core 无子代理（`README.md:19`）；有原语 `createAgentSession`（`sdk.md:8,28`）；无隔离 sidechain | `A-NONE`(core)/`A-EXT` | `O-2`/`O-6` | `myflow_subagent` single/parallel/chain（`subagent.ts:573`）；子进程 `pi -p --mode json --no-session --approve`（`:394`）+`--tools`（`:403`）+`--append-system-prompt`（`:431`）+model/thinking（`:399,401`） | `V-OWNED` |
| SUB-02 递归深度守卫 | 纯代码：`depth(ctx)>=cfg.MaxDepth` → `tool.Errorf`（`:84`），默认 3（`:54`）；测试 `subagent_test.go:61-71`（`R-T`） | core 无；原语充足（`extensions.md:106,170-178`） | `A-PI`(原语)/`A-EXT` | `O-2`/`O-6` | **`E-C[myflow]`**：`pi.on("tool_call")` 命中 `myflow_subagent` 即 `{block:true}`（`index.ts:420-432`）；辅以 frontmatter `tools:`（`E-G[myflow→Pi]`，`cli.md:119-120`）；`R-T`：`tests/subagent.test.ts:434-454`、`tests/skills-hygiene.test.ts:133` | `V-OWNED`（≥Norma） |
| SUB-03 结果回传（只回最终文本） | `ev.Terminal.Text` → `tool.Text`（`subagent.go:88-95`）；父上下文只增一段 | core 无；`agent_settled` 可观测（`extensions.md:67-68`） | `A-EXT` | `O-6` | 取最后 assistant text：`getFinalOutput`（`subagent.ts:322-331`）；chain 传 `"Previous output:"`（`:684-696`）；失败/超时给 exitCode+log 路径（`:425-440`） | `V-OWNED`（带 log，更强） |
| COORD-01 LLM 驱动编排（顶层只派发） | `coordinator.go:81-99`：`AgentTool()` 复用 `subagent.NewTool` + `SystemSegment()` 注入「you do NOT implement directly」（`:86-99`） | core 无；`README.md:19` 明示跳过；`packages.md:21` 第三方包为推荐途径 | `A-PI`(明示)/`A-EXT` | `O-2`/`O-6` | 两路：`myflow_subagent` parallel/chain（`subagent.ts:672-706`）与 channel peer worker（`.pi/skills/myflow-channel/SKILL.md:33-46`；`.myflow/agents/{architect,reviewer}.md`） | `V-OWNED`（durable log 为额外优势） |
| COORD-02 编程式扇出：有界并发+保序返回 | `RunParallel`：信号量 `limit`（`coordinator.go:112-116`），默认 4（`:41`），`results[i]` 保序（`:125`）；`R-T` `coordinator_test.go:49-71` | core 无并行代理编排；`codemode.md:3` 的 parallel 指脚本内工具调用并行，非代理 | `A-EXT` | `O-6`（core `O-2`） | `parallel` 用 `Promise.all`（`subagent.ts:673`）→ 保序；prompt 上限 6（`:57`、`:633`，schema `maxItems` `:262`）；channel 并发上限 `max_live_workers`=3（`channel.py:77,506`） | `V-QUAL`（弱） |

## 2 NEG 块（均不单独支撑判定；已过 design §6 测 A）

```
(NEG-1) Pi core 无内建子代理能力
 语料=pi-coding-agent/docs/*.md(40)+README.md+package.json(导出)
 检索式=(?i)sub-?agent|spawn[^\n]{0,20}agent|delegate[^\n]{0,20}agent|child session|nested agent|worker agent
 命中=README.md:19（明示「skips … sub-agents」→ O-2 正证，非能力）；其余 0
 残余风险=「Agent」泛词段落（extensions/plan）；已补检 child session→仅 sdk.md:58（runtime 替换会话，不派生子代理）
(NEG-2) Pi core 无多代理编排器（coordinator/fan-out）
 语料=同上
 检索式=(?i)coordinator|orchestrat|fan-?out|multi-?agent|parallel[^\n]{0,20}agent
 命中=0（codemode.md:3 的 parallel 指工具调用；extensions.md:158 的 orchestrat 指工具编排）
 残余风险=「swarm/team/consensus」等措辞未覆盖
(NEG-3) 四个 Agent 类工具的唯一注册者是 A-EXT:pi-subagents-lite
 语料=~/.pi/agent/npm/node_modules/**(src+dist)+~/.pi/agent/extensions/*.ts
 检索式=name:\s*["'](Agent|StopAgent|MessageAgent|AgentStatus)["']
 命中=仅 pi-subagents-lite/src/registration.ts:66,121,132,143
 残余风险=打包产物可能改写字面量；已同时搜 extensions/ 目录（0 命中）
```

## 3 机制对比：守卫 / 并发 / 超时 / 回传（含施加强制者）

| 机制 | Norma | Pi core / A-EXT | myflow |
|---|---|---|---|
| 递归深度 | `E-C[Norma]` `MaxDepth=3`（`subagent.go:54,84`），`R-T` | core 无；pi-subagents-lite `E-C[A-EXT]`：永不嵌套，`EXCLUDED_TOOL_NAMES=["Agent"]`（`agent-types.ts:196-197`，用点 `:242,287,319-321,355-360`），另 `README.md:139`；其 `R-∅` 不可核验（测试未随包发布，`package.json:31`） | `E-C[myflow]`（`index.ts:420-432`）+`E-G[myflow→Pi]`（`--tools`）+`E-P`（agent md 文字），`R-T`（`tests/subagent.test.ts:434`） |
| 并发上限 | `E-C[Norma]` `MaxParallel` 默认 4（`coordinator.go:112-116`） | pi-subagents-lite `E-G[A-EXT]` concurrency 默认 4（`config-io.ts:38`，可配）；`R-∅` 同上不可核验 | `E-C[myflow]`：`MAX_PARALLEL_PROMPTS=6`（`subagent.ts:57,633`，schema `maxItems` `:262`）；channel `max_live_workers`=3（`channel.py:77,506`；`R-T` `tests/channel.test.ts:179`） |
| 超时 | 无墙钟上限（仅 `MaxTurns`，`harness.QueryInput`） | pi-subagents-lite `E-G[A-EXT]` watchdog 默认 45min（`README.md:210-217`） | `E-C[myflow]` `SUBAGENT_TIMEOUT_MS=900_000`（`subagent.ts:64`），超时 `killChildTree`（`:70,473`）→ exitCode 124（`R-T` `tests/subagent.test.ts:237-248`）；channel `idle_timeout`=900s（`channel.py:78,689`） |
| 结果回传 | 终态文本（`subagent.go:88-95`） | pi-subagents-lite 结果文本 + 可选 `/tmp/pi-agent-outputs/<id>.log`（`README.md:219-221`） | 终态文本 + 每 run 落 `.myflow/.runtime/subagent-logs/`（`subagent.ts:67`；`R-T` `tests/subagent.test.ts:300-301`） |

补注（`E3`，本片新发现）：channel worker 由 `channel.py` 启动（`-p --approve`，`:557-563`），
**不带** `MYFLOW_AGENT_TYPE`（仅 reviewer 带 `MYFLOW_VERIFY_GATE`，`:569`），故 `index.ts:241` 的
`isSubAgent=false` → §3 的递归守卫与 `writesUnder` 路径守卫对 peer worker **不生效**（可间接递归派发）。
该缺口由 channel 侧 `max_live_workers` + 「one reviewer per tree」（`channel.py:512-523`）部分补偿。

## 4 Norma 有、myflow 用别的办法解决（供 ADV / V-OWNED）

- **子代理间通信**：Norma 无（subagent 只回一段最终文本）；myflow channel 提供 durable JSONL 事件日志 +
  `send/messages/wait --kind done` + `interrupt`（`channel.py:466-485`；`myflow-channel/SKILL.md:41-46`）→ `ADV` 候选。
- **写者互斥**：Norma 靠 `PermissionMode` 语义；myflow 用**代码拒绝**：并行写者无 `writesUnder` 即 `throw`
  （`subagent.ts:636-647`；`R-T` `tests/subagent.test.ts:318-332`），且子进程内 `tool_call` 路径守卫
  （`index.ts:434-451`；`R-T` `:456-604`）→ 强度 ≥ Norma。
- **工作树隔离**：Norma 无 worktree 概念；pi-subagents-lite 有 `worktree_path`（`README.md:135`）；myflow
  明确「never creates git worktrees」（`subagent.ts:18`）而把隔离放在 task 级 `worktree.py` → 差异非缺口。

## 5 自我声明

- **全量读**：`Norma/subagent/subagent.go`、`Norma/coordinator/coordinator.go`（各全文）；
  `.pi/extensions/myflow/subagent.ts`（全文）、`index.ts:380-500`；
  pi-subagents-lite `registration.ts`、`agent-types.ts:190-370`、`shell.ts:88-110`、`README.md`；
  `channel.py`（关键段）、`myflow-channel/SKILL.md`、`.pi/agents/*.md`、`.myflow/agents/*.md`。
- **只检索未通读**：`docs/{extensions,sdk,cli,how-pi-works,packages}.md`（按关键词）；
  `subagent_test.go`、`coordinator_test.go`（仅取 `R-T` 证据）。
- **未读**：`Norma/examples/`、`Norma/cmd/`（非包，见 00-baseline §5）；pi-subagents-lite `ui/`、`models/`
  与 `agent-runner.ts` 其余部分（与 SUB/COORD 归属无关）。
- **推断**（不得进正式缺口）：无 `E5` 结论；`O-6`/`E-C[A-EXT]` 依赖 §0/NEG-3 的注册者证据。
- **残余薄弱点**：pi-subagents-lite 是否有 4 工具之外的代理派发路径未逐行确认（已检索 `name:` 与
  `registerTool`）；`A-EXT` 行为随其版本（1.17.0）变化，myflow 若依赖它需另立 `RISK`。
