# S1 — LLM / TOOL 域分片

锚点：Pi 1.2.0（`E0`/`E1`/`E2`）、Norma `52f17dd`（`E4`）、myflow `0a702fa`（`E3`）。缩写 `P=` `…/@earendil-works/pi-coding-agent/docs/`，`N=` `../Norma/`。行号为实测。

## 1 表 A — Norma 机制 / Pi 现状 / 归属

| # | Norma 机制 + 证据 | Pi `[v1.2.0]` + 证据 | 域 | O |
|---|---|---|---|---|
| LLM-01 多协议归一 | `Format` 三值 anthropic/openai/openai-responses `Nllm/provider.go:43,47`；归一消息 `Nllm/types.go:32,69` | `api:"openai-completions"` 等可配置端点 `Pmodels.md:45-63`；自定义协议走 provider 扩展 `Pcustom-provider.md:7-18` | A-PI | O-1 |
| LLM-02 流式归一 | 归一事件 `Nllm/provider.go:16,30`；SSE `Nllm/sse.go:15`；装配 `Nllm/accumulate.go:12,26` | 增量流 + `stopReason:"pending"` `Pmessage-types.md:118-141`；custom stream 须 emit 归一终止事件 `Pcustom-provider.md:126-135` | A-PI | O-1 |
| LLM-03 消息模型 | `ContentBlock` 联合(text/thinking/tool_use/tool_result) `Nllm/types.go:24-67`；`Usage`:102 | `AssistantMessage.content:(Text\|Thinking\|ToolCall)[]` `Pmessage-types.md:118-134`；`ToolResultMessage`:161-175 | A-PI | O-1 |
| LLM-04 重试/限流/SSE 容错 | 仅重试建立阶段 `Nllm/retry.go:21,64,79`；Provider 级共享限流 `Nllm/ratelimit.go:18`；配置 `Nllm/provider.go:71-92` | agent 级重试 `retry.*` `Psettings.md:126-135`；429/5xx transient `Prpc-commands.md:423`；**无限流** → NEG-1 | A-PI | O-1（限流=O-5） |
| TOOL-01 注册表 | 有序 name-indexed `Registry` `Ntool/registry.go:6-44`；`CoreTool` `Ntool/tool.go:85` | `registerTool()` + `exposure`/active set `Pextensions.md:135-183`；`pi-coding-agent.d.ts:49,55` | A-PI | O-1 |
| TOOL-02 参数校验 | JSON-Schema 子集 `Ntool/schema.go:10-72`；调用前强制 `Nharness/tools.go:42-43` | TypeBox `parameters` `Pextensions.md:135`；nested 走 argument validation `Pextensions.md:149`（模型路径未显式文档化 → NEG-2） | A-PI | O-1 |
| TOOL-03 fail-closed | `Build` 未声明行为字段取保守默认（非只读/非并发/需审批）`Ntool/tool.go:9,98-124` | 仅 MCP `annotations` 有保守默认 `Pextensions.md:165-172`；自定义工具无 Pi 强制默认 | A-PI(部分) | O-3 |
| TOOL-04 延迟工具 | schema 扣留 + 常驻 `SearchExtraTools`/`ExecuteExtraTool` `Ntool/deferred.go:18-30,102,221`；`UnlockSet` `:32-76` | `exposure:"deferred"` + `tool_search` `Pextensions.md:153-160`、`Pcli.md:156,182` | A-PI | O-1 |
| TOOL-05 核心工具集 | `DefaultTools()` = Read/Write/Edit/MultiEdit/LS/Glob/Grep/Bash/Sleep `Ntool/registry.go:62-68` | 内建 `read,bash,powershell,edit,write,grep,find,ls` `Psettings.md:46`；`codemode`/`tool_search` 内建扩展 | A-PI | O-1 |
| TOOL-06 输出上限 | `defaultMaxOutput=30000` + head/tail 截断或 spill 文件 `Ntool/helpers.go:12,31,77`；幂等 `:70`；**全局 net** `capOutput` 覆盖每工具 `Nharness/tools.go:104-108,126` | 内建各自有界：bash 2000 行/50KB `Pcodemode.md:43`；MCP >20KB `Pmcp.md:232`；摘要序列化截 2000 字符 `Pcompaction.md:291`。**无跨工具 net** → NEG-3 | A-PI(内建) | O-2 |

## 2 myflow 现状（供 T2 定 `E-*`/`R-*`）

- **LLM-01..04 无**：不实现 provider/重试/限流，全委托 Pi；子代理仅 `--model`/`--thinking` → `E-N[R-∅]`（`subagent.ts:395-399`）。
- **TOOL-01 注册 1 个 A-MF 工具** `myflow_subagent` → `E-C[myflow]`（`subagent.ts:573`）。**TOOL-02/03/04 无** → `E-N[R-∅]`（未用 `deferred`/`tool_search`）。
- **TOOL-05 无自身工具集**，白名单经 `--tools` 下发 → `E-G[myflow→Pi]`（`subagent.ts:403`、`.pi/agents/myflow-research.md:5`）。**TOOL-06 无全局 net**，`myflow_subagent` 结果不截断 → `E-N[R-∅]`。

