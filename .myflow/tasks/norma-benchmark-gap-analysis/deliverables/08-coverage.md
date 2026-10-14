# 08 — 取证边界与自我审计（Coverage & Self-Audit）

> **来源戳**（发布时由主会话改写为实际值）：`myflow@0a702fa`（发布时替换为实际 HEAD）、
> `Norma@52f17dd52d95b087265e5d5b306fe85c1ea05599`、`pi 1.2.0`。**交付时间戳**：`<主会话在发布时写入>`。
> **证据快照来源**：`.myflow/tasks/norma-benchmark-gap-analysis/research/*.md`（**12 个域分片 + 1 个 C1 复核分片 `c1-neg-recheck.md`**，发布时一并复制到 `evidence/`）。
> 本文按**自我审计六问**逐问回答，另加「偏离记录」（含 `### C1 复核修正记录`）与「交叉校验（P3 结论）」两节。
> **诚实性要求**：宁可写「未审计」，不得写「已确认无」。

---

## 1. 六问之一：全量 vs 抽样

**逐行读源（全量）**：

- **Norma（`E4`）**：`llm/{provider,types,retry,ratelimit,sse,accumulate,boundary,anthropic,openai_responses}.go`、
  `tool/{tool,registry,schema,deferred,helpers}.go`、`harness/tools.go`、`permission/permission.go`、
  `harness/{query,event,streaming}.go`、`subagent/subagent.go`、`coordinator/coordinator.go`、
  `compaction/{compaction,summarizer}.go`、`hook/hook.go`、`skill/skill.go`、`mcp/{mcp,stdio}.go`（导出面）、
  `plan/plan.go`、`memory/{memory,relevant,tools}.go`、`agentcore/agentcore.go`、
  `noa/{refs,tier,state,boundaries,pipeline,recommend,rebuild,const,types,config,compress,nudge,nudgetext,nudge_types,turnintegrity,toolpairs,protected,truncate,prune,hideconsumed,processturn,prompts_system,archive}.go`、
  `noaadapter/`（13 个非测试文件）、`transcript/transcript.go`、`llm/skillmsg.go`。
- **Pi 1.2.0（`E1`）**：`docs/` **40 篇 `.md` 全文**（含 W1 未点名的 13 篇，由 `T1` 反向覆盖）；
  `dist/core/extensions/types.d.ts`（事件表与类型段）；包根 `README.md:15-21`。
- **myflow（`E3`）**：`.pi/extensions/myflow/` 9 个 TS（`index/turn-cache/subagent/agents/context-injection/status/escape-hatch/find-project-root/parse-workflow-state`）、
  `.pi/agents/*.md` 3 份、`.pi/prompts/*.md` 3 份、`.pi/skills/*/SKILL.md` frontmatter、
  `.myflow/workflow.md`、`.myflow/spec/harness/index.md`、`task.py` / `channel.py` / `worktree.py` / `get_context.py` 关键函数、
  `tests/` 17 文件的用例名与断言（部分读测试体）。
- **`A-EXT`（`E0`）**：`settings.json`、`mcp.json`、`mcp-adapter.json` 全篇；
  `extensions/{cbmem,rtk}.ts` 关键段；`pi-subagents-lite/src/registration.ts`、`agent-types.ts` 关键段；
  `pi-mcp-adapter/{pi-builtin-mcp,namespace-tools,mcp-references,config,index}.ts` 关键段；
  `pi-rounded-tools/extensions/rounded-tools.ts:38-47,286-294`。

**检索命中即止（抽样）**：

- **`noa` 域为抽样而非逐行**：虽多数文件被列为「全量」，但 `noa` 共 29 个非测试文件、11 个能力项，
  实际为「**关键文件全量 + 其余抽样**」——`prompts_rules.go`、`panel.go`、`parseinput.go` 仅结构确认，
  未逐字抄；`noa/*_test.go` 读测试名 + 关键断言。**这是本横评最应显式说明的抽样点。**
- **Norma 测试（`*_test.go`）未逐行**：98 个测试文件只取「存在同名用例」作为 `R-T` 依据，
  **未验证断言强度**。
- **各域未点名的 Pi 文档**：`S1`/`S2`/`S5` 等对 40 篇中的其余篇目走 `NEG` 全局扫描（命中即止）。
- **`dist/` 其余文件**：非权威面，未全量读。
- **`pi-mcp-adapter` 其余 100+ 文件**、`pi-subagents-lite` 的 `ui/`、`models/`：未读（与判定无关）。

---

## 2. 六问之二：未读清单

| 未读对象 | 理由 |
| --- | --- |
| `Norma/examples/`（6 个非测试文件） | **非能力提供者**，仅装配示例。若某能力仅出现在示例中，分片可提一句，但**不得**作为「Norma 有此能力」的主证据。 |
| `Norma/cmd/`（1 个文件） | **非包**，CLI 入口。同上。 |
| `Norma/llm/openai.go`、`Norma/tool/pty_*.go` | 仅确认构造函数存在，未通读正文；`pte`/PTY 工具与本次 19 域判定无直接映射。 |
| `Norma/llm/{todomsg}.go` 正文 | 待办消息序列化，属 `tool/todo.go` 辅助，非独立能力。 |
| `docs/images/*`、`Norma/examples/**`、`schemas/*` | 截图 / 示例代码 / 字段校验，与能力判定无关。 |
| `pi-coding-agent` 的 `dist/` 全量 | 非权威面（权威面是 `docs/` + 包公开 API + 类型快照）。 |
| Pi 随包 `examples/**`（`plan-mode/`、`subagent/`、`permission-gate.ts`、`protected-paths.ts`、`custom-compaction.ts`、`truncated-tool.ts` 等官方参考实现）与包根 `CHANGELOG.md` | **NEG 语料一直未声明该子树**（C1 `F-2`）。它并不改变「Pi 核心不内建」的结论，反而**强化** `O-2`（刻意外包）的证据：Pi 不只「说 skip」，还随包给出可装载的参考实现。`plan-mode/` 已由 `03-gap-register.md` 引用；本表据此补登记。 |
| `.myflow/archive/`、skills `references/*`（除被点名者） | 非强制机制所在，不承载 E 层级判定。 |

> **诚实声明**：以上「未读」不等于「无内容」。凡据未读范围作出的判定，一律在分片中标为薄弱点或经 `NEG` 块声明检索边界。

---

## 3. 六问之三：`NEG` 集中清单（共 **37 条**）

> 下表把 12 个分片中的全部 `NEG` 块集中列出，供复核者逐条重跑检索式（这是**最重要的一张表**）。
> 计数口径：按「独立断言」计；`S4`/`S6` 各为 1 个 `(NEG)` 块但含 A/B/C/D 四个带独立检索式的子断言，故展开为 4 行。
> **重申**：`NEG` 只声明「在给定语料与检索式下未命中」，**不声明**「实现中不存在」。
> 定位：`evidence/<分片>.md` 是对应分片的快照，行号见各分片。
> **C1 复核裁决（B5 重跑）**：**成立 26 / 假阴性 2（`#14`、`#33`）/ 部分 9（`#2`、`#4`、`#11`、`#13`、`#17`、`#18`、`#19`、`#21`、`#26`）/ 无法复核 0**；逐条检索式与依据见 `research/c1-neg-recheck.md` §1/§2。下表受影响的 11 行已在「命中」列补全真实命中并标出裁决。

