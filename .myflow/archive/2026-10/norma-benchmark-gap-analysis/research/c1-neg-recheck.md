# C1 — 负向断言对抗式复核（`NEG` recheck）

> **分片**：`C1`（P3 交叉校验之一），执行者 `myflow-research`（工具白名单 `read, write, find, grep, ls`，**无 bash / 无 MCP**）。
> **目标**：**推翻**现有 37 条 `NEG`，而不是复述它们。工作清单 =
> `deliverables/08-coverage.md` §3「`NEG` 集中清单」的 37 行；原文核对 = `research/*.md` 的 `(NEG)` 块。
> **语料**（逐类记录）：Pi 1.2.0 安装面 `C:/Users/wocai/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/`
> （`docs/` 40 篇 `.md`、`schemas/`、`dist/**`、包根 `README.md`、`CHANGELOG.md`、`examples/**`）、
> 同安装目录 `pi-mcp/`、`pi-agent-core/` 等；myflow 面 `C:/Users/wocai/Desktop/myflow/.pi/`、`.myflow/`、`tests/`；
> Norma 面 `C:/Users/wocai/Desktop/Norma/`。
> **时间锚点**：myflow `0a702fa`（+ 本任务 artifact 未提交改动）；Norma `52f17dd`；Pi `1.2.0`。

---

## 0. 结论摘要

**本片共复核 37 条，其中成立 26 / 假阴性 2 / 部分 9 / 无法复核 0。**

| 裁决 | 条数 | 编号 |
| --- | --- | --- |
| **假阴性**（原断言错，会改动判定） | **2** | `#14`、`#33` |
| **部分**（断言字面成立，但「命中」列不实或推论码过强） | **9** | `#2`、`#4`、`#11`、`#13`、`#17`、`#18`、`#19`、`#21`、`#26` |
| **成立**（重跑 + 正面枚举词 + 相邻标题三路均未推翻） | **26** | `#1`、`#3`、`#5`、`#6`、`#7`、`#8`、`#9`、`#10`、`#12`、`#15`、`#16`、`#20`、`#22`、`#23`、`#24`、`#25`、`#27`、`#28`、`#29`、`#30`、`#31`、`#32`、`#34`、`#35`、`#36`、`#37` |
| **无法复核** | **0** | —（全部 37 条都在可读语料内，无一落在不可读的二进制上；见 §3） |

**两条假阴性的共同成因不同，都值得沉淀**：

1. `#33`（skill 跨压缩保留）—— **同一份文档集内的自相矛盾**。`02-matrix.md:76`（`CAP-NOA-11`）已经写明
   「压缩写 system checkpoint，system 段存活于压缩」，而 `02-matrix.md:101`（`CAP-SKILL-03`）却判 `A-NONE`。
   成因：检索式只查 `compaction.md` 里的字面 `skill`，而机制文档在 **`session-format.md`**。
2. `#14`（运行期改写已存工具结果）—— **检索词汇库错位**。原文用的是 *rewrite / shrink / truncate*，
   Pi 用的是 **`context_edit` + `replacement` / `omits`**。成因与上一轮那次「模式过窄假阴性」同源。

另有 **6 条附带发现**（不属于 37 条本身，但同属负向断言的方法性风险，见 §5）。

---

## 1. 裁决表（逐条，37/37）

「重跑命中」= 用原声明检索式在当前语料上重跑的结果；「正面枚举命中」= 换成同义/正面枚举词后的结果；
「相邻标题」= 同语料 `grep -n '^#'` 的标题命中。`E` = 依据路径。

