# S7 — HOOK / MCP / SKILL 三域归属与覆盖

## 0 前置：三个必查事实

**F1 — MCP 归属链（本环境）**。Pi 1.2.0 **有**内建 MCP（stdio+streamable HTTP、`~/.pi/agent/mcp.json`
与 `.pi/mcp.json`、OAuth、resources、`pi mcp` CLI：`docs/mcp.md` 全篇），但本机 `settings.json` 的
`extensions=["-builtin:mcp"]` **显式关闭**它。该值由 A-EXT `pi-mcp-adapter` v5.3.0 自己写入
（`~/.pi/agent/npm/node_modules/pi-mcp-adapter/pi-builtin-mcp.ts:10-25`），`/mcp` 由适配器注册
（同包 `index.ts:1725`），替换语义见 `docs/mcp.md:264`「Replace the built-in MCP support」。
适配器读 `.mcp.json`/`~/.config/mcp/mcp.json`/`mcp-adapter.json`（`config.ts:16-23,698-708,739`；
`~/.pi/agent/mcp-adapter.json` 实存 deepwiki/chrome-devtools/parallel-search），并在 Pi≥0.99 时
**import Pi 的 `~/.pi/agent/mcp.json` 与 `.pi/mcp.json`**（`index.ts:215` → `config.ts:242-251,725-737,801-811,484-491`；
`~/.pi/agent/mcp-cache.json` 命中 `codebase-memory-mcp`）。
→ 本环境 **MCP 提供者 = A-EXT，配置载体 = A-PI 文件 ∪ A-EXT 文件**；记成 A-PI 会掩盖接管。

**F2 — 同名不同源陷阱**。`~/.pi/agent/extensions/cbmem.ts:1-60` 用 `spawn` 直接调
`codebase-memory-mcp.exe cli`，把 `search_graph`/`trace_path` 等 15 个**裸名**工具注册为 Pi 工具，
与 MCP 路径无关。工作区 `AGENTS.md` 里那串裸名是 **A-EXT**，既非 MCP 也非 Pi core。

**F3 — O-2 原文（PRD 此前缺引用）**。`.../pi-coding-agent/README.md:19`「Pi ships with powerful defaults
but skips features like sub-agents and plan mode. Ask Pi to build what you want, or install a package that
does it your way.」这是 1.2.0 语料里**唯一**支持「刻意外包」的原文（`docs/*.md` 40 篇无 sub-agent/plan mode 字样）。

## 1 表 A：逐 `CAP-*`（Pi 侧均 `[v1.2.0]`）