| # | 出处（`evidence/…`） | 被否定的断言 | 语料 | 检索式 | 命中 | 残余风险 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `myflow-enforcement-tiers.md` §6 | myflow 无 allow/deny/ask 求值 | `.pi/**` | `permission\|deny\|allow` | 无求值管线 | 权限可能只在 Pi 侧配置 → 须 `T1` 复核 `settings.json`/`security.md` 后才可作最终 `V-GAP` 依据 |
| 2 | `myflow-enforcement-tiers.md` §6 | myflow 无 MCP 集成 | `.pi/**` | `mcp` | **≥14 处**（均为**文档化** Pi 的 MCP，无 `.ts` 消费）：`skills/myflow-spec-bootstrap/references/mcp-setup.md:11,18,22,23,25,34,39-43,55,87`、`…/repository-analysis.md:13,16,36`、`myflow-meta/references/harness-conventions.md:74`、`subagent.ts:69`〔C1: 部分〕 | 同上（MCP 由 `A-EXT` 提供） |
| 3 | `contract-risks-and-advantages.md` §4 | Norma 无「按 agent 声明限制写入路径」 | `../Norma/**/*.go` 全仓 | `writesUnder\|WriteScope\|allowedPath\|AllowedPath` | **0** | 别名措辞（如 `scope`/`sandbox`）可能骗过 |
| 4 | `pi-surface-completeness.md` §3 | Pi 无内建子代理/代理派生 | `docs/*.md`(40) | `(?i)sub-?agent\|spawn\|parallel agent\|teammate\|orchestrat\|swarm\|multi-agent` | 非 0：`spawn` 命中 `environment-variables.md:53,57,64,69`（`spawnHook`=**进程** spawn 钩子，非代理）；`orchestrat` 仅 `extensions.md:158,181`〔C1: 部分〕 | 以「nested model call」措辞描述代理（`extensions.md:137,215`）→ 只能断言「无内建能力」，不能断言「无法实现」 |
| 5 | `pi-surface-completeness.md` §3 | Pi `docs/` 无 plan mode | 同上 | `(?i)plan mode\|plan-mode\|planner\|\bplan\b` | `virtual-models.md:93,98,99`、`providers.md:46-65`（均非 plan mode） | 唯一原文在包根 `README.md:19`，`O-2` 判定须引 README |
| 6 | `pi-surface-completeness.md` §3 | Pi 无内建工具审批/permission 系统 | 同上 | `(?i)permission\|allow/deny\|permissionMode\|approve\|confirm before` | `security.md:3`、`extensions.md:167-179`（示例）、`mcp.md:252-254`、`skills.md:78`、`cli.md:237-239` | `defaultTools`/`--exclude-tools` 是**声明层**限制，不等于逐调用审批 |
| 7 | `pi-surface-completeness.md` §3 | Pi `docs/` 无 noa 式分层/ref/nudge 压缩 | 同上 | `m00001\|ref tag\|content hash\|\btier\b\|nudge` | `models.md:94,100`、`custom-provider.md:95`（promptCache「retention tier」） | `compaction.md` 的 cut point/`firstKeptEntryId` 部分替代分层 → 判 `V-GAP` 前须做机制对照 |
| 8 | `norma-cmpt-noa-core.md` §2-A | 无 ref 寻址 | `docs/*.md`(40) | `tier\|m0000\|ref address\|message ref` | tier 仅 promptCache（`custom-provider.md:95`、`models.md:94`），余 0 | 「按 token 预算切段」不含 ref 词 |
| 9 | `norma-cmpt-noa-core.md` §2-B | Pi 无模型可调用的压缩工具 | 同上 | `compress\|context_edit\|model-selectable\|choose.*messages.*summar` | compress=0；`context_edit` 5 处（`compaction.md:93,138`；`extensions.md:118`；`session-format.md:144,235`） | 「模型自选压缩范围」可能有未枚举同义词；已做同义枚举复查，0 |
| 10 | `norma-cmpt-noa-core.md` §2-C | Pi 无分层摘要 | 同上 | `tier 分层\|layered summary\|multi-level compact` | 0 | `previousSummary` 迭代（`compaction.md:83`）形似分层但语义不同（无「同层不合压」约束） |
| 11 | `norma-cmpt-noa-core.md` §2-D | 无压缩熔断 | `docs/compaction.md` | `circuit\|breaker\|consecutive.*fail\|trip` | 0（circuit/breaker/trip 命中 0；唯一 `consecutive`=`skills.md:81`）；`compaction.md:39`「one compact-and-retry recovery attempt」=**有界单次重试**〔C1: 部分〕 | 仅限文档面；内部可能有未文档化计数 → 覆盖不足，非「确认无」 |
| 12 | `norma-noa-integrity.md` §2-A | 无按上下文增长节律催促压缩（nudge） | `docs/*.md`(40) | `nudge\|prompt.*compress\|suggest.*compaction\|remind.*context\|advisory.*compress\|ask.*model.*compress` | 0 | 仅阈压缩（`compaction.md:32,37`）与人工 `/compact`（`:41`）；未文档化的内部文案可能漏检 |
| 13 | `norma-noa-integrity.md` §2-B | 无工具级硬保护名单 | 同上 | `protected tool\|never compress\|hard.*protect\|exclude.*tool.*compact\|compactableTools\|allowlist.*compact` | 原式 0（仅软尾部 `keepRecentTokens`，`compaction.md:82,443`）；**正面命中** `session_before_compact` 可自选 `firstKeptEntryId`（`compaction.md:302-320`）、`:138` 保护性不变量〔C1: 部分〕 | 「非破坏性压缩保留原文」≠「某工具结果恒不被摘要」 |
| 14 | `norma-noa-integrity.md` §2-C | 无上下文压力触发、改写已存工具结果的紧急截断阀 | 同上 | `truncate.*context\|emergency.*truncate\|shrink.*tool result\|rewrite.*result\|compress.*tool output` | 原式 0；**正面命中** `context_edit`（`session-format.md:143-147,235`：append-only 改写**已存** entry、只改未来 model context、targets 可为 tool-result；可由 `turn_end`/`agent_before_settle` 链式追加 `extensions.md:118`）〔C1: **假阴性**〕 | 原残余风险不成立（语料在外层是 `session-format.md`） |
| 15 | `norma-noa-integrity.md` §2-D | 无运行期 tool pair 孤儿修复 | 同上 | `orphan\|unpaired\|repair.*pair\|tool_calls must be followed\|synthetic.*result` | `compaction.md:39`（length 响应保留合成失败 result，属建时）；余 0 | Pi 以「禁切 tool result」**预防**孤儿（`:136`），无运行期修复；对 `context_edit` 单侧移除无文档化补偿 |
| 16 | `norma-llm-tool.md` §3-NEG-1 | 无 Provider 级主动限流 | `docs/*.md`(40) | `ratelimit\|rate limit\|throttl\|token bucket\|requests per second\|per-minute\|限流` | `custom-provider.md:154`、`rpc-commands.md:423`、`llama-cpp.md:81`（均指处理 429，非主动限流） | 措辞可能为 quota/usage limit/concurrency（`settings.md:135` 的 quota 仅指错误处理） |
| 17 | `norma-llm-tool.md` §3-NEG-2 | 无「模型发起 tool_call 的参数校验」独立章节 | 同上 | `validat\|TypeBox\|schema` | `extensions.md:135,149`（TypeBox 参数 schema；nested 走 argument validation）；`codemode.md:48`「gets invalid arguments rejects with an Error」=**校验能力存在**〔C1: 部分〕 | 校验可能内建于运行时但仅一句带过 |
| 18 | `norma-llm-tool.md` §3-NEG-3 | 无跨工具统一输出 net | 同上 | `truncat\|output limit\|max.?output\|tool output (cap\|limit)\|size limit\|2000 lines\|50KB\|20 KB\|1 MiB` | `codemode.md:43`(bash)、`mcp.md:232`(MCP)、`compaction.md:291`(摘要)、`extensions.md:145`(要求工具作者自行 truncate)；**正面命中** `DEFAULT_MAX_LINES=2000`/`DEFAULT_MAX_BYTES` 公开导出（`dist/index.js:30`、`dist/core/tools/truncate.d.ts:10`）并共享于 read/bash/output-accumulator〔C1: 部分〕 | 运行期可能有未文档化的通用 tool-result 上限 |
| 19 | `norma-perm-loop.md` §3-NEG1 | 无 per-call 权限决策管线 | `docs/40 篇 + @earendil-works/* 1.2.0 导出` | `permission\|approve\|deny\|allow\|mode:(plan\|bypass\|acceptEdits\|dontAsk)\|deny.?priorit\|gate\|guard\|policy` | `security.md:3,29,33,61,82`、`cli.md:120-122,237-240`、`extensions.md:167,176`、`mcp.md:252`、`skills.md:78`、`settings.md:36,42,127-133`（无**内建求值器**）；**正面命中** `tool_call`→`{block:true,reason}`（`extensions.md:170-178`）=core 逐步调用决策点〔C1: 部分〕 | 「preset/profile」等别称 |
| 20 | `norma-perm-loop.md` §3-NEG2 | 无 permission mode 集合 | 同上 | `mode\b\|bypassPermissions\|acceptEdits\|dontAsk\|plan mode` | 0 | 「profile」式等价物 |
| 21 | `norma-perm-loop.md` §3-NEG3 | Pi 不区分 read-only/write 的调度器 | 同上 | `parallel\|sequential\|concurren\|serial\|exclusiv\|queue\|lock\|scheduler` | `extensions.md:124,143-144`、`cli.md:155,174`、`codemode.md:3`（「可并行」或作者建议）；**正面命中** `withFileMutationQueue()`（`extensions.md:144`）、`readOnlyHint`/`destructiveHint`（`:167,172-174`）、`mcp.md:254`〔C1: 部分〕 | docs 未描述的串行器（C1：应记 `A-PI(原语)`/`O-3`，非 `A-NONE`） |
| 22 | `norma-perm-loop.md` §3-NEG4 | 无 turn/时长预算 | 同上 | `max.?turns\|max.?duration\|turn.?budget\|wall.?clock\|deadline` | 0（`settings.md:127-133` 仅 `retry.*`/provider timeout） | SDK 参数未入 docs |
| 23 | `norma-sub-coord.md` §2-NEG-1 | Pi core 无内建子代理能力 | `docs/*.md`(40)+README.md+package.json(导出) | `(?i)sub-?agent\|spawn[^\n]{0,20}agent\|delegate[^\n]{0,20}agent\|child session\|nested agent\|worker agent` | `README.md:19`（明示 skips，是 `O-2` 正证）；余 0 | 「Agent」泛词段落；已补检 child session → 仅 `sdk.md:58`（runtime 替换会话，不派生子代理） |
| 24 | `norma-sub-coord.md` §2-NEG-2 | Pi core 无多代理编排器 | 同上 | `(?i)coordinator\|orchestrat\|fan-?out\|multi-?agent\|parallel[^\n]{0,20}agent` | 0（`codemode.md:3` 指工具调用；`extensions.md:158` 指工具编排） | 「swarm/team/consensus」等措辞未覆盖 |
| 25 | `norma-sub-coord.md` §2-NEG-3 | 四个 Agent 类工具的唯一注册者是 `A-EXT` | `~/.pi/agent/npm/node_modules/**`(src+dist)+`~/.pi/agent/extensions/*.ts` | `name:\s*["'](Agent\|StopAgent\|MessageAgent\|AgentStatus)["']` | 仅 `pi-subagents-lite/src/registration.ts:66,121,132,143` | 打包产物可能改写字面量；已同时搜 `extensions/`（0 命中） |
| 26 | `norma-noaa-trans-core.md` §4-1 | Pi 无内容哈希身份 | `docs/*.md`(40)+dist 导出 | `内容哈希\|content hash\|sha256\|stable id\|哈希` | 原声明 0 不实：`mcp.md:77`（工具名冲突加 hash suffix）、`rpc-commands.md:691`（entry **stable ids**）；均**非内容派生**〔C1: 部分〕 | 或作 deterministic/idempotent；已另检 `parentId\|firstKeptEntryId`（`session-format.md:54-59,131`，属写入期 id） |
| 27 | `norma-noaa-trans-core.md` §4-2 | Pi 无 `noa-ref` 式可寻址引用 | 同上 | `noa\|noa-ref\|ref tag\|addressable reference\|message ref` | 0 | `compaction.md:134` 的 `custom_message` 切割点易被误算，非同物 |
| 28 | `norma-noaa-trans-core.md` §4-3 | Pi core 无子代理/sidechain | 同上 | `subagent\|sub-agent\|sidechain\|nested agent\|spawn` | 0（仅 `A-EXT` `pi-subagents-lite` 命中，域 `A-EXT`，非 `A-PI`） | 仅有 `A-EXT` 提供 |
| 29 | `norma-noaa-trans-core.md` §4-4 | Pi 无「从错误解析真实窗口」 | 同上 | `parse.*window\|learned window\|actual limit\|真实窗口` | 0（`custom-provider.md:152` 仅「recognized context-overflow errors」= 仅识别错误） | 可能内部实现未公开 → 判 `V-GAP` 前须过归属测试 |
| 30 | `norma-noaa-trans-core.md` §4-5 | myflow 无账本/归档 | `.pi/` + `.myflow/`（myflow） | `state.json\|archive\|CompressionState\|blocks\|token snapshot` | 0 | 或作 cache/snapshot（已检 `turn-cache`） |
| 31 | `norma-ext-integrate.md` §3-NEG-1 | Pi 无 `SubagentStart` 等价宿主钩子 | `pi-coding-agent` 1.2.0：`docs/*.md`(40)、`dist/.../types.d.ts`、包根 `README.md` | `sub-?agents?\|SubagentStart\|subagent`(i) | `README.md:19`（唯一，语义为「跳过 sub-agent 特性」）；`on()` 全表 **41** 项无对应（C1 `F-1` 更正原记 42） | child session/worker 等别名会漏；已人工通读 `on()` 全表（`types.d.ts:1186-1228`） |
| 32 | `norma-ext-integrate.md` §3-NEG-2 | Pi 无进程内 MCP server 原语 | 同上 | `in-?process\|InProcess\|registerMcpServer.*function\|MCP server API` | 0；`registerMcpServer(name, config)` 只收**配置**（`extensions.md:195-206`）；**更强正证**：`pi-mcp/README.md:132`「servers … outside the initial core」（C1 `F-5`） | 「registerTool+namespace 模拟」不含关键字，属替代方案，已记 `O-3` |
| 33 | `norma-ext-integrate.md` §3-NEG-3 | Pi 无 skill 跨压缩保留机制 | `docs/*.md` 全文逐篇检索 `skill` | `skill`（重点 `compaction.md`） | 原式（`compaction.md` 查 `skill`）**=0**；**正面命中** `session-format.md:84,127-131,248`（`CompactionEntry.systemMessage`=完整 system checkpoint；pre-compaction system messages 折入该 checkpoint）、`skills.md:43-45`（roster 进 system prompt）〔C1: **假阴性**〕 | 保留逻辑在 `dist/` 已有旁证（`chunk-HACVPRBJ.js:11` `collapseSystemMessages`）；正文 re-inject 仍无宿主机制 |
| 34 | `norma-ext-integrate.md` §3-NEG-4 | Pi 无 skill→MCP 解锁联动 | `docs/skills.md` + `docs/mcp.md` + 全事件表 | `allowed-tools\|unlock\|reveal\|deferred.{0,40}skill\|skill.{0,40}mcp` | `skills.md:78`（`allowed-tools` 方向相反）；`mcp.md:191-217`（deferred/hidden 由 `tool_search` 与配置驱动） | 中文或别名表述会漏；本语料为英文全篇扫描 |
| 35 | `norma-plan-mem.md` §2-NEG-1 | Pi core 无 plan mode | `docs/*.md`(40)+README.md+cli.md+settings.md+configuration.md | `(?i)plan[ -]?mode\|EnterPlanMode\|ExitPlanMode\|--plan\|\b/plan\b` | `README.md:19`（skips → `O-2` 正证）；docs 正文 0；`plan-mode` 示例与 `CHANGELOG.md:4913-4918` 为示例/历史 | 改名词（read-only mode/approval）；补检 `(?i)read-?only\|approv` → 仅 `extensions.md:104`、`security.md` 项目信任 |
| 36 | `norma-plan-mem.md` §2-NEG-2 | Pi core 无长期记忆（存储/召回/自写入） | `docs/*.md`(40) + sdk.md | `(?i)long-?term memory\|RecallMemory\|RecordMemory\|remember across\|persistent memory\|memory (store\|dir\|file)` | 0；「memory」命中均为进程内存（`codemode.md:226`、`llama-cpp.md:28`）或 in-memory session（`cli.md:99`、`sdk.md:38,42-48`） | `quickstart.md:108` 称 `AGENTS.md` 为 "persistent instructions"；`skills.md:45` 的按需加载——均非动态记忆 |
| 37 | `norma-plan-mem.md` §2-NEG-3 | myflow 无只读代码守卫；`cbmem.ts` 非长期记忆；`A-EXT` 无 plan/memory | `.pi/extensions/myflow/*.ts`、`.pi/{agents,prompts,skills}/**`、`.myflow/scripts/*.py`、`~/.pi/agent/extensions/cbmem.ts`、`pi-subagents-lite/**(.md)` | `(?i)read-?only\|readonly\|readOnly\|plan mode\|memory\|remember` | myflow 仅 `…/references/spec-task-planning.md:69`（描述性，非强制）；cbmem 仅 `codebase-memory-*` 工具；`pi-subagents-lite` 0 | 自然语言「不许改代码」散落 prd/skill 无法穷举（本 NEG 只否定代码级机制）；名称含 memory 易误判 |