| # | 原断言（一句话） | 原检索式 | 原声明命中 | 重跑命中 | 正面枚举词命中 | 相邻标题 | 裁决 | E |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | myflow 无 allow/deny/ask 求值 | `.pi/**`；`permission\|deny\|allow` | 无求值管线 | 同：仅 `myflow-brainstorm/SKILL.md:319`（清单文字）、`myflow-meta/references/harness-conventions.md:79-80`（verify gate） | `approve\|confirm\|gate\|guard\|policy` → `subagent.ts:392-394`(`--approve`)、`pi-coding-agent.d.ts:26`(`ui.confirm` 类型)、`index.ts:423-434`(递归/path guard)、`index.ts:459-489`(verify gate) | `.pi/` 无 `#` 标题体系 | **成立**（`E-C` 守卫存在，但不是 allow/deny/ask 求值器） | `.pi/skills/myflow-brainstorm/SKILL.md:319`、`.pi/extensions/myflow/index.ts:420-452` |
| 2 | myflow 无 MCP 集成 | `.pi/**`；`mcp` | 仅 `subagent.ts:69` 注释 | **同语料 ≥14 处**：`skills/myflow-spec-bootstrap/references/mcp-setup.md:11,18,22,23,25,34,39-43,55,87`、`…/repository-analysis.md:13,16,36`、`myflow-meta/references/harness-conventions.md:74`、`extensions/myflow/subagent.ts:69` | `mcpServers` → 同上；无任何 `.ts` 消费 MCP | 同上 | **部分**（断言成立：myflow 只**文档化** Pi 的 MCP，不实现/不消费；但「命中 = 仅 1 处」不实） | `.pi/skills/myflow-spec-bootstrap/references/mcp-setup.md:18-25` |
| 3 | Norma 无「按 agent 声明限制写入路径」 | `../Norma/**/*.go`；`writesUnder\|WriteScope\|allowedPath\|AllowedPath` | **0** | **0** | `writeScope\|scope.{0,10}sandbox` → 0；`sandbox` → `tool/bash.go:19`（**仅宿主建议**「a full sandbox — hosts should still gate Bash via CanUseTool」）；`read-?only\|readOnly` → `memory/tools.go:29,66`、`plan/plan.go:84,86,110-112`、`tool/{files,ls}.go`、`permission/permission.go` | `permission/`、`plan/` | **成立**（Norma 有逐工具 `ReadOnly` 谓词与 `Permissions` 谓词，但**无路径范围**概念；`ADV-01` 不受影响） | `Norma/permission/permission.go:33`、`Norma/plan/plan.go:84-98` |
| 4 | Pi 无内建子代理/代理派生 | `docs/*.md`(40)；`(?i)sub-?agent\|spawn\|parallel agent\|teammate\|orchestrat\|swarm\|multi-agent` | **0**（`orchestrat` 仅 `extensions.md:158,181`） | **非 0**：`spawn` 命中 `environment-variables.md:53,57,64,69`（`spawnHook` = **进程** spawn 钩子）；`orchestrat` 命中同原声明 | 同重跑；另 `swarm\|teammate\|consensus` → **0** | `compaction.md` 标题无 subagent 相关 | **部分**（断言成立：无内建子代理；但「命中 = 0」不实，`spawnHook` 本应列入并以「非代理」排除） | `docs/environment-variables.md:53-69` |
| 5 | Pi `docs/` 无 plan mode | `(?i)plan mode\|plan-mode\|planner\|\bplan\b` | `virtual-models.md:93,98,99`、`providers.md:46-65` | 同（`virtual-models.md:93,98,99,114`；`providers.md:47-66` 的 `ZAI Coding Plan`/`Qwen Token Plan` 等） | `read-?only\|approv` → `extensions.md:104` 无、`security.md:29-33,61,82`（project trust） | 同 | **成立**（`docs/` 内无 plan mode；唯一 `O-2` 正证 = 包根 `README.md:19`，**不是** `:15`） | `README.md:19` |
| 6 | Pi 无内建工具审批/permission 系统 | `(?i)permission\|allow/deny\|permissionMode\|approve\|confirm before` | `security.md:3`、`extensions.md:167-179`、`mcp.md:252-254`、`skills.md:78`、`cli.md:237-239` | 同 + `how-pi-works.md:47-49`、`index.md:39`、`security.md:29,33,61,82`、`models.md:154-156`、`termux.md:48,56,104-106` | `canUseTool\|gate\|guard\|policy` → `extensions.md:167-179`（**示例**用 `tool_call`+`ui.confirm` 自建门） | 同 | **成立**（`security.md:3` 原文「it does not ask for approval before every tool call」是最强正证） | `docs/security.md:3`、`docs/extensions.md:167-179` |
| 7 | Pi `docs/` 无 noa 式分层/ref/nudge 压缩 | `m00001\|ref tag\|content hash\|\btier\b\|nudge` | `models.md:94,100`、`custom-provider.md:95`（promptCache「retention tier」） | 同（`tier` 仅 promptCache；`m00001`=0；`ref tag`=0；`content hash`=0；`nudge`=0） | `layer\|nested summary\|summary of summary\|multi-level` → 0 | `compaction.md` 标题 = Overview/When It Triggers/How It Works/Overflow…/Split user-message spans/Cut Point Rules/CompactionEntry Structure/Branch Summarization/Summary Format/Message Serialization/Custom Summarization via Extensions/Settings | **成立** | `docs/models.md:94,100` |
| 8 | 无 ref 寻址 | `docs/*.md`(40)；`tier\|m0000\|ref address\|message ref` | tier 仅 promptCache，余 0 | 同 | `reference.{0,10}message\|addressable` → 0；`ref\b` → 仅 `packages.md:34,38,127`（**git ref**） | 同 | **成立** | `docs/packages.md:34` |
| 9 | Pi 无模型可调用的压缩工具 | `compress\|context_edit\|model-selectable\|choose.*messages.*summar` | `compress`=0；`context_edit` 5 处 | 同（`compress`=**0**；`context_edit` = `compaction.md:93,138`、`extensions.md:118`、`session-format.md:144,235,245`） | `summar` → 全在 `session_before_compact` / `session_compact_failed` / `generateSummary`（**扩展驱动**，非模型驱动） | 同 | **成立**（压缩可由**扩展**拦截，不可由**模型**调用工具触发） | `docs/compaction.md:293-320`、`docs/session-format.md:144` |
| 10 | Pi 无分层摘要 | `tier 分层\|layered summary\|multi-level compact` | 0 | **0** | `previousSummary\|nested summary\|re-?compact` → `compaction.md:47,83,307`（**迭代**复用上一份 summary，非同层不合压） | 同 | **成立** | `docs/compaction.md:47,83` |
| 11 | 无压缩熔断 | `docs/compaction.md`；`circuit\|breaker\|consecutive.*fail\|trip` | 0 | **0**（唯一 `consecutive` = `skills.md:81` 连字符规则） | `repeated.{0,20}fail\|give up\|disable.{0,20}compact` → `compaction.md:437`、`rpc-commands.md:408`（人工开关）；**`compaction.md:39`「one compact-and-retry recovery attempt」= 有界单次重试** | 同 | **部分**（无「连败 N 次自动停压」；但已存在**有界恢复重试**，`GAP-CMPT-02` 的「Pi 无任何抑制」措辞应窄化为「无连败计数熔断」） | `docs/compaction.md:39,437` |
| 12 | 无按上下文增长节律催促压缩 | `docs/*.md`(40)；`nudge\|prompt.*compress\|suggest.*compaction\|remind.*context\|advisory.*compress\|ask.*model.*compress` | 0 | **0**（同语料仅 `settings.md:107` `clearOnShrink`，属终端渲染） | `remind\|system-reminder\|hint.*compact` → 0 | 同 | **成立** | `docs/compaction.md:32,41` |
| 13 | 无工具级硬保护名单 | `protected tool\|never compress\|hard.*protect\|exclude.*tool.*compact\|compactableTools\|allowlist.*compact` | 0 | **0** | `keep.{0,20}verbatim\|pinned message` → 0；**但** `session_before_compact` 返回 `{compaction:{summary, firstKeptEntryId,…}}`（`compaction.md:302-320`）= 扩展可**自选保留边界**；`compaction.md:138`「advances … only when … no unomitted context-producing entries」是保护性不变量 | 同 | **部分**（无内建名单成立；但**原语存在** → `O-5` 应改 `O-3`，`CAP-NOA-07`） | `docs/compaction.md:138,302-320` |
| 14 | 无按上下文压力改写已存工具结果的紧急截断阀 | `truncate.*context\|emergency.*truncate\|shrink.*tool result\|rewrite.*result\|compress.*tool output` | 仅建时上限 | 同（该式仍 0） | **`context_edit` → `session-format.md:143-147,235`**：append-only 编辑**已存** entry，`replacement: null` 省略、非空替换内容，**原文与元数据不被修改**；可由 `turn_end`/`agent_before_settle` handler **链式追加**（`extensions.md:118`） | 同 | **假阴性**（「改写已存工具结果、只改发出的」原语**存在**且语义逐字对应 Norma 的「只改发出的、不改存储」；缺的是**压力触发与选最大结果**判定 → `O-5` 应改 `O-3`） | `docs/session-format.md:143-147,235`、`docs/extensions.md:118` |
| 15 | 无运行期 tool pair 孤儿修复 | `orphan\|unpaired\|repair.*pair\|tool_calls must be followed\|synthetic.*result` | `compaction.md:39`（建时）+ 余 0 | 同（`orphan` → `rpc-commands.md:721`，指**会话树**断链条目；`synthetic` → `compaction.md:39`） | `tool pair\|pairing\|dangling` → 仅 `compaction.md:39`；`compaction.md:136`「Never cut at tool results」= **预防**非修复 | 同 | **成立**（并确认残余风险：`context_edit` 单侧移除 tool result 无文档化补偿） | `docs/compaction.md:39,136`、`docs/rpc-commands.md:721` |
| 16 | 无 Provider 级主动限流 | `ratelimit\|rate limit\|throttl\|token bucket\|requests per second\|per-minute\|限流` | `custom-provider.md:154`、`rpc-commands.md:423`、`llama-cpp.md:81` | 同 + `settings.md:135` | `quota\|concurrency` → `settings.md:135`（**处理** quota 错误）；`retry.*` → `settings.md:127-133`（**反应式**重试/backoff） | 同 | **成立**（无 token bucket / 主动节流；`retry.provider.maxRetries` 为被动） | `docs/settings.md:127-135` |
| 17 | 无「模型发起 tool_call 的参数校验」独立章节 | `validat\|TypeBox\|schema` | `extensions.md:135,149` | 同 | `invalid arguments` → `codemode.md:48`「A call that fails, is blocked, or **gets invalid arguments** rejects with an Error」；`TypeBox parameter schema` → `extensions.md:135` | 同 | **部分**（「无独立章节」字面成立；但**校验能力存在**且被文档正面陈述 → 该 `NEG` 措辞危险，应改写为「无独立章节，但能力存在」） | `docs/extensions.md:135,149`、`docs/codemode.md:48` |
| 18 | 无跨工具统一输出 net | `truncat\|output limit\|max.?output\|tool output (cap\|limit)\|size limit\|2000 lines\|50KB\|20 KB\|1 MiB` | `codemode.md:43`、`mcp.md:232`、`compaction.md:291`、`extensions.md:145` | 同 + `codemode.md:15,12`、`json.md:184`、`rpc-commands.md:472-487` | **`DEFAULT_MAX_LINES=2000` / `DEFAULT_MAX_BYTES` 为包公开导出**（`dist/index.js:30`、`dist/core/tools/truncate.d.ts:10`），且被 `read`/`bash`/`output-accumulator` 共享（`dist/core/tools/{read,bash,output-accumulator}.js`） | 同 | **部分**（「对第三方工具无统一 net、责任外置」成立；但「Pi 无统一截断设施」不实：有共享模块 + 全局默认值 + 公开 API。`GAP-TOOL-06` 的 `O-2` 依据 `extensions.md:145` 可保留，句子须窄化） | `dist/core/tools/truncate.d.ts:10`、`dist/index.js:30`、`dist/core/tools/bash.js:166` |
| 19 | 无 per-call 权限决策管线 | `docs/40 + 包导出`；`permission\|approve\|deny\|allow\|mode:(plan\|bypass\|acceptEdits\|dontAsk)\|deny.?priorit\|gate\|guard\|policy` | 多条命中，均「非 per-call 决策管线」 | 同 + `cli.md:237-240,290` | **`pi.on("tool_call")` → `return { block: true, reason }`**（`extensions.md:170-178`、`mcp.md:252`「Every MCP call passes through Pi's tool pipeline … including permission gates」）= **核心提供的逐调用决策点** | 同 | **部分**（无**内建求值器**成立、判 `O-2`（刻意外包，原文 `extensions.md:167`「a permission extension」）；「无 per-call 决策点」按字面读则错——决策点由 core 提供、规则由扩展给。**C2 修正**：原写「正确码是 `O-3`，与 `08-coverage.md` 的 `I-7` 一致」有误——`I-7` 记的是 `PERM-05`/`LOOP-03`/`LOOP-04`（均为 `O-3`），**不含** `PERM-04`；矩阵 `CAP-PERM-01`/`CAP-PERM-04` 一直为 `O-2`） | `docs/extensions.md:170-178`、`docs/mcp.md:252` |
| 20 | 无 permission mode 集合 | `mode\b\|bypassPermissions\|acceptEdits\|dontAsk\|plan mode` | 0 | `mode\b` 命中大量，但**全部是接口模式**：`cli.md:27,30,41,46-48,233-234`（text/json/rpc/tui-mode）、`extensions.md:241-254`（`ctx.mode === "tui"`）、`codemode.md:52`（`codemode.mode`）、`llama-cpp.md:9,119` | `bypassPermissions\|acceptEdits\|dontAsk\|permissionMode` → **0** | 同 | **成立**（`mode` 的多命中已可由语义排除，无权限 mode 概念） | `docs/cli.md:41-48`、`docs/extensions.md:241-254` |
| 21 | Pi 不区分 read-only/write 的调度器 | `parallel\|sequential\|concurren\|serial\|exclusiv\|queue\|lock\|scheduler` | `extensions.md:124,143-144`、`cli.md:155,174`、`codemode.md:3` | 同 | **`withFileMutationQueue()`**（`extensions.md:144`）、**`readOnlyHint`/`destructiveHint`** 注解（`extensions.md:167,172-174`）、`pi.getAllTools()` 暴露 annotations（`mcp.md:254`） | 同 | **部分**（「无区分读写的调度器」成立；但不止「可并行 + 作者建议」——core 提供**互斥原语**与**读/写注解**，属 `O-3` 而非纯「无」） | `docs/extensions.md:124,143-144,167-174` |
| 22 | 无 turn/时长预算 | `max.?turns\|max.?duration\|turn.?budget\|wall.?clock\|deadline` | 0（`settings.md:127-133` 仅 retry/timeout） | 同 + `codemode.md:16`（`timeout_ms`，**脚本**级硬截止）、`rpc.md:89`（客户端自身 deadline） | `maxTurns\|maxSteps\|maxIterations\|turnLimit` → **0** | 同 | **成立** | `docs/settings.md:127-133`、`docs/codemode.md:16` |
| 23 | Pi core 无内建子代理能力 | `docs/*.md`(40)+README+package.json；`(?i)sub-?agent\|spawn[^\n]{0,20}agent\|delegate[^\n]{0,20}agent\|child session\|nested agent\|worker agent` | `README.md:19`（`O-2` 正证）；余 0 | 同（`delegate` 命中 `custom-provider.md:72`、`containerization.md:16,183`、`rpc-extension-ui.md:21`，均**非**代理派生） | `child session\|sidechain\|nested agent` → **0**；`nested model call` → `extensions.md:137,215`（**能力**存在，非内建子代理） | 同 | **成立**（唯一引证修正：原 residual 指 `sdk.md:58`，实际相关行为 `sdk.md:55-60` 的 `AgentSessionRuntime.newSession/switchSession/fork`） | `README.md:19`、`docs/sdk.md:55-60`、`docs/extensions.md:137,215` |
| 24 | Pi core 无多代理编排器 | `(?i)coordinator\|orchestrat\|fan-?out\|multi-?agent\|parallel[^\n]{0,20}agent` | 0（`codemode.md:3`、`extensions.md:158` 指工具） | 同 | `swarm\|team\b\|consensus\|teammate` → `teammate` 0；`team` 仅 `extensions.md:158`「orchestrate other tools」 | 同 | **成立** | `docs/extensions.md:158,181` |
| 25 | 四个 Agent 类工具的唯一注册者是 `A-EXT` | `~/.pi/agent/npm/node_modules/**`+`~/.pi/agent/extensions/*.ts`；`name:\s*["'](Agent\|StopAgent\|MessageAgent\|AgentStatus)["']` | 仅 `pi-subagents-lite/src/registration.ts:66,121,132,143` | **同**（对 `~/.pi/agent` 全树无 glob 搜索，含 `dist/`：仍仅该 4 处） | `AgentStatus\|MessageAgent` → 同 4 处 | `~/.pi/agent/extensions/` 内 `cbmem.ts`/`rtk.ts` 0 命中 | **成立** | `~/.pi/agent/npm/node_modules/pi-subagents-lite/src/registration.ts:66,121,132,143` |
| 26 | Pi 无内容哈希身份 | `docs/*.md`(40)+dist；`内容哈希\|content hash\|sha256\|stable id\|哈希` | 0 | **非 0**：`mcp.md:77`（工具名冲突时加 **hash suffix**）、`rpc-commands.md:691`（entry 有 **stable ids**，可作 durable cursor） | `sha256\|deterministic id` → 0；`firstKeptEntryId\|parentId` → `session-format.md:54-59,131`（**写入期** id，非内容派生） | 同 | **部分**（断言成立：无内容哈希寻址；但「命中 = 0」不实，两处命中需以「非内容派生」显式排除） | `docs/mcp.md:77`、`docs/rpc-commands.md:691`、`docs/session-format.md:131` |
| 27 | Pi 无 `noa-ref` 式可寻址引用 | `noa\|noa-ref\|ref tag\|addressable reference\|message ref` | 0 | **非 0 但无关**：`packages.md:34,38,127` 的 `ref` = **git ref** | `ref tag\|addressable` → 0 | 同 | **成立**（命中经语义排除后归零） | `docs/packages.md:34-38` |
| 28 | Pi core 无子代理/sidechain | `subagent\|sub-agent\|sidechain\|nested agent\|spawn` | 0（仅 `A-EXT`） | 同（`spawn` → `spawnHook`，见 #4） | `sidechain\|child session` → 0 | 同 | **成立** | 同 #23 |
| 29 | Pi 无「从错误解析真实窗口」 | `parse.*window\|learned window\|actual limit\|真实窗口` | 0（`custom-provider.md:152` 仅识别错误） | 同 | `context.?overflow\|too long\|overflow` → `compaction.md:37,39,85,461`、`custom-provider.md:152,154,165`、`virtual-models.md:81-84`、`models.md:90`（「Pi does **not yet** rewrite or reject history based on」`inputLimits`） | 同 | **成立**（只有「识别 overflow → 压缩重试」，无学习窗口更新） | `docs/custom-provider.md:152`、`docs/models.md:90` |
| 30 | myflow 无账本/归档（压缩状态） | `.pi/`+`.myflow/`；`state.json\|archive\|CompressionState\|blocks\|token snapshot` | 0 | `archive` → `.myflow/workflow.md:12,26,56`、`task.py archive`、`tests/task-bridge.test.ts:74-141,311-318`（**任务**归档）；`blocks` → workflow-state 块（`tests/mvp.test.ts:52-97`）；`state.json`/`CompressionState`/`token snapshot` → **0** | `cache\|snapshot` → 仅 `turn-cache.ts`（回合缓存） | 同 | **成立**（命中经语义排除后无压缩账本） | `.myflow/workflow.md:12,26`、`.pi/extensions/myflow/turn-cache.ts:112` |
| 31 | Pi 无 `SubagentStart` 等价宿主钩子 | `docs/*.md`(40)、`dist/.../types.d.ts`、`README.md`；`sub-?agents?\|SubagentStart\|subagent`(i) | `README.md:19`（唯一）；`on()` 全表 **42 项** | `SubagentStart` 对**整包**（含 `dist/`、`CHANGELOG.md`）**0 命中**；`on(event:` 枚举 = **41 项** | 逐条通读 `types.d.ts:1186-1228` 的 `on()` 重载：`project_trust\|resources_discover\|session_*\|mcp_servers_change\|context\|context_with_system\|cache_warming_decision\|before_provider_*\|after_provider_response\|provider_stream_event\|before_agent_start\|agent_start\|agent_end\|agent_before_settle\|agent_settled\|ui_prompt_*\|turn_*\|message_*\|tool_execution_*\|model_select\|thinking_level_select\|tool_call\|tool_result\|user_bash\|input` | 同 | **成立**（断言成立；计数更正 **41 ≠ 42**） | `dist/core/extensions/types.d.ts:1186-1228` |
| 32 | Pi 无进程内 MCP server 原语 | `in-?process\|InProcess\|registerMcpServer.*function\|MCP server API` | 0；`registerMcpServer(name, config)` 只收配置 | 同（`in-?process` → `docs/sdk.md:5,147`、`cli-integration.md:106`、`rpc.md:5` 均指**SDK 内嵌**；`dist/utils/image-resize-core.d.ts:41` 指图片缩放） | `createServer\|McpServer\|listen` → `pi-mcp/dist/client.d.ts`（**Client** 侧）、`pi-mcp/README.md:69-76`（`OAuthCallbackServer.listen()`，**回调**服务器）；**`pi-mcp/README.md:132`「Batch JSON-RPC messages, legacy HTTP+SSE, **servers**, sampling, and tasks are outside the initial core.」= 官方明示 server 侧不在范围内** | 同 | **成立**（且找到比「命中 0」更强的正向引证） | `pi-mcp/README.md:132`、`docs/extensions.md:195-206` |
| 33 | Pi 无 skill 跨压缩保留机制 | `docs/*.md` 逐篇检索 `skill`（重点 `compaction.md`） | `skills.md`、`how-pi-works.md`、`settings.md`、`slash-commands.md`、`packages.md`、`extensions.md:181`；**`compaction.md` 命中 0** | `compaction.md` 命中仍 **0** | **机制在其他文档**：`session-format.md:84`（system message 的 `sections.skills`）、`:127-131`（`CompactionEntry.systemMessage` = 「complete system prompt/tool checkpoint」，成为压缩后上下文的**前置 system message**）、`:248`（「Pre-compaction system messages are folded into the complete checkpoint rather than replayed」）；`dist/bundle/chunks/chunk-HACVPRBJ.js:11` `collapseSystemMessages()` 同证；`skills.md:43-45` 证明 **roster（name+description+path）进 system prompt，正文由模型按需 `read`** | `compaction.md` 无 skill 字样 | **假阴性** | `docs/session-format.md:84,127-131,248`、`docs/skills.md:43-45` |
| 34 | Pi 无 skill→MCP 解锁联动 | `skills.md`+`mcp.md`+全事件表；`allowed-tools\|unlock\|reveal\|deferred.{0,40}skill\|skill.{0,40}mcp` | `skills.md:78`（`allowed-tools` 方向相反）；`mcp.md:191-217` | 同 + `cli.md:156,182`、`codemode.md:50`、`extensions.md:160`、`mcp.md:196,200,202,204,213,226,244,272`（deferred 由 `tool_search`/`codemode`/配置驱动） | `unlock\|reveal` → `session-format.md:147`（分支相对，`reveal` 指恢复原文） | 同 | **成立**（`allowed-tools` 是**预授权**，与「skill 解锁 server 工具」方向相反，原 residual 已如实记录） | `docs/skills.md:78`、`docs/mcp.md:196,204` |
| 35 | Pi core 无 plan mode | `docs/*.md`(40)+README+cli+settings+configuration；`(?i)plan[ -]?mode\|EnterPlanMode\|ExitPlanMode\|--plan\|\b/plan\b` | `README.md:19`；docs 正文 0；`plan-mode` 示例与 `CHANGELOG.md:4913-4918` 为示例/历史 | 同（`docs/` 0；`examples/extensions/plan-mode/`（README+index.ts+utils.ts）**存在**；`CHANGELOG.md:4909,4913,4918,1546,2636,4301,4337` 全为**示例扩展**变更史） | `read-?only\|approv` → `plan-mode/README.md`（内置写工具禁用 + bash 只读白名单）；`security.md` 的 `--approve` 属 project trust | 同 | **成立**（并确认 `03-gap-register.md:330` 已正确把 `examples/extensions/plan-mode/` 记为「随包示例未装载」，不构成漏判） | `README.md:19`、`examples/extensions/plan-mode/README.md`、`CHANGELOG.md:4909,4913` |
| 36 | Pi core 无长期记忆 | `docs/*.md`(40)+sdk；`(?i)long-?term memory\|RecallMemory\|RecordMemory\|remember across\|persistent memory\|memory (store\|dir\|file)` | 0（`memory` 命中均为进程内存 / in-memory session） | 同（`\bmemory\b` → `cli.md:99`、`codemode.md:226`、`custom-provider.md:108`、`llama-cpp.md:28,118`、`sdk.md:38,42,103,104`；无一条是跨会话记忆存储） | `AGENTS.md` → `quickstart.md:108`「persistent instructions」、`configuration.md:18,45`、`how-pi-works.md:19`、`security.md:57`（**静态上下文文件**，非动态记忆） | 同 | **成立**（并确认 `quickstart.md:108` 的 "persistent instructions" 与 `skills.md:45` 的按需加载都不是记忆机制） | `docs/quickstart.md:108`、`docs/sdk.md:38-48` |
| 37 | myflow 无只读代码守卫；`cbmem.ts` 非长期记忆；`A-EXT` 无 plan/memory | `.pi/extensions/myflow/*.ts`、`.pi/{agents,prompts,skills}/**`、`.myflow/scripts/*.py`、`~/.pi/agent/extensions/cbmem.ts`、`pi-subagents-lite/**(.md)`；`(?i)read-?only\|readonly\|readOnly\|plan mode\|memory\|remember` | 仅 `…/references/spec-task-planning.md:69`（描述性）；`cbmem` 仅 `codebase-memory-*` 工具；`pi-subagents-lite` 0 | 同 + `readonly` = TS 修饰符（`turn-cache.ts:112`、`subagent.ts:209`、`context-injection.ts:126`）；`memory` = `myflow-update-spec/SKILL.md:3`、`myflow-before-dev/SKILL.md:61`、`myflow-spec-bootstrap` 的 codebase-memory 引用 | `readOnly` → 0（myflow 无该标识） | 同 | **成立**（myflow 无代码级只读守卫；`myflow-research` 持 `write`+`writesUnder`，是**范围**限制而非只读） | `.pi/agents/myflow-research.md:1-6`、`.pi/skills/myflow-spec-bootstrap/references/spec-task-planning.md:69` |

