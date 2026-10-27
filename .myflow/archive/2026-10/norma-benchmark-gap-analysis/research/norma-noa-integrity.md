# S6 — NOA 行为完整性（nudge / turn / tool pair / 保护 / 截断 / 常驻提示词）

> 基线 `00-baseline.md`：Pi **1.2.0**；myflow@`0a702fa`；Norma@`52f17dd`。证据码 design.md §3.1。
> 覆盖 `CAP-NOA-04..08`、`CAP-NOA-11`；NOA-01..03/09 见 `norma-cmpt-noa-core.md`（不重复）。
> 简写：无前缀 = `Norma/noa/`；`ci` = `.pi/extensions/myflow/context-injection.ts`；`ix` = `.pi/extensions/myflow/index.ts`。

## 1. 表 A 片段 + myflow 列

| CAP | Norma 机制 + 证据:行 | Pi 1.2.0 现状 + 证据:行 | 域 | O | myflow 现状 + 证据:行 | V |
|---|---|---|---|---|---|---|
| NOA-04 nudge 节律 | 双波段：`.75` 使用率以上无成长门，以下按**成长节律**（自适应成长 `.05`/50k/50k 钳制，门 20k×.45）才响；首见绕过 `nudge.go:11,20,56,114`；压缩后重锚 `nudge.go:300`；tier 独立节律 `:206`；默认值 `config.go:99-116`；回归 `nudge_test.go:48,61,80,89,100,111,124` `pacing_test.go:13,34,55` | **无**压缩 nudge，只有阈值自动压缩与 `/compact` `compaction.md:32,37,41` | A-NONE | O-5 | 无压缩 nudge；每回合注入 workflow-state（`ix:319-337`，`context` 兜底 `ix:384-417`）与压缩无关 | **V-GAP** |
| NOA-05 turn 完整性 | `TurnGroup`=reasoning+acts+results `turnintegrity.go:12`；`ComputeTurnGroups` `:33`；`WithdrawSplitTurns` 撤整轮而非拆半 `:75`；prune 期对账 `prune.go:78,269`；孤儿 reasoning 剥离 `:225`；compress 期 step(6) `compress.go:405`；回归 `toolpairs_test.go:120,144,160,177,191` | **消息粒度**天然保护：thinking 是 assistant message 内 content block `message-types.md:42-50`，切点只落整条 user/assistant 消息 `compaction.md:130-136`；**无** `context_edit` 拆半轮的孤儿修复（`context_edit` 可整条移除/替换 `session-format.md:147`） | A-PI | O-3 | 无自身机制，全靠 Pi 切割规则 | V-PI |
| NOA-06 tool pair 完整性 | `AdjustBoundariesForToolPairs` 双向扩张（`ToolPairMaxScan=20` `const.go:40`）`toolpairs.go:12`；reasoning+act 配对 `:56`；定點两轮 `:91`；prune 双侧孤儿剥离 `prune.go:154-210`；硬保护配对 `protected.go:61-77`；回归 `toolpairs_test.go:18-105` `processturn_test.go:141` | 切割规则原文：Valid cut points=user/assistant/BashExecution/custom；**"Never cut at tool results (they must stay with their tool call)."** `compaction.md:130-136`；length 截断的 tool call 保留合成失败 result `:39` | A-PI | O-1 | 无自身机制，靠 Pi 切割规则（myflow 不用 `context_edit`，未触发孤儿场景） | V-PI |
| NOA-07 硬保护 vs 软保护 | **硬**：`AlwaysProtectedTools=[Compress]` `const.go:54` + `cfg.ProtectedTools` 通配 `protected.go:13,33`，另一侧 tool_call 一并排除 `:74`；compress 期删 direct/effective `compress.go:371-377`。**软**：`PreserveRecentMessages=5`/`Tokens=5000` `config.go:115-116`，尾部区命中即剔除、整段在其中则拒 `compress.go:381-400`；回归 `config_test.go:118,138,160` `recommend_test.go:17,34,52` | **无命名工具硬保护名单**；只有软尾部 `keepRecentTokens` 默认 20000 `compaction.md:82,443`（隐式保最近消息，非工具名单）。**但有原语**：`session_before_compact` 可返回 `{compaction:{summary, firstKeptEntryId,…}}`（`compaction.md:302-320`）= 扩展可**自选保留边界**；`compaction.md:138` 是保护性不变量（C1 修正） | **A-PI(原语)** | **O-3** | 无工具级硬保护或尾部保护 | **V-GAP** |
| NOA-08 紧急截断标记 | 使用率 ≥ `.95`（`config.go:109`）时对**最大**未截断 tool result 保头尾各 2000 字符并插 `TruncationMarker`，只改发出的、不改存储，用量回落自解 `truncate.go:12-15,35,108`；管线在 nudge 前 `processturn.go:87-88`；nudge 附「勿重跑」通知 `nudgetext.go:132`；回归 `truncate_test.go:15-138` `fuzz_test.go:120` | **建时**每工具上限：`bash` 模型只见 2000 行/50KB `codemode.md:43`；MCP 文本 >20KB 掐中段 `mcp.md:232`；codemode `max_output_tokens` `codemode.md:12`。**运行期原语**：`context_edit` 可 append-only 改写**已存** entry（`replacement:null` 省略、非空替换；**原文与元数据不变**），targets 可为 **tool-result**（`session-format.md:143-147,235`），并可由 `turn_end`/`agent_before_settle` 链式追加（`extensions.md:118`）。**缺**「按上下文压力触发 + 选最大未截断结果」的**判定**（C1 修正） | **A-PI(原语)** | **O-3** | 无上下文级紧急阀；`ci` 截断只作用于**注入的 task 文件**（`ci:250-256`，预算 64K/128K `ci:22-26`），与模型工具输出无关 | **V-GAP** |
| NOA-11 常驻提示词 | 常驻 system 段只收「永久存在」三条：NOA TAGS / SUMMARIES IN CONTEXT / ARCHIVE，一次性指令随 nudge 走 `prompts_system.go:10-35,104`；可三段式覆盖 `:10-14` `nudgetext.go:20,30` | system prompt section 机制在转录中记录/补丁 `session-format.md:80` `message-types.md:107`；扩展经可重复的 `--append-system-prompt` 追加 `cli.md:231`；压缩写完整 system checkpoint，system 段**存活于压缩** `session-format.md:134` `compaction.md:125` | A-PI | O-1 | 子代理 system prompt 经 `--append-system-prompt` 落地 `subagent.ts:427-431`；**主会话无常驻 myflow 提示词**——workflow 规则走每回合 `custom_message`（`ix:319-337`），不享 system checkpoint 存活性 | V-PI（机制）/ 用法偏弱 |