| CAP | Norma 机制 + 证据 | Pi 1.2.0 现状 + 证据 | 域 | O |
| --- | --- | --- | --- | --- |
| HOOK-01 生命周期集合 | 8 点 `Registry`：`PreToolUse/PostToolUse/PostToolUseFailure/UserPromptSubmit/SessionStart/SessionEnd/Stop/SubagentStart`(`hook/hook.go:17-25`)、`Event`(:29)、`Result`(:41) | `pi.on()` 共 **41** 事件(`dist/core/extensions/types.d.ts:1186-1228`；C1 `F-1` 更正原记 42)；语义 `docs/extensions.md:96-128` | A-PI | O-1 |
| HOOK-02 可 block | `Decision=="block"`(:57)；PreToolUse 首个 block 即停(:89-98)，`harness/tools.go:78-80` 以 error tool_result 回给模型；测 `hook_test.go:8` | `tool_call`→`{block,reason}`(`types.d.ts:1089-1098`)；handler 抛错亦 fail-safe 阻塞(`extensions.md:263`) | A-PI | O-1 |
| HOOK-03 可改写/注入 | `UpdatedInput` 末个非空生效(:89-98)；`AdditionalContext` 拼接注入(:135-143)；Stop 的 block→注入并续跑(:115-131) | 原地改 `event.input`(`types.d.ts:1090`)；`before_agent_start`→`{message}`(:1125-1129)；`tool_result` 换 content/details/isError(:1114-1120)；`turn_end`/`agent_before_settle`→`entries+continue`(:786-795) | A-PI | O-1 |
| HOOK-04 Stop 门控 | 两态：`PreventContinuation` 硬停 vs `block` 续跑(`hook.go:115-131`；`harness/query.go:475-478`)，`stopHookActive` 防死循环(:472-474)；测 `hook_test.go:24,45` | `agent_before_settle` 为「最后一个可动作边界」，可 append entries + `continue:true` 请求一次下一请求(`extensions.md:67,118`；`types.d.ts:796-799`)；`agent_settled` 纯通知终局(:800-805) | A-PI | O-1（无硬停原语，语义等价；`terminate` 仅 `tool_call` 提示位 `:1093-1097`） |
| MCP-01 stdio 客户端 | JSON-RPC 2.0 换行分帧、`initialize` 2024-11-05、`tools/list`→CoreTool(`mcp/mcp.go:179-208`)、`NewStdioClient`(`mcp/stdio.go:32`)、权限 `AskUser`(:41-43,216-218)；测 `mcp_test.go:12,62` | 内建：stdio+HTTP、`mcp.json`(`mcp.md:32`)、`timeout` 默认 60s、progress 重置(:68)、20KB 中段截断(:232)、HTTP 重试 2 次(:141)、OAuth(:111+)、resources(:236+)、`pi mcp` CLI(:9-31) | **A-PI，本环境被 A-EXT 接管** | O-1 + O-6 |
| MCP-02 进程内 server | `InProcessServer` 把宿主函数适配为 `mcp__<server>__<tool>`(`mcp.go:21,34-57`) | 无此概念；等价物 `pi.registerTool()`(`extensions.md:133-151`) + `namespace` 分组(:163) | A-PI | O-3（可替代，非缺口） |
| MCP-03 命名与暴露 | 三段式 `mcp__<server>__<tool>`(`mcp.go:21`) | 同名三段式，非法字符→`_`，冲突加 hash(`mcp.md:77,191`)；四档 `exposure` + 逐工具 `toolExposure`(:191-217)；`--tools 'mcp__x__*'`(:225) | A-PI；本环境另由 A-EXT 自建 `mcp__<server>` 代理(`namespace-tools.ts:12-18`、`mcp-references.ts:38-40`) | O-1 + O-6 |
| SKILL-01 SKILL.md + frontmatter | YAML 头 `name/description/license/compatibility/whenToUse/mcps`，坏头降级不丢 skill(`skill/skill.go:248-293`)；`LoadDir`(:207-245) | 实现 agentskills.io 规范；字段表含 `metadata/allowed-tools/disable-model-invocation`(`skills.md:5,70-78`)；坏文件**不加载**，同名保留首个并警告(:85) | A-PI | O-1 |
| SKILL-02 按需注入 | `Skill` 工具：listing 常驻 tool prompt，正文作**独立 user 消息** `Result.Extra`(`skill.go:100-163`)；listing 预算 8000 字符/描述 500，超预算退化为仅名字但**永不丢弃**(:94-96,174-201；测 `skill_test.go:86`) | 启动时把 name+description+path 放进 system prompt，正文由模型 `read SKILL.md` 按需加载(`skills.md:43-45`；`how-pi-works.md:19-21`)；`/skill:name` 强载(`skills.md:45-47`)、`enableSkillCommands`(`settings.md:158`) | A-PI | O-1 |
| SKILL-03 **存活于压缩** | 压缩后 `reinjectSkills` 把边界前每个 skill **最新一次**调用正文逐字重放，预算 5000/25000 tok、超限丢最旧(`compaction/compaction.go:346-350,363+`；`llm/skillmsg.go:9-56`)；测 `compaction_test.go:55,84,105`、`skills_reinject_test.go` | **宿主给一半**（C1 修正）：skill **roster**（name+description+path）经 system section 存活于压缩（`session-format.md:84,127-131,248`、`skills.md:43-45`）；**正文**（`/skill:name` 展开的 user 消息 / `read SKILL.md` 的 tool_result）被摘要、无逐字 re-inject（§5 + NEG-3） | **A-PI(部分)** | **O-3** |
| SKILL-04 解锁 skill 声明的 MCP | frontmatter `mcps:`/`mcp:`(`skill.go:255-258`)；调用时 `OnInvoke` 把该 server 的 deferred 工具加入 unlock 集合并附名字清单(:48-53,149-156)；测 `mcps_test.go:10,28`；门控见 `agentcore/deferred_test.go:104`(`UnlockSet`) | 方向相反：`allowed-tools` 是「实验性**预授权**列表」(`skills.md:78`)，非解锁；MCP 侧由 `deferred`+`tool_search`、`hidden` 逐工具召回(`mcp.md:191-217`)，**与 skill 调用无联动**（NEG-4） | A-PI(部分) | O-5 |