### 1.1 域级零假阴性声明

- `LLM`（`#16,#17,#18`）：**3 条成立/部分，无假阴性** —— 但 `#17`/`#18` 的**措辞**须窄化（能力存在，缺的是「独立章节 / 统一 net」）。
- `TOOL`：**无独立 `NEG`**（`#18` 归 `LLM` 分片）。
- `PERM`（`#1,#6,#19,#20`）：`#19` 部分，余成立；**该域无假阴性**（Pi 确实无内建权限求值器）。
- `LOOP`（`#21,#22`）：`#21` 部分，`#22` 成立；**无假阴性**。
- `SUB`/`COORD`（`#4,#23,#24,#28`）：`#4` 部分（命中列不实），余成立；**无假阴性**。
- `CMPT`（`#7,#9,#10,#11,#13,#14`）：**`#14` 假阴性**，`#11`/`#13` 部分；该域是本片最弱的一域。
- `NOA`（`#8,#12,#13,#14,#15`）：**`#14` 假阴性**，`#13` 部分。
- `NOAA`/`TRANS`（`#26,#27,#29,#30`）：`#26` 部分（命中列不实），余成立；**无假阴性**。
- `CORE`（`#23,#24,#25,#28,#31,#32`）：全部成立（`#31` 计数更正）。
- `HOOK`（`#31`）：成立。
- `MCP`（`#2,#32,#34`）：成立（`#2` 命中列不实）。
- `SKILL`（`#33,#34`）：**`#33` 假阴性**（本片最严重）。
- `PLAN`（`#35,#37`）：成立。
- `MEM`（`#36,#37`）：成立。
- `CTX`/`OBS`/`TEST`：无 `NEG`（跨切面域未立负向断言）。