**`NEG` 复核结论（C1 已完成）**：本轮 C1 逐条重跑了上表 37 条检索式，并额外用该概念的**正面枚举词 + 相邻文档标题**扫描。
结果是 `#14`、`#33` 为**假阴性**（原断言错，已改动判定），9 条为**部分**（断言字面成立但「命中」列不实或推论码过强）。
**方法约束（沉淀，供后续同类任务）**：凡 `NEG` 的结论是 `O-5`（双方皆无）或「明确无」的条目，
**必须**再做一次「该概念的正面枚举词 + 相邻文档标题」扫描，并在 `NEG` 块内显式列出「**已排除的同义命中**」
（`research/c1-neg-recheck.md` 的 `#14`/`#18`/`#21`/`#26` 写法可作模板）。

---

## 4. 六问之四：推断清单（`E5` 与未验证结论）

### 4.1 `E5`（依据 `Desktop/pi` 1.0.4）

**本横评无可作为判定依据的 `E5` 结论。** 全部 12 个分片自述「未用 `E5`」或「未引用 `Desktop/pi`」。
若最终文档出现任何对 `Desktop/pi` 的引用，一律降级为「推断」，且不得进入正式缺口条目——
本批未发现此类条目。

### 4.2 明确标为「未验证 / 推断」的结论（**不得当作事实**）