**判词**：「配对类」（NOA-05/06）Pi 以「消息粒度 + 禁切 tool result」等价覆盖；**硬保护** Pi 仅有原语（`session_before_compact` 自选 `firstKeptEntryId`，无命名名单）→ 缺口=「命名名单 + 强制跳过」，**紧急截断** Pi 仅有运行期原语（`context_edit`，无压力触发）→ 缺口=「触发判定」（二者均 `V-GAP`/`O-3`，C1 修正）；**nudge 节律 Pi 无对应物**（`V-GAP`/`O-5`）；常驻提示词机制 Pi 已给。

## 2. 负向断言（design.md §3.3）

```
(NEG) 语料=pi-coding-agent/docs/*.md 全 40 篇 (v1.2.0)
 A 能力=按上下文增长节律主动催促模型压缩（nudge）
   检索式=nudge|prompt.*compress|suggest.*compaction|remind.*context|advisory.*compress|ask.*model.*compress
   命中=0
   残余=仅阈压缩(compaction.md:32,37)与人工 /compact(:41)；未文档化的内部 steady-state 文案可能漏检。
 B 能力=工具级硬保护名单（某些工具结果永不进压缩）——【C1 裁决：部分】
   检索式=protected tool|never compress|hard.*protect|exclude.*tool.*compact|compactableTools|allowlist.*compact
   命中=原式 0（仅有软尾部 keepRecentTokens，compaction.md:82,443）；**正面枚举命中**：session_before_compact 可返回
     {compaction:{summary, firstKeptEntryId, tokensBefore, details}}（compaction.md:302-320）= 扩展可**自选保留边界**；
     compaction.md:138「advances … only when … no unomitted context-producing entries」= 保护性不变量
   已排除的同义命中=keep.{0,20}verbatim|pinned message → 0
   修正后的结论=「无命名工具硬保护名单」成立；「Pi 无原语」不成立 → O-5 改 O-3（V-GAP 不翻转）
 C 能力=上下文压力触发、改写「已存」工具结果的紧急截断阀 ——【C1 裁决：假阴性，已修正】
   原检索式=truncate.*context|emergency.*truncate|shrink.*tool result|rewrite.*result|compress.*tool output
   原命中=仅建时上限 codemode.md:12,43；mcp.md:232；compaction.md:291（仅摘要请求内 2000 字符）
   为什么原检索式漏了=检索词汇库错位：原文用 rewrite/shrink/truncate，Pi 用 **context_edit + replacement/omits**
   正面命中（决定性）=session-format.md:143-147（ContextEditEntry：append-only 编辑**已存** entry；只改未来 model
     context；target entry 与其元数据在 raw history/UI/export/accounting **不变**；targets 可为 user/assistant/
     **tool-result**/custom；replacement:null=省略、非空=替换）+ :235 + extensions.md:118（turn_end /
     agent_before_settle 可链式追加 context_edit 条目）
   已排除的同义命中=codemode.md:12,43、mcp.md:232（建时上限，非运行期改写）；compaction.md:291（摘要请求内截断）
   修正后的结论=「只改发出的、不改存储」原语**存在**且语义逐字对应 Norma；缺「压力触发 + 选最大未截断结果」→ O-3
   残余=触发时机仍无 Pi 机制
 D 能力=压缩/context_edit 后的运行期 tool pair 孤儿修复
   检索式=orphan|unpaired|repair.*pair|tool_calls must be followed|synthetic.*result
   命中=compaction.md:39（length 响应保留合成失败 result，属建时）；余 0
   残余=Pi 以「禁切 tool result」预防孤儿(:136)，无运行期修复；对 context_edit 单侧移除无文档化补偿。
```