---

## 2. 假阴性 / 部分专章（11 条，本片最重要产出）

### 2.1 `#33` — Pi **有** skill 跨压缩保留机制（**假阴性**）

**原检索式漏掉了什么**：检索式只有 `skill` 这一个词，语料重心压在 `compaction.md`。
但 Pi 的保留机制**不叫 skill 保留**，而叫 **system prompt checkpoint**：
「谁保留」由 `sections` 机制承担，「skill」只是其中一个 section 的**内容**。

**正确原文**：

- `docs/skills.md:43`： 「At startup, Pi scans configured skill locations and adds each skill's name, description, and
  path **to the system prompt**. It does not add the full instructions.」
- `docs/session-format.md:84`：system message 形如
  `{"role":"system","content":"","sections":{"skills":"<skills>...</skills>"},...}`
- `docs/session-format.md:127-131`：`CompactionEntry.systemMessage` = 「The replayed prompt sections and tool
  declarations at the compaction boundary; it becomes the leading system message of the compacted context,
  and **system messages among the kept entries are dropped in its favor**.」
- `docs/session-format.md:248`： 「**Pre-compaction system messages are folded into the complete checkpoint**
  rather than replayed from the retained range.」
- 代码级旁证（`E2`，非权威面但同源）：`dist/bundle/chunks/chunk-HACVPRBJ.js:11`
  `collapseSystemMessages(context)` 保留单个 head system message 并过滤其余。