| # | 推断内容 | 出处 | 说明 |
| --- | --- | --- | --- |
| I-1 | 「压缩事件在同回合先于 `context` 钩子」 | `contract-risks-and-advantages.md` `RISK-02`、`04-risk-register.md` §3 | 依 `extensions.md:62-64` 的 run 起点顺序 + `compaction.md:37` 的**间接旁证**，非一手原文 |
| I-2 | 「`/fork` 是否**同进程内**即时更换 `getSessionId()`」 | `contract-risks-and-advantages.md` §4 | 「新会话即新 id」本身为 `E1`；同进程即时性为推断 |
| I-3 | 「`before_agent_start` 返回的 message 被持久化为 `custom_message` 条目」 | `contract-risks-and-advantages.md` §4 | `session-format.md:176-178` 定义了该条目类型，未逐字说明该来源 |
| I-4 | `PI_SESSION_ID` 的形状与 `PI_SESSION_FILE` 文件名中的会话 id 一致 | `00-baseline.md` §1（自标 E5/未验证） | 本处不作断言，交由 `T3` 取证 |
| I-5 | 「裸名 `search_graph` 等工具由 `cbmem.ts`（`A-EXT`）还是 MCP `directTools` 提供」 | `norma-ext-integrate.md` §7 | 两条链证据俱在；会话内部无法枚举工具表 → 两者**均**记 `A-EXT` |
| I-6 | 「skill 正文压缩后可由模型重读 SKILL.md 恢复」是**行为**问题 | `norma-ext-integrate.md` §7 | docs 未规定；本横评只判定「无保留机制」，严重度交由缺口册 |
| I-7 | PERM-05 / LOOP-03 / LOOP-04 的 `O-3` 判定 | `norma-perm-loop.md` §6 | 依「原语有、语义无」推断，缺 Pi 执行器细节。**C2 澄清**：`PERM-04` **不在** `I-7` 内，其归属为 `O-2`（`extensions.md:167`「a permission extension」）；`research/c1-neg-recheck.md` §2.8 曾误称 `I-7` 含 `PERM-04`，已修正 |
| I-8 | 「键派生不对称（TS 空 sanitize 回落 `hashValue` vs Python 回落 `None`）理论上错配」 | `norma-noaa-trans-core.md` §2-③ | UUID 形状不触发；理论风险，`R-SOFT`（低） |
| I-9 | 「Pi 内部可能有未文档化的通用 tool-result 上限 / 压缩连败计数」 | `NEG` #11/#18 的残余风险 | 仅文档面未命中，不排除内部实现（C1 已将 #14 移出：其原语已确认存在） |

### 4.3 `T1` 的关键发现（**推断清单必读**）

- **`docs/` 内不存在 `O-2`（刻意外包）的等价表述**。`T1` 逐篇读完 Pi 1.2.0 `docs/` 40 篇后发现：
  唯一支持「刻意外包」的原文是**包根** `README.md:19`（「Pi ships with powerful defaults but skips
  features like sub-agents and plan mode」）。这意味着：**只扫 `docs/` 无法判定 `O-2`**，
  会把 `SUB`/`COORD`/`PLAN` 的刻意外包误记为「双方皆无」（`O-5`）。
  这是 `docs/` 与 README 的覆盖差，也是本横评强制「`O-2` 须引原文」的直接动机（见 `07-method.md` §9）。
- `docs/index.md:3` 只写「extensible AI agent」，**无** README 的「minimal / skips」语义；
  OpenClaw 集成、`pi-share-hf`、开发流程等亦只在 README。

---

## 5. 六问之五：可沉淀清单（`.myflow/spec/` 候选；本任务只产出分析文档，不写 spec）

> 本任务为分析任务、无代码改动，故 `workflow` Step 3.1 `myflow-update-spec` 将记录「无新增契约」。
> 以下是本次取证中发现、**值得沉淀为稳定契约**的候选（供后续任务决定），每条给理由：

| # | 候选契约 | 理由 / 来源 |
| --- | --- | --- |
| D-1 | **会话键派生契约**：`sanitizeKey` 两侧逐字符等价（`[^A-Za-z0-9._-]+→_`、去首尾 `._-`、截 160）+ 「`PI_SESSION_ID` ≡ `getSessionId()`」的端到端断言 | `RISK-01`/`QGAP-CTX-02`：当前为未文档化等价，最易静默失配 |
| D-2 | **`writesUnder` 路径级写范围 + 无界写者禁并行契约** | `ADV-01`、`GAP-PERM-*` 均不得削弱它；部分已存在于 `.myflow/spec/harness/index.md` |
| D-3 | **注入预算契约**：三级上限（单文件 32 KiB / 单 artifact 64 KiB / 合计 128 KiB）+ omitted 提示 + 项目外拒收 | `ADV-03`、`GAP-CTX-04`；是「拒绝静默丢弃」原则的落点 |
| D-4 | **递归守卫三层升级栈样板**（`E-P` 文字 → `E-G` 白名单 → `E-C` 代码） | `ADV-04` / `T2 §4 #1`：可复用样板，用于把 `PLAN-01`/`MEM-03` 等 `E-P` 条目升级 |
| D-5 | **文档契约回归契约**：文档 hook 名集合 == `extension()` 内 `pi.on()` 的 handlers 键集合 | `DOC-DRIFT-01`（`harness-conventions.md` 写 6、实际 7）；有 `tests/workflow-invariant.test.ts:71` 先例 |
| D-6 | **`pi-rounded-tools` `shellPath` 补丁与还原步骤** | `RISK-04`：把 `AGENTS.md` 的口头步骤沉淀为可重放脚手架 |
| D-7 | **verify gate 契约**（含 `channel.py` 把 review worker 并入同一门） | `ADV-08`：一关注点两路强制，是质量基线 |
| D-8 | **Pi 1.2.0 宿主契约快照**：压缩切点规则（禁切 tool result、`custom_message` 是合法切点）、事件时序、`tool_call` fail-safe 阻塞 | `RISK-02`/`NEG` #13–#15：把这些宿主行为固化成快照，便于版本升级时比对 |
| D-9 | **`A-EXT` 核心流程依赖清单**（当前仅 `pi-rounded-tools` 落在 `bash` 核心路径） | `04-risk-register.md` §5：防止未来静默引入 `A-EXT` 核心依赖 |
| D-8b | **宿主文档不一致（待观察）**：`docs/compaction.md:130-138` 未列 `CompactionEntry.systemMessage`，而 `docs/session-format.md:127-131` 列出并定义为完整 system checkpoint | C1 `F-6`；**不据此改判定**（两文档同属 1.2.0，以更完整的 `session-format.md` 为准；差异可能只是 `compaction.md` 未穷举字段，无能力冲突） |

---

## 6. 六问之六：已知薄弱点

1. **无法验证 Pi 未来版本行为**。全部结论锚定 1.2.0；宿主一旦改压缩切点规则或事件时序，
   `RISK-02`（`R-OK`）的补偿会**静默**失效。
2. **`noa` 域为抽样而非逐行**（29 文件 / 11 能力项，实为「关键文件全量 + 其余抽样」）；
   `Norma/examples/`、`Norma/cmd/` 未读。
3. **「仅文档面推断」的条目（C1 修正后）**：`NEG` #11（熔断）、#18（跨工具 net）只证「文档未命中」，不排除内部未文档化实现。
   原列的 #14（紧急截断）与 #33（skill 压缩存活）经 C1 复核为**检索词汇/语料错位**导致的**假阴性**（非「文档未命中」），已移出本清单——机制分别位于 `session-format.md:143-147` 与 `session-format.md:127-131,248`。
4. **Norma 测试未逐行**：`R-T` 依据仅为「存在同名用例」，未验证断言强度（`myflow-enforcement-tiers.md §6`）。
5. **`A-EXT` 行为随版本变化**：`pi-subagents-lite` 1.17.0 / `pi-mcp-adapter` 5.3.0 / `pi-rounded-tools`
   的判定锚定本机实测版本，不含未来版本保证。
6. **本横评未覆盖性能、安全模型与代码质量的完整对标**（范围外），仅在影响能力判定时提及。

---

## 7. 偏离记录（诚实报告）