## 2 myflow 行（逐 CAP）

- **HOOK-01**：注册 7 个 Pi 事件 —— `session_start`(`.pi/extensions/myflow/index.ts:273`)、`input`(:302)、
  `before_agent_start`(:319)、`context`(:340)、`tool_call`(:420)、`session_before_compact`(:455)、
  `agent_before_settle`(:464)。**E-C[myflow]**；自测断言存在性 `tests/extension.test.ts:166-168`。
  ⚠ **文档漂移**：`references/harness-conventions.md:101-102` 与 `myflow-meta/SKILL.md:60-68` 称
  「all six hooks」且只列 6 个，**漏 `agent_before_settle`**（虽在 SKILL.md:68 单列）。
- **HOOK-02**：`tool_call` 递归守卫 + `writesUnder` 写范围守卫，返回 `{block,reason}`(`index.ts:420-453`)。
  **E-C[myflow] + R-T**：`tests/subagent.test.ts:434,456,513,525`（含 fail-closed、`..`/绝对路径/空作用域拒绝）。
- **HOOK-03**：`before_agent_start` 返回 `message`(`index.ts:319-338`)；`context` 返回替换后的 `messages`(:340-418)；
  `agent_before_settle` 返回 `custom_message`(:478-500)。**E-C[myflow]**。
- **HOOK-04**：门控 `myflow-check` 直至 verify 通过，`continue:true` + `MAX_VERIFY_ATTEMPTS` 上限(`index.ts:464-500`)。
  **E-C[myflow] + R-T**：`tests/extension.test.ts:285,318,356`（含有界、仅对 check 生效）。
- **MCP-01/02/03**：**myflow 无任何 MCP 集成**——myflow 目录内唯一 mcp 字样是 `subagent.ts:69` 的进程清理注释。
  → myflow 层 = `A-NONE`；同时**不产生 MCP 契约假设**（低耦合，正面）。
- **SKILL-01**：8 个 `.pi/skills/*/SKILL.md` 只有 `name`/`description`（各 `:2-3`）；结构卫生由自家测试锁定
  `tests/skills-hygiene.test.ts:29-65`（存在性/name/description/≤1024/名字正则）→ **E-C[myflow]+R-T，强于 Pi**（Pi 只警告 `skills.md:85`）。
  另 `:120-131` 锁定 agent 三件套的 frontmatter、`tools` 字符串与 `Recursion Guard` 文本；`:67-73` 锁定 prompt 模板 description。
- **SKILL-02**：完全依赖 Pi 的按需加载，无自建 listing/预算。对应自建物是 `.pi/agents/*.md` 与 `.pi/prompts/*.md`
  （`agents.ts:164-171` 解析 `tools:` → **E-G[myflow]** 白名单）。
- **SKILL-03**：**无**（无 re-inject；工作流状态靠 `context` 钩子重注入补偿，属 `CTX` 域）。
- **SKILL-04**：**无**（8 个 SKILL.md 无 `mcps:`；myflow 无 MCP 集成）。

## 3 NEG 块

**(NEG-1) Pi 无 SubagentStart 等价宿主钩子**
语料 = `pi-coding-agent` 1.2.0：`docs/*.md`(40)、`dist/core/extensions/types.d.ts`、包根 `README.md`
检索式 = `sub-?agents?|SubagentStart|subagent`（忽略大小写）
命中 = `README.md:19`（唯一，语义为「跳过 sub-agent 特性」）；`on()` 全表 **41** 项无对应（C1 `F-1` 更正）
残余风险 = child session/worker 等别名会漏；已人工通读 `on()` 全表(`types.d.ts:1186-1228`)

**(NEG-2) Pi 无进程内 MCP server 原语**
语料/检索式 = 同上，`in-?process|InProcess|registerMcpServer.*function|MCP server API`
命中 = 0；`registerMcpServer(name, config)` 只收**配置**且形状等同 `mcpServers` 条目(`extensions.md:195-206`)
残余风险 = 「registerTool+namespace 模拟」不含关键字，但属替代方案，已记 O-3 而非 O-1