**会改变哪些判定**：

| 位置 | 现状 | 应改为 |
| --- | --- | --- |
| `02-matrix.md:101`（`CAP-SKILL-03` Pi 侧） | `A-NONE` / `O-5`；「**无**（`compaction.md` 命中 0；skill 正文在 tool_result，摘要时截 2000 字符）」 | `A-PI(部分)` / **`O-3`**：「**roster（name+description+path）经 system section 存活于压缩**；**正文**（`/skill:name` 展开为 user 消息，`dist/core/agent-session.js:1709` `<skill name="…" location="…">`；或 `read SKILL.md` 的 tool result）被摘要，无 re-inject」 |
| `03-gap-register.md:497`（`GAP-SKILL-03`「Pi 现状（为什么宿主不给）」） | `O-5`；理由 = compaction.md 命中 0 | `O-3`；理由 = 「**原语在 Pi**（system checkpoint 保留 roster / `session_before_compact` 可自定义），**语义由 myflow 补齐**（正文逐字 re-inject）」 |
| `GAP-SKILL-03` 的能力描述与补足标准 | 「skill 正文存活于压缩」 | **须拆分**：(a) roster 存活 → `V-PI`/`O-1`（非缺口，已由宿主覆盖）；(b) 正文逐字 re-inject → 保留 `V-GAP` |
| `02-matrix.md:197` / `GAP-SKILL-03` 优先级 | `V-GAP`/`P2`，理由含「Pi 无」 | `V-GAP` 仍成立（Pi 无**正文** re-inject ∧ myflow 无 ∧ Norma 有），但「缺口判定」一行的论证必须改写；`P2` 可保留 |
| `08-coverage.md` §6 薄弱点 3 | 把 `#33` 列为「仅文档面推断」 | 删除该归类：`#33` 不是「文档未命中」，而是**检索词汇错位** |

**内部自相矛盾证据**：`02-matrix.md:76`（`CAP-NOA-11` 常驻提示词）已判 `A-PI`/`O-1`，并写明
「压缩写 system checkpoint，system 段存活于压缩」。同一份矩阵对**同一机制**在 `CAP-SKILL-03` 上判 `A-NONE`。
这是本轮最有力的「假阴性已被同一交付物内部证据推翻」的证据。

### 2.2 `#14` — Pi **有**「改写已存工具结果、只改发出的」原语（**假阴性**）

**原检索式漏掉了什么**：`rewrite.*result` / `shrink.*tool result` / `truncate.*context` 全部落空，
因为 Pi 的术语是 **`context_edit`**（entry 类型）与 **`replacement`**（字段）。

**正确原文**：