## 3. 「压缩的破坏性」三层对照

| 不可拆单元 | 谁保证 | 证据 | 强制层级 |
|---|---|---|---|
| tool_use ↔ result | Norma：边界双向扩张 + prune 双侧孤儿剥离 | `toolpairs.go:12` `prune.go:154-210` | `E-C[Norma]` + `R-T` |
| tool_use ↔ result | Pi：切割点禁则（never cut at tool results） | `compaction.md:136` | `E-C[Pi]` 内建 |
| tool_use ↔ result | myflow：无，靠 Pi | — | `E-N[myflow]` |
| 一轮 reasoning+acts+results | Norma：`WithdrawSplitTurns` 撤整轮 + prune 期对账 | `turnintegrity.go:75` `prune.go:269` | `E-C[Norma]` + `R-T` |
| 一轮 reasoning+acts+results | Pi：消息粒度（thinking 与 toolCall 同条 assistant message）+ 只切整条；但 `context_edit` 可整条移除/替换 | `message-types.md:42-50` `compaction.md:130-136` `session-format.md:147` | `E-C[Pi]` 配对 / 无孤儿修复 |
| 一轮 reasoning+acts+results | myflow：无，靠 Pi | — | `E-N[myflow]` |
| 硬保护消息不被压 | Norma：`AlwaysProtectedTools`+`cfg.ProtectedTools`，compress 期删覆盖集 | `protected.go:13,74` `compress.go:371-377` | `E-C[Norma]` + `R-T` |
| 硬保护消息不被压 | Pi：**无此概念**（仅软尾部） | `compaction.md:82,443` | `E-N[Pi]` |
| 硬保护消息不被压 | myflow：无 | — | `E-N[myflow]` |

**Pi 侧切割规则原文**（`…/@earendil-works/pi-coding-agent/docs/compaction.md:130-136`）：

> Valid cut points are: User messages / Assistant messages / BashExecution messages / Custom messages (custom_message, branch_summary). Never cut at tool results (they must stay with their tool call).

## 4. Norma 有、myflow 用别的办法解决

- **配对等价覆盖（NOA-05/06）**：myflow 不自建配对修复，直接吃 Pi「只切整条消息、禁切 tool result」（`compaction.md:136`）→ `V-PI` 而非缺口。仅当 myflow 将来**使用 `context_edit`** 才会暴露 Pi 无运行期孤儿修复的空白（登记潜在 `RISK`，见 T3）。
- **常驻提示词存活（NOA-11）**：Norma 靠 system prompt 常驻；myflow 主会话改用每回合 `custom_message` 重注入（`ix:319-337`）。目标达成但**存活性弱于 Pi 的 system checkpoint**（`session-format.md:134`）——正是 `CAP-CTX` 的 `RISK` 源头。
- **紧急截断的部分目的**：myflow 的注入预算截断自控（`ci`）；模型工具输出侧**Pi 已给原语**（`context_edit`，属 `O-3`），myflow 缺的是**压力触发判定**（C1 修正，见 `GAP-NOA-08`）。

## 5. 自我声明（design.md §10）

- **全量逐行**：Norma `noa/{nudge,nudgetext,nudge_types,turnintegrity,toolpairs,protected,truncate,prune,hideconsumed,processturn,prompts_system,config,const}.go`；`compress.go` 的 stage 与 step(4)(5)(6)(9)(10)；Pi `compaction.md` `session-format.md` `message-types.md` `extensions.md` 全文；myflow `ci` 全文、`ix:180-460`。
- **只检索**：`prompts_rules.go`（结构确认，未逐字抄）；`panel.go` `parseinput.go`；Norma `*_test.go` 读测试名+关键断言；Pi 其余 36 篇走 §2 NEG 全局扫描（命中即止）。
- **未读**：`noa/{refs,tier,state,boundaries,pipeline,recommend,rebuild,sync}.go`（→S4）；`noaadapter/`、`transcript/`（→S5）。
- **不审计**：`examples/`、`cmd/`（非能力提供者，00-baseline §5）。
- **薄弱**：NOA-05 的 Pi 判定依「消息粒度 + 切割点」推断，未运行时实测 `context_edit` 孤儿后果；§2-D 仅文档面。
- **可疑 O-2 原文**：none。`extensions.md:104` 仅「Prefer changing prompt sections, selected tools, or guidelines」，未明示「压缩/nudge 归扩展」→ 本域不判 `O-2`。