| # | 偏离 | 实况与影响 |
| --- | --- | --- |
| DV-1 | **分片篇幅超出原计划 + 预算算术漏算开销** | 原计划「每个分片 ≤ 6 KiB」；实际 12 个分片落在 **6.6–17.7 KiB**（B4 后 C3 前合计 111,953 B，**P3 实测 120,079 B**）。最大偏离 `norma-ext-integrate.md` = **17,729 B**。jsonl 策展由计划「implement 5 / check 8」改为「**implement 6 / check 7**」；原记 total 120,099 / 123,573 **漏算了 wrapper + 每文件 header/分隔符（约 1,013 B）且未随 B5 增长重算**——**P3 实测** implement = 126,081 B（slack 4,991）、check 原 7 条 = **131,137 B > 131,072，触发 1 条 omitted**（见 `DV-7`）。**教训**：同类任务应在 dispatch prompt 给定**字节上限**，并在**每次分片改动后**用「含 wrapper/header 的全量注入实算」而非「引用文件字节和」定稿。 |
| DV-2 | **Pi `docs/` 篇数更正** | PRD 起草时写「41 篇」；实测为 **40 篇 `.md`**（+`docs.json`+`images/`），已由 `00-baseline.md §2` 更正。 |
| DV-3 | **PRD `Q3` 的「递归守卫仅靠提示词」反例被分片推翻** | 实证为 `E-C[myflow]`（`index.ts:420-432` 的 `{block:true}`）+ `E-G[myflow→Pi]`（`--tools` 白名单），非仅提示词。已由 `03-gap-register.md` 的裁定 `C-8` 修正；真正只靠 `E-P` 的反例改指 `PLAN-01`/`MEM-03`/`MEM-02`。 |
| DV-4 | **新增域建议尚未决定** | `T1` 反向覆盖发现 4 类「Pi 已给但 §7.2 未列域」的能力：`TRUST`（project trust）、`ENV`（环境契约）、`IPC`（进程集成协议）、`CODE`（codemode 沙箱），另有 14 项建议扩子项（见 `02-matrix.md` §4）。**是否采纳未定**，留待 P4 评审与后续任务决定；本任务不改设计骨架。 |
| DV-5 | **`T2` 的 NEG 计数口径** | `T2` 自述 NEG 为「`PERM-01..05`、`MCP-01..03` 两行」，但正文仅 PERM 行带字面 `(NEG)`。本表按 `T2` 自述记为 2 条（#1/#2）。 |
| DV-6 | **C1 对抗复核推翻/降级 `NEG`** | C1 重跑 37 条 NEG：**2 条假阴性**（`#14` 紧急截断、`#33` skill 跨压缩保留——均为检索词汇/语料错位）、**9 条降为部分**（`#2`/`#4`/`#11`/`#13`/`#17`/`#18`/`#19`/`#21`/`#26`）。受影响判定：`GAP-SKILL-03`（拆 roster/正文）、`GAP-NOA-08`、`CAP-SKILL-03`、`CAP-NOA-08`，以及 `#13` 与 `#21` 使 `CAP-NOA-07`/`CAP-LOOP-02` 的 `O-5`→`O-3`（共 5 条 `O-*` 上调至 `O-3`）。依据 `research/c1-neg-recheck.md`；落地清单见下节。 |
| DV-7 | **P3 实测注入被截断（已修，见 §8 C4-1）** | P3 的 `myflow-check` dispatch 实测 `check.jsonl` = 66,436（artifacts）+ 63,623（refs）+ 1,078（wrapper/header）= **131,137 B > 131,072**，超 **65 B**，故末条 `norma-plan-mem.md`（9,532 B）被替换为 `[myflow: omitted … total context limit reached]`。已从 `check.jsonl` 移除该条（改由 dispatch prompt 点名 `read`），实算新总量 **121,514 B**；`implement.jsonl` 未触限（**126,081 B**）。 |
| DV-8 | **P3 引用/计数修正（见 §8 C4-3、C4 修正记录）** | ① `01-verdict.md` §5 `PLAN` 行 GAP 由 `2` 修为 `1`（`PLAN-03` 已并入 `GAP-PERM-05`）并加口径脚注；② `02-matrix.md` #78 与 `05` `ADV-03` 的「项目外拒收」引用 `ci:436-448` 不指向拒绝代码，改为 `ci:386-394,492-493`；③ `04` `DOC-DRIFT-01` 称 `tests/subagent.test.ts:415` 断言 6+1 不实，改指 `tests/extension.test.ts:166` + `tests/scaffold.test.ts:148-156`；④ `research/norma-plan-mem.md` 的 `cbmem.ts` 由 `A-MCP` 修为 `A-EXT`；⑤ `research/c1-neg-recheck.md` §2.8/行 19 的 `PERM-04` 误述已修（维持 `O-2`）。**均不改判定码或结论**。 |

### C1 复核修正记录（B5：C1 对抗复核的落地改动）

> 本节只登记「C1 裁决 → 改了哪个文件 → 改了什么 → 依据行」，不引入新证据。
> 完整裁决表（37/37）与两条假阴性的决定性原文见 `research/c1-neg-recheck.md` §1/§2。

| C1 裁决 | 受影响的成品文件 | 改了什么 | 依据:行 |
| --- | --- | --- | --- |
| `#33` **假阴性**：Pi 有 skill 跨压缩 roster 保留 | `research/norma-ext-integrate.md` | 重写 `NEG-3`（保留原检索式与漏判原因，补真实命中与「已排除的同义命中」）；表 A `SKILL-03` 行改 `A-PI(部分)`/`O-3`；§5 机制对照改「roster 存活 / 正文不存活」 | `session-format.md:84,127-131,248`、`skills.md:43-45` |
| 同上 | `deliverables/02-matrix.md` | 表 A `CAP-SKILL-03` 行 Pi 侧改 `A-PI(部分)`/`O-3`（与 `CAP-NOA-11` 的 checkpoint 判定对齐）；表 C §3.1 与 §3.3 计数随 5 条 `O-5`→`O-3` 同步 | 同上 |
| 同上 | `deliverables/03-gap-register.md` | `GAP-SKILL-03` 拆为 (a) roster（`V-PI`/`O-1`，非缺口）与 (b) 正文 re-inject（`V-GAP`），改写能力描述/补足标准/不作弊条件，`O-5`→`O-3`；新增裁定 `C-9` 与头部声明 | 同上 |
| `#14` **假阴性**：Pi 有 `context_edit` 运行期改写原语 | `research/norma-noa-integrity.md` | 重写 `NEG-C`（补 `context_edit` 决定性命中与已排除项）；表 A `NOA-08` 行改 `A-PI(原语)`/`O-3`；§4 末条改「缺压力触发判定」 | `session-format.md:143-147,235`、`extensions.md:118` |
| 同上 | `deliverables/02-matrix.md` | 表 A `CAP-NOA-08` 行 `O-5`→`O-3`；表 B 回归 `R-T cit`→`R-∅`（C1 `F-3` 统一口径，邻近 `cit` 保留说明） | 同上 |
| 同上 | `deliverables/03-gap-register.md` | `GAP-NOA-08` 的「Pi 现状」改 `O-3`，缺口收窄为「谁来自动触发 + 选最大未截断结果」；行为规格改为「myflow 侧压力检测/触发」；依赖与代价补宿主契约登记；`P1` 重核后仍为 `P1` | 同上 |
| `#11` 部分：Pi 已有有界单次恢复重试 | `research/norma-cmpt-noa-core.md`；`deliverables/02-matrix.md`；`deliverables/03-gap-register.md` | 表 A `CAP-CMPT-02` 行与 `GAP-CMPT-02` 的 `O-5`→`O-3`，措辞窄化为「无**连败计数**熔断」 | `compaction.md:39,372` |
| `#13` 部分：`session_before_compact` 可选 `firstKeptEntryId` | `research/norma-noa-integrity.md`；`deliverables/02-matrix.md`；`deliverables/03-gap-register.md` | `NEG-B` 补正面命中；表 A `CAP-NOA-07` 行与 `GAP-NOA-07` 的 `O-5`→`O-3`；`V-GAP` 不翻转（仍无命名名单） | `compaction.md:302-320,138` |
| `#21` 部分：core 给互斥原语 + 读写注解 | `research/norma-perm-loop.md`；`deliverables/02-matrix.md`；`deliverables/03-gap-register.md` | 表 A `LOOP-02` 行与 `GAP-LOOP-02` 的 `A-NONE`/`O-5`→`A-PI(原语)`/`O-3` | `extensions.md:144,167,172-174`、`mcp.md:254` |
| `#19` 部分：措辞统一 + **归属码维持 `O-2`** | `research/c1-neg-recheck.md`（§2.8、§1 行 19）；`deliverables/02-matrix.md` | **C2 修正**：原写「正确码是 `O-3`、与 `I-7` 一致」不实——`I-7` 记 `PERM-05`/`LOOP-03`/`LOOP-04`，不含 `PERM-04`；`CAP-PERM-01/04` 一直为 `O-2`（`extensions.md:167`「a permission extension」）。现统一为「无内建求值器；决策点由 core 提供」，码 `O-2` | `docs/extensions.md:167,170-178`、`docs/mcp.md:252` |
| `#2`/`#4`/`#26` 部分：命中列不实 | `research/myflow-enforcement-tiers.md`、`research/pi-surface-completeness.md`、`research/norma-noaa-trans-core.md`；本文 §3 | 三条 `NEG` 的「命中」列补全真实命中（`.pi/**` ≥14 处 `mcp`、`spawnHook` 4 处、`mcp.md:77`/`rpc-commands.md:691`）；裁决改「部分」；**判定/结论码不变** | `environment-variables.md:53,57,64,69`、`mcp.md:77`、`rpc-commands.md:691` |
| `#17`/`#18`/`#19` 部分：措辞化/窄化 | `research/norma-llm-tool.md`、`research/norma-perm-loop.md`；`deliverables/03-gap-register.md` | `#17` 明写「校验能力存在」（`CAP-TOOL-02` 仍 `O-1`）；`#18` 窄化 `GAP-TOOL-06` 的「Pi 无统一 net」为「只对内建工具」；`#19` 措辞改「无内建求值器；决策点由 core 提供」（`PERM-01/04` 仍 `O-2`） | `extensions.md:135,145,170-178`、`codemode.md:48`、`dist/index.js:30` |
| 附带 `F-1`：`on()` 实为 41 项 | `research/norma-ext-integrate.md`、`deliverables/02-matrix.md`、`deliverables/01-verdict.md`、本文 §3 | 42 → 41（表 A `HOOK-01`、表 B `HOOK`、记分卡 `HOOK`、`NEG#31`） | `types.d.ts:1186-1228` |
| 附带 `F-5`：`pi-mcp/README.md:132` 更强正证 | `deliverables/02-matrix.md`、`deliverables/03-gap-register.md`、本文 §3 | 补入 `CAP-MCP-02` 行与 `GAP-SKILL-04` 依赖说明、`NEG#32` 命中列 | `pi-mcp/README.md:132` |
| 附带 `F-6`：宿主文档字段描述不一致 | 本文 §5（`D-8b`） | 登记为「宿主文档不一致（待观察）」；**不据此改判定**（以 `session-format.md` 为准） | `compaction.md:130-138` vs `session-format.md:127-131` |
| 附带 `F-2`：NEG 语料漏 Pi `examples/**` | 本文 §2 | 未读清单补 `examples/**` 与 `CHANGELOG.md`，并说明其**强化** `O-2` 证据 | `03-gap-register.md`（`GAP-PLAN-01`，C1 原引 `:330`） |