- `docs/session-format.md:143`： 「`ContextEditEntry` — **Append-only edit of one earlier context-producing
  entry. It changes only future model context; the target entry and its metadata remain unchanged** in raw
  history, UI, exports, and session accounting.」
- `docs/session-format.md:145`： 「**Targets may be user, assistant, tool-result, or custom-message entries.**
  `replacement: null` omits the target from model context. A non-null `replacement` replaces only the target
  message content.」
- `docs/session-format.md:235`： 「`buildSessionProjection()` then applies the latest `context_edit` for each
  selected target … **The raw selected entries are not modified.**」
- `docs/extensions.md:118`： 「`turn_end` and `agent_before_settle` … handlers can **chain proposed `custom`,
  `custom_message`, `context_edit`, or `compaction` entries** and return `continue: true` for one next model request.」

**与 Norma 的语义对照**：`CAP-NOA-08` 的判据是「对最大的未截断工具结果做保头保尾改写，
**只改发出的、不改存储**」。Pi 的 `context_edit` **逐字满足**「只改发出的、不改存储」，
且可作用于 **tool-result** 条目、可在运行期（`turn_end`/`agent_before_settle`）追加。

**会改变哪些判定**：

| 位置 | 现状 | 应改为 |
| --- | --- | --- |
| `02-matrix.md:73`（`CAP-NOA-08` Pi 侧） | `A-NONE` / `O-5` | `A-PI(原语)` / **`O-3`**；「原语充足（`context_edit` 非破坏性改写 + `turn_end`/`agent_before_settle` 链式追加）；缺**压力触发判定**与**选最大未截断结果**的语义」 |
| `03-gap-register.md:211-214`（`GAP-NOA-08` 的「为什么宿主不给」） | `O-5`；「**无按上下文压力改写已存结果**的紧急阀」 | `O-3`；「宿主不决定**何时**改写；`context_edit` 已提供**如何**改写」 |
| `GAP-NOA-08` 依赖与代价 | 未提 `context_edit` | 补「复用 Pi `context_edit` 或 `context` 钩子两选一 —— 两者均落在 Pi 契约上（`O-3`），须登记为宿主契约」 |
| `02-matrix.md:169` | myflow 侧 `R-T cit` | 与 `03-gap-register.md:214` 的 `R-∅` **矛盾**，须统一（`C4` 完整性检查项） |

**同类但程度较轻的 `#13`**（`CAP-NOA-07` 硬保护）：`session_before_compact` 可返回
`{compaction:{summary, firstKeptEntryId, tokensBefore, details}}`（`docs/compaction.md:302-320`），
即扩展可**自选保留边界**；`compaction.md:138` 的「advances the kept boundary … only when …」
是一条保护性不变量。故 `CAP-NOA-07` 的 `O-5` 同应改 `O-3`。**但**：Pi 无**命名工具硬保护名单**，
`V-GAP` 本身不翻转。

### 2.3 `#2` — 命中列不实

原声明「`命中` = 仅 `subagent.ts:69` 进程清理注释」。实测 `.pi/**` 内 `mcp` 命中 **≥14 处**，
集中在 `.pi/skills/myflow-spec-bootstrap/references/mcp-setup.md`（整篇讲 MCP 配置）与
`repository-analysis.md`、`myflow-meta/references/harness-conventions.md:74`。
**断言本身成立**（myflow 只**文档化** Pi 的 MCP，不实现、不消费），
但「命中 = 1 处」会让复核者以为 `.pi/` 没有 MCP 语料——这是**检索执行不完整**，
不是结论错误。**改动**：`08-coverage.md` `NEG#2` 行须补全命中清单，并在
「残余风险」中保留「MCP 由 `A-EXT` 提供」的域码提示。

### 2.4 `#4` — 命中列不实（`spawn` 被漏记）

原声明「命中 = 0（`orchestrat` 仅 `extensions.md:158,181`）」，但检索式含 `spawn`，
而 `docs/environment-variables.md:53,57,64,69` 有 4 处 `spawnHook`（进程 spawn 钩子）。
**断言成立**（无内建子代理），但 0 声明不实。**这是本次唯一一处「原检索式自身在声明语料上应当命中却记为 0」的实例**，
说明 `NEG` 的「命中」列存在**未执行就填写**的可能，复核时不能只信该列。

### 2.5 `#26` — 命中列不实（2 处）

`mcp.md:77`（工具名冲突加 hash 后缀）与 `rpc-commands.md:691`（entry **stable ids** 可作 durable cursor）
在原检索式下应命中却被记为 0。断言成立（无**内容哈希**寻址），但残余风险里应显式写
「已排除：`mcp.md:77` 的名称冲突 hash、`rpc-commands.md:691` 的 stable entry id（写入期派生，非内容派生）」。

### 2.6 `#11` — 结论成立但**推得过强**（`GAP-CMPT-02` 受影响）

`compaction.md:39`： 「A provider context-overflow error or an early final `stopReason: "length"` can select
**one compact-and-retry recovery attempt**.」→ Pi 已有**有界单次重试**。
Norma 的是「`maxAutoCompactFails=3` + `tripped` 连败停压」（`Norma/compaction/compaction.go:71,296,310-311`、
`Norma/compaction/autocompact_test.go:53,246`）。
**改动**：`GAP-CMPT-02` 的 Pi 现状从「仅有 `session_compact_failed` 遥测，**无熔断**」
窄化为「无**连败计数**熔断；已有有界单次恢复重试」。`O-5`→`O-3`（原语存在）。

### 2.7 `#17` / `#18` — 措辞须窄化（不影响 `GAP-*` 的成立与否）

- `#17`：字面断言是「无**独立章节**」，成立；但**参数校验能力存在且被正面文档化**
  （`extensions.md:135`「TypeBox parameter schema」、`:149`「Nested calls go through argument validation」、
  `codemode.md:48`「gets invalid arguments rejects with an Error」）。**不该作为「Pi 缺校验」的依据**。
- `#18`：`CAP-TOOL-06` 的 `O-2`（刻意外包）依据 `extensions.md:145` 可保留；但
  「Pi **不设统一 net**」需窄化为「Pi **只对其内建工具**套用共享 `truncate` 模块
  （`DEFAULT_MAX_LINES=2000` / `DEFAULT_MAX_BYTES`，`dist/core/tools/truncate.d.ts:10`，
  公开导出见 `dist/index.js:30`），**对第三方/扩展工具**无统一 net，责任外置」。
  `GAP-TOOL-06` 的 `V-GAP` 与 `P0` 不受影响（myflow 的 `myflow_subagent` 结果确实不截断）。

### 2.8 `#19` / `#21` — 原语存在，`O-*` 码应上调

- `#19`：`pi.on("tool_call")` + `{block:true, reason}`（`extensions.md:170-178`）与
  `mcp.md:252`「including permission gates」= **core 提供的逐调用决策点**。
  「无 per-call 权限决策管线」按字面读为假 → 措辞改为「无内建求值器；决策点由 core 提供」，**判定维持 `O-2`**
  （`extensions.md:167`「a permission extension」明示外包；`O-3` 会低估「求值语义整体交给扩展」）。
  **C2 修正**：原文「`08-coverage.md` 的 `I-7` 已把 PERM-04 记为 `O-3`，与 `NEG#19` 的措辞冲突」不实——
  `I-7` 记的是 `PERM-05`/`LOOP-03`/`LOOP-04`（均为 `O-3`），**不含** `PERM-04`；矩阵 `CAP-PERM-04` 为 `O-2`，
  二者本来自洽。本片原措辞把「决策点存在」误推为「归属码应上调」，与 `research/norma-perm-loop.md` 的 NEG1 结论
  （「PERM-01/04 的『求值器外包』判 `O-2` 不翻转」）亦不一致，故以分片与矩阵为准统一为 `O-2`。