## 3 NEG 块

```
(NEG-1) 语料=…/pi-coding-agent/docs/*.md (40 篇)
  检索式=ratelimit|rate limit|throttl|token bucket|requests per second|per-minute|限流
  命中=custom-provider.md:154, rpc-commands.md:423, llama-cpp.md:81 —— 均指「处理 429/限流错误」，非主动限流；无 Provider 级速率限制器
  残余风险=措辞可能为 quota/usage limit/concurrency（settings.md:135 的 quota 仅指错误处理）
(NEG-2) 语料=同上；检索式=validat|TypeBox|schema ——【C1 裁决：部分】
  命中=extensions.md:135,149（TypeBox 参数 schema；nested 走 argument validation）；codemode.md:48「A call that
    fails, is blocked, or **gets invalid arguments** rejects with an Error」
  修正后的结论=「无『模型发起 tool_call 的参数校验』独立章节」字面成立；但**校验能力存在且被正面文档化**，
    本 NEG 不得用作「Pi 缺校验」的依据（对应 CAP-TOOL-02 仍判 O-1）
  残余风险=校验细节可能内建于运行时；本机无 bash，无法读 dist 反证
(NEG-3) 语料=同上
  检索式=truncat|output limit|max.?output|tool output (cap|limit)|size limit|2000 lines|50KB|20 KB|1 MiB
  命中=codemode.md:43(bash)、mcp.md:232(MCP)、compaction.md:291(摘要序列化)、extensions.md:145(要求工具作者自行 truncate)
  【C1 裁决：部分】正面枚举命中=DEFAULT_MAX_LINES=2000 / DEFAULT_MAX_BYTES 为包**公开导出**
    （dist/index.js:30、dist/core/tools/truncate.d.ts:10），且被 read/bash/output-accumulator 共享
    （dist/core/tools/{read,bash,output-accumulator}.js）
  修正后的结论=「Pi 对**第三方/扩展工具**无统一 net、责任外置」（O-2 依据 extensions.md:145 保留）成立；
    但「Pi 无统一截断设施」不实 → 措辞窄化为「只对其**内建工具**套用共享 truncate 模块」
  残余风险=运行期可能有未文档化的通用 tool-result 上限；docs 仅覆盖内建工具与 MCP
```

## 4 疑似 O-2（Pi 刻意外包）原文

- `Pextensions.md:145`：「Truncate large model-facing results and tell the model where to read the complete output.」→ 输出上限交给**工具作者**，Pi 不设统一 net（支撑 TOOL-06）。
- `Psecurity.md:3`：「it does not ask for approval before every tool call」+ `Pextensions.md:107`（`tool_call` 可 block/mutate）→ 审批/限流策略归扩展层（PERM 域，交 S2）。`Pcustom-provider.md:7-18`：仅不支持的 wire protocol 才写 provider → 归一责任在 provider。

## 5 Norma 有 / myflow 用别法解决（供 `ADV-*`/`V-OWNED`）

- Norma `AskUserQuestion`（`Ntool/ask.go:41`）↔ Pi `ctx.ui.confirm` + `tool_call` handler（`Pextensions.md:170-181`）→ `V-PI`；Norma 延迟工具 ↔ Pi `exposure:"deferred"`+`tool_search`，myflow 直接消费 → `V-PI`。
- **建议交 `T3` 定 `ADV`**：myflow `writesUnder` **路径级写入门控**为 `E-C[myflow]`，`tool_call` 按目标路径拒绝越界（`index.ts:70,420-448`）；Norma `tool` 包无「按 agent 声明限制写入路径」的对应能力。

## 6 取证边界

- **全量读**：`Nllm/{provider,types,retry,ratelimit,sse,accumulate,boundary,anthropic,openai_responses}.go`、`Ntool/{tool,registry,schema,deferred,helpers}.go`、`Nharness/tools.go`；`P{extensions,models,settings,custom-provider,message-types,codemode,mcp,security,providers}.md` 相关章节。
- **仅检索**：`Nllm/openai.go`、`Ntool/*` 其余（仅确认构造函数存在）；`P*.md` 其余 31 篇（由 `T1` 反向覆盖）。**未读**：`Ntool/pty_*.go`、`Nllm/{skillmsg,todomsg}.go` 正文、`examples/`、`cmd/`（00-baseline §5 已定不审计）。
- **无 `E5`**：全部结论基于 `E0`–`E4`，未引用 `Desktop/pi`（1.0.4）。本机无 bash，无 `wc -c` 实测，体积为人工控制。