---

## 8. 交叉校验（P3 结论）

> 本节由 P3 对抗式交叉校验填写：`C1` 由 `myflow-research` 完成（分片 `research/c1-neg-recheck.md`），
> `C2`/`C3`/`C4` 由 `myflow-check` 完成。数值均为 P3 实测（myflow@`0a702fa`、Pi 1.2.0、Norma@`52f17dd`）。
> 校验未通过项一律已回修或登记为「P3 发现」。

### C1 — 负向断言复核

- **复核条数**：**37/37**（§3 全表逐条重跑原检索式，并额外用「该概念的正面枚举词 + 相邻文档标题」再扫一遍；无法复核 0）。
- **四类裁决计数**：**成立 26 / 假阴性 2 / 部分 9 / 无法复核 0**。
- **2 条假阴性（原断言错，已改判定）**：
  - `#14` 紧急截断：原检索式 `truncate.*context|emergency.*truncate|shrink.*tool result|rewrite.*result|compress.*tool output` 命中 0，**漏了 Pi 的 `context_edit`**。决定性原文：`docs/session-format.md:143-147,235`（ContextEditEntry 可 append-only 改写**已存** entry，只改未来 model context，targets 可为 tool-result）与 `docs/extensions.md:118`。影响：`CAP-NOA-08` 由 `A-NONE`/`O-5` 改 `A-PI(原语)`/`O-3`，`GAP-NOA-08` 收窄为「谁来自动触发 + 选最大未截断结果」。
  - `#33` skill 跨压缩保留：原检索式只查 `docs/compaction.md` 的 `skill` 字面，**漏了 `session-format.md`**。决定性原文：`docs/session-format.md:84,127-131,248`（`CompactionEntry.systemMessage` 是完整 system checkpoint，pre-compaction system messages 折入该 checkpoint）与 `docs/skills.md:43-45`。影响：`CAP-SKILL-03` 由 `A-NONE`/`O-5` 改 `A-PI(部分)`/`O-3`，`GAP-SKILL-03` 拆为「roster 存活 = 非缺口」+「正文逐字 re-inject = 缺口」。
- **9 条「部分」的处置**（`#2`/`#4`/`#11`/`#13`/`#17`/`#18`/`#19`/`#21`/`#26`）：断言字面成立，但「命中/残余风险」列不完整或归属码过强；已按 §7 的 `### C1 复核修正记录` 逐条回改（命中列补全 / 措辞窄化 / 5 条 `O-5`→`O-3`），**结论码无一翻转**。其中 `#19` 的归属码**维持 `O-2`**（见 C2）。
- **指针**：逐条检索式、裁决与决定性原文见 `research/c1-neg-recheck.md` §1/§2；§3 表的「命中」列已带裁决标记。

### C2 — 层级复核

**范围**：`02-matrix.md` 表 B 全部 **29** 个含 `E-C` 的条目 + `03-gap-register.md` 全部 `E-C` 现状声明 + `05-advantage-register.md` 的 `ADV-*` 级别。
**做法**：对每个 `E-C` 要求指出「会拒绝的代码行」（`throw` / `return {block:true}` / 非零退出 / 显式上限），并在当前工作树逐行核对。

**C2 复核表（有拒绝路径者，15 条）**

| 判定位置 | 声称 | 会拒绝的代码行（P3 实测） | 结论 |
| --- | --- | --- | --- |
| 表 B #7 / #13 `TOOL-03`/`PERM-03` | `E-C[myflow]` | `ix:451` `return { block: true, reason }`（写范围越界） | 维持 |
| 表 B #17 `LOOP-02` | `E-C[myflow]` | `sb:641-648` `throw`（无界写者禁并行） | 维持 |
| 表 B #20 `LOOP-05` | `E-C[myflow]` | `sb:473-476` `killChildTree`；`sb:545` `throw new Error("Subagent was aborted")` | 维持 |
| 表 B #21 `LOOP-06` | `E-C`+`E-G` | `sb:64` 显式上限 + `sb:473-484` + `sb:519` `finish(124)`；`ix:490` `verifyAttempts >= MAX_VERIFY_ATTEMPTS` | 维持 |
| 表 B #23 `SUB-02` | `E-C`+`E-G` | `ix:426-431` `{block:true}`；`sb:403` `--tools` 白名单 | 维持 |
| 表 B #26 `COORD-02` | `E-C[myflow]` | `sb:633-634` `throw`（超 `maxItems`）+ `sb:262` schema 上限 | 维持 |
| 表 B #59 `HOOK-02` | `E-C[myflow]` | `ix:426-431,451`（同上） | 维持 |
| 表 B #61 `HOOK-04` | `E-C[myflow]` | `ix:486-495` `return {continue:true,…}` + `ix:490` 有界 | 维持 |
| 表 B #65 `SKILL-01` | `E-C[myflow]` | `tests/skills-hygiene.test.ts:29-65` 断言失败即非零退出（**测试型**拒绝） | 维持 |
| 表 B #70 `PLAN-02` | `E-P`/`E-C` | `task.py:496-507` `return 1`（空 manifest 拒 `start`） | 维持 |
| 表 B #77 `CTX-02` | `E-C[myflow]` | `tc:22-33,84-98` → `no_task`（指针越界/投毒） | 维持 |
| 表 B #78 `CTX-03` | `E-C[myflow]` | `ci:386-394` 返回 `null` + `ci:493` `continue`（项目外拒收）；`ci:142-170` 换 `omitted` | 维持（**引用已修正**：原 `ci:436-448`） |
| 表 B #81 `TEST-01` | `E-C[myflow]` | `ix:486-495`；`worktree.py:496-507` `return 1` | 维持 |
| 表 B #82 `TEST-02` | `E-C[myflow]` | `tests/**` 非零退出；`tests/workflow-invariant.test.ts:71`（**测试型**） | 维持 |
| `ADV-01`/`ADV-02`/`ADV-04`/`ADV-08` | `E-C[myflow]` | `sb:641-648` / `sb:473-484` / `ix:426-431` / `ix:486-495` | 维持 |