**(NEG-3) Pi 无 skill 跨压缩保留机制** —— **【C1 裁决：假阴性，已修正】**
原检索式 = `skill`（语料重心压在 `compaction.md`）
原命中 = `skills.md`、`how-pi-works.md`、`settings.md`、`slash-commands.md`、`packages.md`、`extensions.md:181`；**`compaction.md` 命中 0**
原残余风险 = (a) 不提 skill 的措辞（如「instructions 保留」）；(b) 保留逻辑若在 `dist/` 代码而非文档中会漏
**为什么原检索式漏了**：Pi 的保留机制**不叫 skill 保留**，而叫 **system prompt checkpoint**——「谁保留」由 `sections` 机制承担，「skill」只是其中一个 section 的**内容**。只查 `compaction.md` 的字面 `skill` 必然落空（机制文档在 **`session-format.md`**）。
**正面命中（决定性）**：`docs/skills.md:43`「adds each skill's name, description, and path **to the system prompt**」；`docs/session-format.md:84` system message 形如 `{"role":"system","content":"","sections":{"skills":"…"}}`；`docs/session-format.md:127-131` `CompactionEntry.systemMessage` = 「… becomes the leading system message of the compacted context, and system messages among the kept entries are dropped in its favor」；`docs/session-format.md:248`「**Pre-compaction system messages are folded into the complete checkpoint**」
**已排除的同义命中**：`dist/bundle/chunks/chunk-HACVPRBJ.js:11` 的 `collapseSystemMessages()`（`E2` 代码旁证，非权威面）；`skills.md:45` 的 `/skill:name` 强载（属**正文**注入，不是 roster 保留）
**修正后的结论**：Pi **有** roster 侧的跨压缩保留（`O-3`，`A-PI(部分)`）；**无**正文逐字 re-inject——后者才是 `GAP-SKILL-03` 的缺口。
**残余风险**：正文存活仍无宿主机制；`context_edit` 可改写但不自动重放正文。

**(NEG-4) Pi 无 skill→MCP 解锁联动**
语料 = `docs/skills.md` + `docs/mcp.md` + `types.d.ts` 全事件表
检索式 = `allowed-tools|unlock|reveal|deferred.{0,40}skill|skill.{0,40}mcp`
命中 = `skills.md:78`（`allowed-tools` 方向相反）；`mcp.md:191-217`（deferred/hidden 由 `tool_search` 与配置驱动）
残余风险 = 中文或别名表述会漏；本语料为英文全篇扫描

## 4 钩子对照（Pi 事件表 vs Norma 8 回调）

| Norma | Pi 等价物 | 强度 |
| --- | --- | --- |
| PreToolUse | `tool_call`：block + 原地改 `event.input`(`:1090-1098`) | 等价或更强 |
| PostToolUse | `tool_result`：可换 content/details/isError(`:1114-1120`)；另 `tool_execution_end` 带 `durationMs`(`:872-882`) | 更强 |
| PostToolUseFailure | **无独立失败事件**，靠 `isError` 分支(`:877`) | 弱一档，O-3 |
| UserPromptSubmit | `input`：`continue/transform/handled`(`:910-930`) + `before_agent_start.message`(`:1125-1129`) | 更强（可改写或吞掉输入） |
| SessionStart | `session_start`，带 `reason: startup\|reload\|new\|resume\|fork`(`:574-581`) | 更强 |
| SessionEnd | `session_shutdown`（须幂等清理，`extensions.md:265-266`） | 等价 |
| Stop | `agent_before_settle`：`entries`+`continue`(`:792-799`)；无硬停原语 | 等价 |
| SubagentStart | **无**（NEG-1；A-MF/A-EXT 子代理无宿主级启动钩子） | 缺失 |

（`:NNN` 均指 `dist/core/extensions/types.d.ts` 1.2.0。）
Pi 独有且有价值（Norma 无）：`project_trust`、`resources_discover`、`session_before_switch/fork/compact`、
`context_with_system`、`before_provider_request/headers`、`provider_stream_event`、`cache_warming_decision`、
`message_update`、`turn_start/end`、`ui_prompt_start/end`、`model_select`、`mcp_servers_change`。

## 5 skill 跨压缩：机制对照

**Norma（E-C+R-T，三段链条）**：(1) 正文作**独立 user 消息**注入并自带 `<invoked-skill name="…">`
信封以便自识别(`llm/skillmsg.go:9-56`)；(2) `reinjectSkills` 取非破坏性历史里每个 skill 的**最新**一次调用，
按新到旧纳入预算后恢复时间序，已在保留尾部的跳过(`compaction/compaction.go:363+`)；(3) 预算
`maxSkillReinjectTokens=5000`/`Total=25000`，超限丢最旧 + `TruncateSkillMessage` 截断并留
「重读 base dir」提示(`compaction.go:346-350`；`skillmsg.go:78+`)。