- `#21`：core 提供 `withFileMutationQueue()`（`extensions.md:144`）与 `readOnlyHint`/`destructiveHint`
  注解（`extensions.md:167,172-174`、`mcp.md:254`）。「无区分读写的**调度器**」成立，
  但「仅作者自律」低估了 Pi —— 应记 `O-3`。

### 2.9 `#2`/`#4`/`#13`/`#26` 的共同教训

四条的固有模式是：**断言字面成立，但「命中」列与「残余风险」列不完整**，
从而把 `O-5`（双方皆无）误填成 `O-3`（宿主部分提供）应填的位置。
**规律**：凡 `NEG` 的结论是 `O-5` 或「明确无」的条目，都必须额外做一次
「该概念的正面枚举词 + 相邻文档标题」扫描（本片即为该扫描）。

---

## 3. 无法复核清单

**无。** 37 条全部在可读语料内完成重跑。

但须诚实声明本片**未能执行**的取证方式（能力边界，非条目失败）：

| 未做 | 原因 |
| --- | --- |
| 运行 `pi --version` / 读环境变量 / `ls` 命令级验证 | 本分片工具白名单无 `bash`（`.pi/agents/myflow-research.md:1-6`） |
| 对 `dist/bundle/**` 压缩产物做**逐行**审计 | 只能做关键词检索；压缩产物的**变量名被 minify**，会漏检（例如内部函数据 `noa` 谐音或缩写命名时无法命中）。本片仅在 `#33`/`#31` 上把 `dist/` 当**旁证**，未作判定依据 |
| `pi-agent-core`/`pi-ai`/`pi-codemode`/`pi-telemetry`/`pi-tui` 的完整文档面 | 原 `NEG` 语料未声明这些包；为保持可比性，本片只对 `pi-mcp`（`#32`）做了越界补检并明确标注 |
| Norma 侧源码逐行 | 仅在 `NEG` 涉及 Norma 时检索（`#3`），并遵守原分片的「抽样」声明 |

---

## 4. 自我声明：本片实际执行的检索（完整字符串）

工具为 Pi 内置 `grep`（ripgrep 语义；`glob` 过滤；`limit` 截断）与 `read`/`find`/`ls`。
以下为**按 `NEG` 编号**列出的实际检索式（`(?i)` 表示忽略大小写；`|` 为交替）。
未列出的相邻编号共用同一式（已在表中注明「同重跑」）。

| NEG# | 类型 | 实际检索式 / 命令级参数 |
| --- | --- | --- |
| 1 | 重跑+正面 | `path=.pi` `pattern=(?i)permission\|\\bdeny\\b\|\\ballow\\b\|\\bapprove\|confirm\|gate\\b\|guard\\b\|policy` |
| 1 | 语料 | `path=.myflow` `pattern=(?i)permission\|\\ballow\\b\|\\bdeny\\b\|approve` |
| 2 | 重跑 | `path=.pi` `pattern=(?i)\\bmcp\\b\|mcp__\|mcpServers` |
| 3 | 重跑+正面 | `path=../Norma` `pattern=(?i)writesUnder\|WriteScope\|allowedPath\|AllowedPath\|writeScope\|scope.{0,10}sandbox`；`pattern=(?i)sandbox\|read-?only\|readOnly\|writable\|mutating` |
| 4/5/6/7 | 重跑+正面 | `path=<pi-coding-agent>/docs` `glob=*.md` 依次：`(?i)sub-?agent\|spawn\|parallel agent\|teammate\|orchestrat\|swarm\|multi-agent`；`(?i)plan[ -]?mode\|planner\|EnterPlanMode\|ExitPlanMode`；`(?i)permission\|allow/deny\|permissionMode\|approve\|confirm before`；`m00001\|ref tag\|content hash\|\\btier\\b\|nudge` |
| 5 | 重跑原式 | `pattern=\\bplan\\b\|\\bplans\\b` |
| 7/8/10 | 重跑+正面 | `pattern=(?i)tier\|layer\|level\|budget\|threshold\|token limit`；`pattern=(?i)previousSummary\|previous summary\|nested summary\|second.{0,10}compaction\|re-?compact` |
| 9 | 重跑+正面 | `pattern=(?i)\\bcompress\|compression`；`pattern=context_edit` |
| 11 | 重跑+正面 | `pattern=(?i)circuit\|breaker\|consecutive\|repeated.{0,20}fail\|give up\|disable.{0,20}compact` |
| 12/13/14/15 | 重跑+正面 | `pattern=(?i)nudge\|remind\|system-reminder\|suggest.{0,20}(compact\|compress)\|advisory\|protected tool\|never compress\|hard.{0,6}protect\|compactable\|orphan\|unpaired\|synthetic.{0,20}result\|emergency\|shrink`；`pattern=(?i)protected tool\|never compress\|hard.{0,8}protect\|exclude.{0,20}compact\|compactable\|keep.{0,20}verbatim\|pinned message`；`pattern=(?i)tool pair\|pairing\|tool_calls must\|must be followed\|unpaired\|dangling\|synthetic.{0,20}(tool\|result)` |
| 14 | 正面（决定性） | `pattern=context_edit`（→`compaction.md:93,138`、`extensions.md:118`、`session-format.md:144,235,245`）+ `read docs/session-format.md:60-240` |
| 16/17/18 | 重跑+正面 | `(?i)ratelimit\|rate limit\|throttl\|token bucket\|requests per second\|per-minute\|quota`；`(?i)TypeBox\|validat\|invalid arguments\|parameter\|schema`；`(?i)truncat\|max.?output\|output limit\|size limit\|character limit\|too large`；`pattern=50KB\|50 KB\|2000 lines\|2,000 lines\|1 MiB\|2000 characters` |
| 18 | 正面（决定性） | `path=<pkg>/dist` `pattern=DEFAULT_MAX_LINES\|MAX_TOOL_RESULT\|truncateToolResult\|TOOL_RESULT_MAX` |
| 19/20/21/22 | 重跑+正面 | `(?i)bypassPermissions\|acceptEdits\|dontAsk\|permissionMode\|permission mode\|--mode`；`(?i)\\bmode\\b`；`(?i)parallel\|sequential\|concurren\|exclusiv\|serial`；`(?i)max.?turns\|max.?duration\|turn.?budget\|wall.?clock\|deadline\|maxTurns\|maxDuration` |
| 23/24/28 | 重跑+正面 | `(?i)sidechain\|child session\|nested agent\|worker agent\|delegate\|swarm\|teammate\|consensus\|multi-?agent`；`(?i)nested model call\|streamSimple\|model call` |
| 25 | 重跑 | `path=~/.pi/agent` `pattern=name:\s*["'](Agent\|StopAgent\|MessageAgent\|AgentStatus)["']`（无 glob，覆盖 `src/`+`dist/`+`extensions/`） |
| 26/27/29 | 重跑+正面 | `(?i)sha256\|content hash\|\\bhash\\b\|stable id\|deterministic id`；`(?i)ref tag\|addressable\|message ref\|\\bref\\b\|reference id`；`(?i)context.?overflow\|overflow\|too long\|learn.*(window\|limit)\|actual limit\|real limit`；`(?i)inputLimits\|contextWindow\|context window\|update.{0,20}(limit\|window)` |
| 30/37 | 重跑 | `path=.pi` `pattern=(?i)read-?only\|readonly\|\\bmemory\\b\|remember\|plan mode\|planMode`；`path=<repo>` `glob=*.{ts,md,py}` `pattern=(?i)state\.json\|archive\|CompressionState\|\\bblocks\\b\|token snapshot` |
| 31 | 重跑 | `path=<pkg>`（全包）`pattern=SubagentStart\|SubagentStop\|subagent_start`（`dist/`+`CHANGELOG.md` 皆含） |
| 31 | 枚举 | `read dist/core/extensions/types.d.ts:1170-1240`（逐条 `on(event: ...)` 计数 = **41**） |
| 32 | 重跑+正面 | `path=<pkg>` `pattern=(?i)in-?process\|InProcess`；`path=<pkg>/dist` `pattern=(?i)noa\|reinjectSkill\|nudge`；`path=~/.bun/.../pi-mcp` `pattern=(?i)createServer\|Server(\|McpServer\|serve\|listen\|in-?process server` |
| 33 | 重跑 | `path=<pkg>/docs` `glob=compaction.md` `pattern=(?i)skill` → **No matches** |
| 33 | 正面（决定性） | `path=<pkg>/docs` `pattern=(?i)skills?/.|/skill|SKILL\\.md|skill name|activeSkill`；`pattern=(?i)\\bskill\\b.{0,40}(compact\|survive\|retain)\|compact.{0,40}\\bskill\\b`；`pattern=(?i)mcp_servers\|sections\\.\|"skills"\|registerTool.*namespace\|namespace.*MCP`；`pattern=<skill\|location=\|skills hint`；`read docs/session-format.md:60-240`；`path=<pkg>` `pattern=parseSkillBlock\|skillBlock\|SKILL_BLOCK` |
| 34 | 重跑+正面 | `(?i)unlock\|reveal\|deferred` |
| 35 | 重跑+正面 | `(?i)plan[ -]?mode\|EnterPlanMode\|ExitPlanMode\|--plan\|\\b/plan\\b`；`path=<pkg>/CHANGELOG.md` `pattern=(?i)plan[ -]?mode`；`find <pkg>/examples` `**/*plan*` |
| 36 | 重跑+正面 | `(?i)long-?term memory\|persistent memory\|recall\|remember(ing)? across\|MEMORY\\.md\|memory (store\|dir\|file\|tool)`；`(?i)\\bmemory\\b\|remember`；`pattern=AGENTS\\.md\|persistent instructions\|context files` |
| 37 | 重跑 | `path=~/.pi/agent/extensions`、`pi-subagents-lite/**`、`cbmem.ts` 复用 #37 原式（覆盖于 #25/#37 两次检索） |
| 通用 | 相邻标题 | 对 `docs/compaction.md`（唯一带标题体系的关键语料）执行 `glob=compaction.md` `pattern=^#` → 得到 24 个标题，用于判定 `#11/#13/#14/#15/#33` 是否有「标题级」机制未被检索式覆盖 |
| Norma 侧确认 | 重跑 | `path=../Norma` `pattern=(?i)reinjectSkills\|tripped\|maxAutoCompactFails\|ViableRange` → `compaction/compaction.go:71,296,310-311,321,365-370`、`compaction/autocompact_test.go:53,90,246-252`、`compaction/skills_reinject_test.go:13,57` |