**14 条「代码执行型、无拒绝路径」的 `E-C`**（表 B #5 `TOOL-01` 注册动作、#22 `SUB-01`、#24 `SUB-03`、#25 `COORD-01`、#31 `CMPT-05`、#42 `NOA-11`、#43 `NOAA-01`、#45 `NOAA-03`、#52 `TRANS-03`、#58 `HOOK-01`、#60 `HOOK-03`、#76 `CTX-01`、#79 `OBS-01`、#80 `OBS-02`；另 `ADV-03`/`ADV-05`/`ADV-06`/`ADV-09`/`ADV-10`）：
这些条目由 myflow 代码**确定性执行**（注入 / 日志 / 状态 / 注册 / 结果回传），但代码路径**不做拒绝**，故无 `throw`/`{block}`/上限可指。
- **处置：0 条降级。** 理由：降为 `E-G`（可达集被限）或 `E-P`（提示词）在本处**为假**——它们既非白名单也非提示词；降为 `E-N`（无机制）更与事实相反。
- **P3 发现（设计层面，仅报告，不改 `design.md`）**：`design.md` §4.1 的 `E-C` **判据**列（「存在会拒绝的代码路径」）窄于同表 `E-C` **失效方式**列（「只有改代码才失效」）；前者只覆盖「守卫型」条目，后者才覆盖「执行型」条目。建议下一轮为 §4.1 增一行「`E-C`（执行型）：行为由代码路径决定、不经模型自律，证据=该路径的行号」，或为执行型另立代号。本表按「失效方式」列判定，维持 `E-C`。

**`R-T` 断言体抽查（≥4 个，回退即红）**

| 测试 | 被锁定的行为 | 断言体证据 | 结论 |
| --- | --- | --- | --- |
| `tests/subagent.test.ts:308` | 无界写者禁并行 | `assert.rejects` 且匹配 `/bounded writer/`、`/writesUnder/` | 真锁 |
| `tests/subagent.test.ts:208` | 超时杀树 + 日志 | 断言 `run.timedOut`、`exitCode===124`、日志文件存在且含输出、子进程被杀 | 真锁 |
| `tests/subagent.test.ts:434` | 递归守卫 | 断言 `result.block===true`、reason 含 `Recursion guard` 与 agent 名 | 真锁 |
| `tests/subagent.test.ts:456` | 路径级写范围 | 断言越界 `block===true`、空 input fail-closed | 真锁 |
| `tests/extension.test.ts:224` | 压缩后重注入 | 先断言 fresh 时「no-op」，再断言压缩后 `context` 重挂 `workflow-state` | 真锁 |
| `tests/task-gate.test.ts:81` | 空 manifest 拒 `start` | 断言 `status !== 0`、stderr 含 `/no curated entries/`、`/add-context/`、`/--allow-empty-context/`，且 status 未被半置 | 真锁 |
| `tests/context-injection.test.ts:226` | 项目外引用拒收 | 断言 `resolveProjectFile` 逃逸根返回 `null` | 真锁 |

- **发现项（已修）**：`tests/subagent.test.ts:415` 标题为「all 6 hooks」、断言仅 6 个 handler，**不含** `agent_before_settle`；`04-risk-register.md` `DOC-DRIFT-01` 原据此支撑「7 个」判定不成立。已改指真正钉住 7 键的 `tests/extension.test.ts:166` 与 `tests/scaffold.test.ts:148-156`（后者以 `deepEqual` 锁全量键集）。
- **结论**：`E-C` **降级 0 条**；`R-T` 抽查未见「标题是 A、断言是 B」（除上条已修）。

### C3 — 归属复核（`design.md` §6 测 A 卸载测试）

**做法**：假想删除全部 `A-MF` 资产（`.pi/extensions/myflow/`、`.pi/agents/`、`.pi/prompts/`、`.pi/skills/`、`.myflow/`）与全部 `A-EXT` 资产（`~/.pi/agent/npm/node_modules/`、`~/.pi/agent/extensions/`、`~/.pi/agent/skills/`），仅留 Pi core 安装目录，判断能力是否仍在。

**C3 复核表**

| 条目 | 声称归属 | 卸载测试结果（含注册者实证） | 结论 |
| --- | --- | --- | --- |
| `Agent`/`StopAgent`/`MessageAgent`/`AgentStatus`（`MIS-01`） | `A-EXT:pi-subagents-lite` | 删包即消失；唯一注册者 `~/.pi/agent/npm/node_modules/pi-subagents-lite/src/registration.ts:66,121,132,143`（`name:`）+ `:112,129,140,149`（`registerTool`），版本 1.17.0 | 维持 |
| MCP 工具（`MIS-02`、`NG-33`/`NG-34`） | `A-EXT:pi-mcp-adapter`（core 有但停用） | Pi core **确**有内建，但 `~/.pi/agent/settings.json` 的 `extensions:["-builtin:mcp"]` 显式关闭；写开关者 `pi-mcp-adapter/pi-builtin-mcp.ts:10-25`、`index.ts:1725` | 维持 |
| `cbmem.ts` 裸名工具（`MIS-03`） | `A-EXT`（**非** MCP、非 core） | 源码 `~/.pi/agent/extensions/cbmem.ts:8-14` 以 `spawn` 直调 `codebase-memory-mcp.exe cli` 注册裸名工具，无 MCP 协议；删扩展即消失 | 维持（**分片已修**：`norma-plan-mem.md` 原记 `A-MCP`） |
| O-1 宿主内建（31 项） | `A-PI` | 逐项落 `docs/*.md` 或 `dist/core/extensions/types.d.ts`；`~/.pi/agent/` 下无任何扩展注册同名能力 | 维持 |
| `bash`（`RISK-04`） | `A-PI` 原语 + `A-EXT:pi-rounded-tools` 重注册 | core 提供 `createBashTool(cwd,{shellPath})`（`docs/cli.md:111-120`）；扩展仅重注册并依赖本机补丁 | 维持 |
| `V-EXT` 2 项（`MCP-01`/`MCP-03`） | `A-EXT` | 同上（MCP 行） | 维持 |
| `V-UP` 2 项（`LOOP-03`/`LOOP-04`） | 上游约束 | core 行为，删 `A-MF`/`A-EXT` 仍在 | 维持 |
| `MIS-04` `AGENTS.md` 非长期记忆 | `A-PI` 静态 context file | `docs/configuration.md:18`、`docs/quickstart.md:108`；无召回/陈旧告警 | 维持 |
| `MIS-06` `O-2` 唯一原文 | `README.md:19` | 逐字命中「skips features like sub-agents and plan mode」 | 维持 |
| `MIS-07` `noa`/`noaadapter`/`transcript` | 实现包 | 行数实测 5392 / 1918 / 268 | 维持 |
| `MIS-08` 两套 agent 目录 | `.pi/agents`（`A-MF`）vs `.myflow/agents`（channel 专用） | `agents.ts:228-243` 只扫 `.pi/agents`；`channel.py:75` `AGENTS_DIR = .myflow/agents` | 维持 |

- **结论**：核实 `O-1`/`V-EXT`/`V-UP`/`MIS-*` 全部条目，**修正 1 条**（`cbmem.ts`：`A-MCP`→`A-EXT`，发生在分片，成品 `MIS-03` 原本即正确）。
- **额外排查（防 `A-EXT` 隐形提供）**：对 `~/.pi/agent/npm/node_modules/` 与 `~/.pi/agent/extensions/` 全包检索 `plan[- ]?mode|read-?only`、`registerTool` 与已注册工具名，确认：
  `pi-subagents-lite` 只有一个**提示词级**的「read-only exploration agent」（`src/agents/default-agents.ts:30-52`，非 plan-mode / 非阶段门），不构成 `CAP-PLAN-01` 的宿主提供；
  `pi-ask-side` 是隔离子会话的 side-question 扩展（无审批工具），不构成 `CAP-PERM-01` 的 `ask`；
  `pi-agent-loop` 仅注册 `loop_control`（外层 goal/pass 循环），不是核心 agent 循环（`CAP-LOOP-01` 仍 `A-PI`）；
  `pi-rounded-tools` 的 `mode` 是 UI frame 模式，不是 read/write 调度器。故 `PLAN-01` 的 `A-NONE`/`O-2` 与 `LOOP`/`PERM` 的 `A-PI`/`A-NONE` 判定均不变。

### C4 — 预算、完整性与计数复核

**1) 注入未截断 —— 首次实测不通过，已修（`DV-7`）**

用「含 wrapper + 每文件 header/分隔符」的全量注入实算：