**Pi（`A-PI(部分)` / `O-3`，C1 修正）**：`compaction.md:130-136` 规定合法切割点（user/assistant/bash/custom 消息；
**tool result 不可切**）——skill **正文**位于 tool_result（或 `/skill:name` 展开的独立 user 消息），故要么与
tool call 成对保留，要么整对进摘要；摘要序列化时 tool result 还被截到 2000 字符(`compaction.md:291`)。
**但 roster 侧存活**：name/description/path 进 system prompt 的 `sections.skills`(`skills.md:43`、`session-format.md:84`)，
而 `CompactionEntry.systemMessage` 是完整 system checkpoint，pre-compaction system messages 被折入该
checkpoint(`session-format.md:127-131,248`)——故 **roster 跨压缩存活、正文不存活**；缺的是**正文逐字 re-inject**。

## 6 Norma 有、myflow 另法解决（供 `ADV-*`/`V-OWNED`）

| Norma | myflow 替代 | 证据 |
| --- | --- | --- |
| 8 点回调完备 | 只注册 7 个 Pi 事件，按需增长 | `index.ts:273-500` |
| UserPromptSubmit 注入 | `before_agent_start.message` + `context` 钩子 | `index.ts:319-338,340-418` |
| Stop hook 门控 | `agent_before_settle` + verify 命令 + 有界重试 | `index.ts:464-500` |
| skill listing 预算 | 无（8 个 skill，交给 Pi 管 listing） | — |
| skill `mcps:` 解锁 | 无；语言层用 agent md `tools:` 白名单(**E-G**) | `agents.ts:164-171`、`.pi/agents/myflow-research.md:5` |
| 进程内 MCP server | 直接注册 Pi 工具（`myflow_subagent`、`/myflow-status`） | `subagent.ts`、`index.ts:257-271` |

⚠ 易混淆：`.myflow/agents/{architect,reviewer}.md` **不是** `myflow_subagent` 的 agent 类型——
`agents.ts:228-243` 只发现 `.pi/agents/`；前者由 `channel.py:35,75` 读取。

## 7 自我声明

**全量读**：Norma `hook/hook.go`、`skill/skill.go`、`mcp/mcp.go`+`stdio.go`(导出面)、`llm/skillmsg.go`、
`compaction/compaction.go` 的 skill 重注入段、`harness/{tools,query}.go` 钩子点、测试标题清单。
Pi 1.2.0：`extensions.md`、`mcp.md`、`skills.md` **全篇**；`compaction.md`/`how-pi-works.md`/`settings.md`/
`packages.md`/`slash-commands.md`/`prompt-templates.md` 命中段；`README.md:15-21`；
`dist/core/extensions/types.d.ts:574-581,723-935,1067-1150,1186-1266`。
A-EXT：`settings.json`、`mcp-adapter.json` 全篇；`extensions/{cbmem,rtk}.ts` 关键段；`pi-mcp-adapter` 的
`package.json`、`index.ts`/`config.ts` 关键段、`pi-builtin-mcp.ts`、`namespace-tools.ts`、`mcp-references.ts`；
`mcp-cache.json` 命中。myflow：`index.ts:230-500`、`agents.ts`、8 个 `SKILL.md` frontmatter、
`tests/skills-hygiene.test.ts` 全篇、`tests/{extension,subagent}.test.ts` 命中段、`channel.py` 头部。

**只检索未逐行读**：Norma `llm/`(除 skillmsg.go)、`harness/`(除钩子点)；Pi `dist/` 其余文件；
`pi-mcp-adapter` 其余 100+ 文件；myflow `subagent.ts`/`status.ts`/`context-injection.ts`。
**未读及理由**：Norma `examples/`、`cmd/`（00-baseline §5 已定不审计）；Pi `dist/` 全量（非权威面）。

**未验证（不得当事实）**：(a) 会话里裸名 `search_graph` 等究竟由 `cbmem.ts`(A-EXT) 还是 MCP `directTools`
提供——两条链证据俱在，research 子代理内部无法枚举会话工具表；两者**均**应记 A-EXT（F2）。
(b) 「skill 正文压缩后可由模型重读 SKILL.md 恢复」是**行为**问题，docs 未规定；本片只判定「无保留机制」，
严重度定级留给 `03-gap-register.md`。

**E5 使用**：无。本片所有结论均为 E0/E1/E2/E3/E4。