**未做**：任何需要 `bash` 的操作；`pi --help` 级接口验证；`schemas/*.json` 的**全字段**通读
（仅在 `#6`/`#19`/`#20` 上检索 `permission|approve|allow|deny|sandbox` → 仅 `models.schema.json:682-724`
的数据路由 `allow`/`deny`，与工具权限无关）。

---

## 5. 本片附带发现（不属于 37 条，但同属负向断言的方法性风险）

| # | 发现 | 影响 |
| --- | --- | --- |
| F-1 | `on()` 事件表实为 **41** 项（`dist/core/extensions/types.d.ts:1186-1228` 逐条枚举），分片与 `08-coverage.md` 记 **42** 项 | `NEG#31` 的「全表 42 项」应改 41；不影响结论 |
| F-2 | `NEG` 语料从未覆盖 Pi 随包 `examples/extensions/**`（`plan-mode/`、`subagent/`、`permission-gate.ts`、`protected-paths.ts`、`confirm-destructive.ts`、`custom-compaction.ts`、`trigger-compact.ts`、`sandbox/`、`truncated-tool.ts`、`tools.ts` 等官方参考实现）；`08-coverage.md` §2「未读清单」未列出该子树 | `O-2`（刻意外包）的**证据强度**被低估：Pi 不只「说 skip」，还**随包给出可直接装载的参考实现**。`03-gap-register.md:330` 已正确引用 `examples/extensions/plan-mode/`，但 `08-coverage.md` §1/§2 的全量/未读清单应补该子树 |
| F-3 | `02-matrix.md:169` 记 `CAP-NOA-08` myflow `R-T cit`，`03-gap-register.md:214` 记 `R-∅` | 矛盾，属 `C4` 完整性检查项；因 `R-T cit` 指的是**注入文件**截断而非工具输出截断，建议统一为 `R-∅`（并保留 `cit` 作为邻近测试说明） |
| F-4 | `02-matrix.md:101`（`CAP-SKILL-03`）与 `02-matrix.md:76`（`CAP-NOA-11`）对同一机制（system checkpoint）给出互斥判定 | 见 §2.1；`C3` 归属复核时须同时核对这两行 |
| F-5 | `pi-mcp/README.md:132` 明示「servers … outside the initial core」 | 这是 `NEG#32` 的**正向引证**（比「命中 0」强），建议补入 `02-matrix.md` MCP 域与 `GAP-SKILL-04` 的依赖说明 |
| F-6 | `docs/compaction.md:130-138` 与 `docs/session-format.md:127-131` 对 `CompactionEntry` 的字段描述**不一致**（前者未列 `systemMessage`，后者列出） | 权威面内部不一致 → 建议进「可沉淀清单」（`08-coverage.md` §5 的 `D-8` 宿主契约快照，须以 `session-format.md` 为准） |

---

## 6. 对 `08-coverage.md` §3 的修改建议（供 `myflow-check` 的 `C1` 落笔）

1. `NEG#14` 与 `NEG#33` 的**裁决列**改「假阴性」；`NEG#2/#4/#11/#13/#17/#18/#19/#21/#26` 改「部分」。
2. `NEG#2/#4/#26` 的「命中」列必须补全（本片 §1 表可直接摘录）。
3. 「`NEG` 复核提示」段中，把 `#33` 与 `#14` 从「仅文档面推断」移出（它们是检索词汇/语料错位，不是「文档未命中」）。
4. 增补一句方法约束：**`O-5`/「明确无」类负向断言必须再做一次「正面枚举词 + 相邻文档标题」扫描**，
   并在 `NEG` 块内显式列出「已排除的同义命中」（本片 `#14`/`#18`/`#21`/`#26` 的写法可作模板）。
5. §2「未读清单」补 Pi 随包 `examples/**` 与 `CHANGELOG.md`（后者已零星使用但未列入语料声明）。