| manifest | 条数 | 引用字节 | artifacts | wrapper/header | **注入实算** | 限值 | 余量 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `implement.jsonl` | 6 | 58,632 | 66,436 | 1,013 | **126,081** | 131,072 | 4,991 ✓ |
| `check.jsonl`（P3 修复前） | 7 | 63,623 | 66,436 | 1,078 | **131,137** | 131,072 | **-65 ✗** |
| `check.jsonl`（P3 修复后） | 6 | 54,091 | 66,436 | 987 | **121,514** | 131,072 | 9,558 ✓ |

- 修复前的 `check.jsonl` **超出 65 B**，P3 的 `myflow-check` dispatch 实际出现
  `[myflow: omitted …research/norma-plan-mem.md (9532 bytes) — total context limit reached]`。
- **修复**：从 `check.jsonl` 移除 `norma-plan-mem.md`（改由 dispatch prompt 点名 `read`，其内容已由 P3 手工读取并纳入校验）。
- 结论：**修复后两个 manifest 均不触限**；原文档记的 `120,099` / `123,573` 为**漏算开销**的旧值，已由 `DV-1` 更正。
  这些旧值同时存在于 `implement.md` §6 与 `prd.md` Technical Notes（起草期实测）；按「不改 PRD/design」纪律，本任务**只更正交付物与本记录**，并在本节留下指针供后续任务警惕。

**2) 交付完整 —— 通过**：`deliverables/` 下 9 份齐全，编号与 `design.md` §8.1 逐项一致
（`README.md` + `01-verdict.md` + `02-matrix.md` + `03-gap-register.md` + `04-risk-register.md` +
`05-advantage-register.md` + `06-non-gaps.md` + `07-method.md` + `08-coverage.md`）。

**3) 计数对账 —— 修 1 处（`DV-8`）**

| 对象 | 计数（P3 实测） | 对账 |
| --- | --- | --- |
| `02-matrix.md` 表 C `V-*` | `V-GAP` 29 / `V-QUAL` 6 / `V-OWNED` 7 / `V-PI` 32 / `V-EXT` 2 / `V-UP` 2 / `V-ADV` 4 / `V-NA` 0 = **82** | ✅ 与表 A/表 B 行数（各 **82**，`CAP-*` 逐项一致）对齐 |
| 表 C `O-*` 分布 | `O-1` 31 / `O-2` 6 / `O-3` 16 / `O-4` 1 / `O-5` 21 / `O-6` 7 = **82** | ✅ 与 B5 后预期一致 |
| `03-gap-register.md` | `^#### GAP-` = **29**；`^#### QGAP-` = **6**；`P0` 2 / `P0-R` 1 / `P1` 6 / `P2` 27 | ✅ 与 `01` §4.1/§4.2 一致（`QGAP-CTX-02` 同记 `P1`+`P0-R`） |
| `04` / `05` / `06` | `RISK` = 6（`R-HARD` 1 / `R-SOFT` 4 / `R-OK` 1）；`ADV` = 10（★6）；`NG` = 36 + `MIS` = 8 | ✅ |
| `01-verdict.md` §5 逐包表 | `PLAN` 行原记 GAP `2`，与合计 `29` 差 1 → 已修为 `1` 并加口径脚注 | **已修** |

**4) 无实现改动 —— 通过**：`git status --short` 仅见 `.myflow/tasks/norma-benchmark-gap-analysis/`
（`design.md`/`implement.md`/`prd.md`/`task.json` 为 planning 阶段既有改动；`check.jsonl`/`implement.jsonl`/`deliverables/`/`research/` 为本任务产物）。
`.pi/`、`.myflow/scripts/`、`.myflow/workflow.md`、`.myflow/spec/`、`tests/` **零改动**。

**5) PRD AC 逐条核对**

| # | AC | 状态 | 证据文件:节 |
| --- | --- | --- | --- |
| 1 | 覆盖 Norma 16 包 + 每项 Norma 证据 | ✅ 通过 | `02-matrix.md` §1（82 `CAP-*`）、§0 |
| 2 | `NOA`≥9 / `NOAA`≥5 / `TRANS`≥3 | ✅ 通过（11 / 7 / 4） | `02-matrix.md` §1 覆盖自检 |
| 3 | Pi 判定指向 1.2.0 文档/API + 版本 | ✅ 通过 | `02-matrix.md` §1 表头 `[v1.2.0]`；少数「Pi 无」行以 `NEG` 块（语料 + 检索式）定位，见本文 §3 |
| 4 | 缺口条目含 8 必备字段 | ✅ 通过（模板 9 字段） | `03-gap-register.md` §1 |
| 5 | ≥3 项「看似缺口实际不是」 | ✅ 通过（8 项） | `06-non-gaps.md` §2 |
| 6 | 「有」附强制层级 + ≥2 项提示词实证 | ✅ 通过 | `02-matrix.md` 表 B；`PLAN-01`/`MEM-03`/`MEM-02` |
| 7 | 契约风险覆盖会话键/压缩交互/runtime 本地性 | ✅ 通过 | `04-risk-register.md` `RISK-01`/`RISK-02`/`RISK-03` |
| 8 | ≥3 项相对优势标不可回退 | ✅ 通过（6 条 ★） | `05-advantage-register.md` §0/§1 |
| 9 | 区分已核实/推断 + 取证边界 + `NEG` 集中清单 | ✅ 通过 | 本文 §1–§4（含 `NEG` 37 条） |
| 10 | `../critic_doc/` README + 8 正文 + `evidence/` + 来源提交号 | ⏳ **部分（待 P4）** | 交付落点在 `deliverables/`；发布由主会话在 P4 执行（`design.md` ADR-6/§13） |
| 11 | 中文撰写、术语保留英文 | ✅ 通过 | 全部文档 |

- **DoD「实际注入未触发 `[myflow: context limit reached …]`」**：**首次不通过，已修**（`DV-7`）。修复后实算均不触限。

**6) 测试基线定性 —— 预存环境泄漏，非本任务引入**

本任务零代码改动，故用三种环境分别跑 `node --test tests/`：

| 环境 | tests | pass | fail | 失败用例 |
| --- | --- | --- | --- | --- |
| 清空 `MYFLOW_AGENT_TYPE`/`MYFLOW_CONTEXT_ID`/`MYFLOW_SKIP_BREADCRUMB`/`MYFLOW_WRITES_UNDER`/`MYFLOW_VERIFY_GATE` | 215 | **215** | **0** | — |
| 仅 `MYFLOW_AGENT_TYPE=myflow-check` | 215 | 213 | **2** | `session_start: main session sends session-context`；`tool_call: main session does not block myflow_subagent` |
| 仅 `MYFLOW_CONTEXT_ID=pi_01a13a2f-…` | 215 | 200 | **15** | `deriveContextKey`/session-start/task.py 指针类用例 |
| 两者皆设（= 本会话实际环境） | 215 | 198 | **17** | 上述两组 |

- 定性：失败**全部**由宿主会话泄漏的 `MYFLOW_*` 环境变量造成（前者令 `isSubAgent` 误判、后者覆盖会话键派生），
  清空即 **215/215 通过**。B4 报告的「2 个失败」与「仅 `MYFLOW_AGENT_TYPE`」一栏**完全吻合**；
  本会话实测为 17，差异源于 `MYFLOW_CONTEXT_ID` 亦泄漏。**结论：预存环境敏感性，非本任务引入。**

**C4 修正记录**：`check.jsonl` 移除 `norma-plan-mem.md`（预算）；`01-verdict.md` §5 `PLAN` 计数；
`02-matrix.md` #78 与 `05-advantage-register.md` `ADV-03` 的 `ci` 引用；`04-risk-register.md` `DOC-DRIFT-01` 的 `sbt:415`；
`research/norma-plan-mem.md` 的 `cbmem.ts` 归属；`research/c1-neg-recheck.md` 的 `PERM-04` 措辞。均只改引用/计数，未改判定码。

---

## 9. 需新证据 / 未完成

**需新证据：无。** 本文全部结论均可回溯到 12 个 `research/*.md`、`02-matrix.md`、`03`–`06` 的既有证据与 `00-baseline.md` 的实测；
§7 的偏离记录为对既有事实的诚实报告，§4 的推断清单为既有分片已声明的薄弱点。

**未完成：无。** 六问逐问回答完毕；`NEG` 集中清单 **37** 条（C1 复核：成立 26 / 假阴性 2 / 部分 9）；偏离记录 **8** 项（`DV-1`–`DV-8`）；
`C1` 复核修正记录见 §7 的 `### C1 复核修正记录`；**§8 的 `C1`–`C4` 已由 P3 填写完毕**（C2/C3 各出复核表，C4 出预算实算、AC 逐条表、测试基线定性）。

**发布前剩余动作（属主会话 P4，非本任务未完成）**：按 `design.md` §13 把 `deliverables/` 9 份与 `research/` 快照发布到 `../critic_doc/`，并写入来源提交号。
