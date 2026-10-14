# myflow × Norma 横评与能力补足标准

## Goal

以 `../Norma`（Go 编写的通用 Agent Harness SDK）为参照物，对当前仓库做一次**能力横评**：逐项识别 Norma 具备、而「Pi 运行时 ∪ myflow 层」尚未覆盖的能力缺口，并为每个缺口写出可直接执行的**补足标准**文档，使 myflow 的功能面逐步完备。

明确**不以「零依赖」为目标**——myflow 建立在 Pi 之上，Pi 已提供的能力不计为缺口。横评的价值在于分清「宿主已给」「宿主没给但 Norma 证明有价值」「Norma 特有且与 myflow 场景无关」三类。

本任务只产出**分析文档**（用户选定方案 A），不写实现代码。

## What I already know

### 对比对象事实（已核实）

**Norma**（`C:/Users/wocai/Desktop/Norma`，Go 1.23+，module `github.com/Autumn-27/norma`）

- 规模：206 个 `.go` 文件、约 37,226 行、98 个 `*_test.go`。
- 定位：通用 Agent Harness **SDK**，provider/scenario 无关，不自带系统提示词。
- 包清单（`README.md`「Packages」表）：`llm`（Anthropic + OpenAI 双协议归一）、`tool`（fail-closed 工厂 + Registry + 轻量 JSON-Schema 校验 + 核心工具集 + 延迟工具）、`permission`（allow/deny/ask、6 种 mode、deny 优先、四阶段 `Evaluate`）、`harness`（`iter.Seq2` 循环、只读并行/写串行调度、tool_use↔tool_result 配对、终止原因、取消传播）、`compaction`（Snip/MicroCompact/Context Collapse/AutoCompact + 熔断 + prompt-too-long 反应式恢复 + 非破坏性 boundary）、`hook`（8 个生命周期回调，可 block/改写/注入/门控 Stop）、`subagent`（复用同一循环 + 递归深度守卫）、`mcp`（stdio JSON-RPC + 进程内 server）、`plan`（只读探索 → ExitPlanMode → 中途翻转权限模式）、`memory`（frontmatter markdown + `MEMORY.md` 索引 + 相关度选择 + 陈旧告警）、`skill`（`SKILL.md` + frontmatter + 按需注入且可存活于压缩 + 解锁 skill 声明的 MCP 工具）、`coordinator`（LLM 驱动 Agent 工具 or 编程式 `RunParallel` 扇出）、`agentcore`（`Session`/`Prompt`/一次性 `Run`/JSONL 转录 + `Resume`）。
- 目录另有 `agentcore/ cmd/ compaction/ coordinator/ examples/ harness/ hook/ llm/ mcp/ memory/ noa/ noaadapter/ permission/ plan/ skill/ subagent/ tool/ transcript/`。
- 自述设计要点：双协议归一、宿主拥有 prompt、fail-closed 工具默认值、`iter.Seq2` 流式。

**Pi 运行时**（用户定义：*当前运行本会话的那个运行时*；TypeScript 上游产物，myflow 不拥有、不可修改）

- 权威面是**已安装的 1.2.0 产物**，不是任何源码工作区。自证证据（本次会话实测）：`pi --version` → `1.2.0`；`PI_CODING_AGENT=true`、`PI_SESSION_ID=01a13934-682f-7570-900a-5d346ddb7d62`、`PI_SESSION_FILE=C:\Users\wocai\.pi\agent\sessions\--C--Users-wocai-Desktop-myflow--\2026-10-14T06-58-18-289Z_01a13934-….jsonl`、`PI_PROVIDER=deepseek`、`PI_MODEL=deepseek-flash`。
- 安装版本（`C:/Users/wocai/.bun/install/global/node_modules/@earendil-works/`）：
  `pi-coding-agent 1.2.0`、`pi-agent-core 1.2.0`、`pi-ai 1.2.0`、`pi-mcp 1.2.0`、`pi-codemode 1.2.0`、`pi-telemetry 1.2.0`、`pi-tui 1.2.0`、`chord 1.1.0`。
- **版本落差（重要）**：源码工作区 `C:/Users/wocai/Desktop/pi/packages/coding-agent/package.json` 为 **1.0.4**，落后于运行中的 **1.2.0**。因此 `Desktop/pi` **不是**本次对比的运行时，只可作「实现细节参考」，且**可能过期**；凡以其为据的结论一律标为推断。
- 权威取证面 = 安装目录 `docs/`（41 篇）+ 各包公开 API + 仓库内的宿主类型快照 `.pi/extensions/myflow/pi-coding-agent.d.ts`。
- Pi 安装目录自带文档：`cli.md`、`compaction.md`、`extensions.md`、`mcp.md`、`skills.md`、`session-format.md`、`sessions.md`、`sdk.md`、`rpc*.md`、`settings.md`、`providers.md`、`models.md`、`codemode.md`、`security.md`、`usage.md` 等。
- Pi 自述：「minimal, extensible agent harness」，并**明确声明跳过 sub-agents 与 plan mode**、鼓励「让 Pi 构建你想要的」。这决定了横评的真正问题不是「Pi 有没有 X」，而是**「X 这个关注点归谁」**：
  - **宿主内建**：Pi core 直接提供（compaction、sessions、extensions/hooks、MCP、skills、tools、providers 等）→ 不是缺口，但要检查 myflow 是否在重复造轮子或没用上宿主能力。
  - **宿主刻意外包**：Pi 设计上就推给扩展层（subagent、plan mode、多智能体编排、长期记忆、工作流状态持久化）→ **这才是 myflow 必须拥有的地方，也是真缺口集中的地方**。
  - **两者皆无**：Norma 有、Pi 既未内建也未暗示外包 → 逐个判断是否值得补。
- **认知陷阱（必须写入文档）**：从会话内部看，Pi core 与 myflow 注册的工具/事件/命令是**融合**的（`myflow_subagent` 由 myflow 注册，并非 Pi 内建）。因此「宿主能力」的判定必须依据 Pi 文档与包 API，**不得以「我当前能用什么」为准**——否则会把 myflow 的能力记到 Pi 头上，恰好掩盖掉真正的缺口。

**myflow 层**（本仓库）

- `.pi/extensions/myflow/`（9 个 TS）：`index.ts`、`context-injection.ts`、`parse-workflow-state.ts`、`turn-cache.ts`、`status.ts`、`subagent.ts`、`agents.ts`、`escape-hatch.ts`、`find-project-root.ts`。
- `.pi/agents/`（3 个）：`myflow-implement.md`、`myflow-check.md`、`myflow-research.md`。
- `.pi/prompts/`（4 个）：`myflow-continue.md`、`myflow-finish-work.md`、`myflow-parallel.md`。
- `.pi/skills/`（8 个）：`myflow-before-dev`、`myflow-brainstorm`、`myflow-break-loop`、`myflow-channel`、`myflow-check`、`myflow-meta`（+`references/harness-conventions.md`）、`myflow-spec-bootstrap`（+3 references）、`myflow-update-spec`。
- `.myflow/`：`workflow.md`（状态机单一事实源，3 个 Phase / 10 个 Step）、`scripts/`（`task.py`、`channel.py`、`get_context.py`、`worktree.py`）、`agents/`、`tasks/`。
- 测试：`tests/` 15 个文件（`agents-commands`、`channel`、`context-injection`、`escape-hatch`、`extension`、`mvp`、`project-root`、`scaffold`、`session-context`、`skills-hygiene`、`status`、`subagent`、`task-bridge`、`turn-cache`、`worktree`）。
- 已有生命周期：brainstorm → research → 配置 jsonl → `task.py start` → implement → check → update-spec → commit → finish/archive；状态通过 `[workflow-state:*]` 块注入。

### 已存在的相关任务

- `.myflow/tasks/explain-myflow-directory/`（仍为 `planning`）已解释 `.pi/` 与 `.myflow/` 的职责边界、可复制 payload vs 项目文件 vs 机器运行态、`findProjectRoot` 依赖 `.myflow/workflow.md`、`.myflow/.runtime/` 被 gitignore。本任务**复用其结论**，不重复论证目录设计。

### 已知的环境约束

- `.myflow/spec/` 目前为**空**。
- 主机无 WSL，shell 必须走 Git for Windows Bash。
- 用户级 `AGENTS.md` 要求图优先检索（codebase-memory-mcp），但 `myflow-research` 子代理工具白名单仅 `read, find, grep, ls`，**不能**假定子代理可访问 MCP——子代理需用直接读文件的方式取证。

## Assumptions (temporary)

- 用户真正的痛点不是「缺引擎功能」，而是**不清楚 myflow 相对成熟 harness 到底差在哪、哪些该补哪些不该补**，因此文档的可信度取决于「宿主已覆盖」这一列的准确性。
- 「Pi」指**当前运行本会话的运行时**（用户本回合明确更正），即已安装的 `@earendil-works/*` 1.2.0；**不是** `../pi` 源码工作区，**也不是**本仓库的 `.pi/` 资产。三者不可混用（详见 Open Questions · Q1）。
- Norma 的部分能力（`llm`、`permission`、`tool` 注册表）在 Pi 中已由宿主实现，横评不应把它们列为 myflow 缺口。

## Open Questions

- **Q1（已定，用户澄清）**：Pi 侧基准面 = **当前运行本会话的运行时**。对比因此是三层，而 Pi 是**独立实体**、不是 myflow 的一部分：

  | 层 | 对象 | 归属 |
  | --- | --- | --- |
  | L1 参照 | Norma（Go SDK，`../Norma`） | 外部，只读参考 |
  | L2 宿主 | **Pi 运行时 1.2.0** | 上游，**不可修改**，只能依赖或规避 |
  | L3 自有 | myflow（本仓库 `.pi/` + `.myflow/`） | 用户拥有，可改 |

  判定规则：
  - **真缺口** = Norma 有 ∧ Pi 运行时没有 ∧ myflow 没有。
  - **已承担的关注点** = Norma 有 ∧ Pi 没有 ∧ myflow 有 → 转入**机制强度对比**（不是缺口，是质量差）。
  - **约束而非缺口** = 必须改 Pi 才能补 → myflow 补不了，只能规避或在文档中登记为上游依赖。
  - **非缺口** = Pi 已内建。

- **Q3（已定 — 用户选定第 3 档）**：横评比对的**判定维度** = 功能清单 + 强制层级 + 宿主契约风险 + 相对优势保护。决策记录见 `design.md` ADR-1；下列 1–4 与推荐理由保留作为该选择的依据。
  1. 纯功能清单：有/没有。最快，但会漏掉两类真问题。
  2. 功能清单 + **强制层级**：每项标注 `代码强制 / 工具白名单 / 提示词约定`。
  3. 上面 + **宿主契约风险**（myflow 依赖 Pi 的某些行为，而该行为未文档化或不稳定）+ **相对优势保护**（Norma 没有而 myflow 有的东西，标为不可回退）。**（推荐）**
  4. 其他。

  推荐理由（已取证的两类反例）：
  - **名义有、实际靠约定**：`myflow-research` 的递归守卫是 `.pi/agents/myflow-research.md` 里的**提示词文字**（"Do NOT spawn another `myflow-research` sub-agent"）+ frontmatter `tools:` 白名单；而 Norma 的 `subagent` 是**代码**深度守卫。纯功能清单会把两者都记成「有」。
  - **悄悄会坏**：`.myflow/scripts/task.py` 用 `PI_SESSION_ID` 派生 `pi_<session>` 作为上下文键，`.pi/extensions/myflow/turn-cache.ts` 必须派生出**完全相同**的键；而 Pi 的会话恢复/分支/压缩会改变会话语义（`docs/sessions.md`、`session-format.md`、`compaction.md`），myflow 的任务指针却存在被 gitignore 的 `.myflow/.runtime/` 里。这类风险与「缺一个 memory 包」不是一个量级。
  - **注入会被压缩吃掉，全靠自身补偿（本次会话已取证）**：myflow 以 `custom_message` 注入 `[workflow-state:*]`，而该类型**既是合法压缩切割点又参与 LLM context**（`compaction.md:134`、`session-format.md:178`）→ 压缩可将其摘要掉；真正兜底的是 myflow 自己的「每回合重注入 + 压缩后按 `lastInjectionTs > lastCompactionTs` 重注入」。此为**宿主行为已文档化、但保证仍由 myflow 单侧承担**的唯一一例，风险与「缺一个包」不同：宿主一旦调整切点规则或事件时序，myflow 会**静默**失去状态注入。

- **Q2（Preference，暂定默认值）**：文档落点。默认建议 `.myflow/tasks/norma-benchmark-gap-analysis/`（任务产物）+ 将其中稳定的结论（如「Pi 提供 vs myflow 自建」边界、缺口分级规则）沉淀进 `.myflow/spec/`。若用户更希望直接进 `.myflow/spec/` 或仓库根 `docs/`，可调整。

## Requirements (evolving)

- 产出可信的**能力矩阵**：行 = 能力项，列 = Norma / Pi 引擎 / myflow，单元格须给**证据路径**（文件或文档）而非印象式判断。
- 对每个**真缺口**（Norma 有、Pi 与 myflow 皆无）产出**补足标准**条目，格式统一，可直接作为后续任务的验收依据。
- 明确标注**非缺口**及其理由（Pi 已提供 / Norma 特有但场景无关 / 与「不做零依赖」的定位冲突）。
- 矩阵须给出每项的**归属分类**（宿主内建 / 宿主刻意外包 / 两者皆无）与**强制层级**（代码 / 白名单 / 提示词）。
- 必须包含**宿主契约风险**清单：myflow 假设了 Pi 的哪些行为、证据强度、假设不成立的后果、可用什么方式钉住。
- 必须包含**相对优势清单**：Norma 没有而 myflow 有的能力，标注为不可回退。
- 明确区分「已核实」与「推断」，不得把推断写成事实。
- 不修改任何实现代码、不运行开发生命周期（`task.py start` 之外无副作用操作）。

## Acceptance Criteria (evolving)

- [ ] 能力矩阵覆盖 Norma 全部 13 个包的能力项，每项有 Norma 侧证据路径。
- [ ] 矩阵每一行的 Pi 侧判定都指向 1.2.0 安装目录的具体文档或包 API，且注明所依据的版本。
- [ ] 每个缺口条目含：能力描述、Norma 机制与证据、Pi 现状、myflow 现状、补足标准（可验收）、依赖与代价、优先级。
- [ ] 明确列出至少 3 项「看似缺口但实际不是」的条目及理由。
- [ ] 每个「有」的判定都附强制层级，且至少给出 2 个「名义有但仅靠提示词约定」的实证条目。
- [ ] 宿主契约风险清单至少覆盖：会话键派生（`PI_SESSION_ID`）、注入状态与压缩/分支的交互、`.myflow/.runtime/` 的机器本地性。
- [ ] 至少 3 项相对优势被明确标为不可回退。
- [ ] 全文区分已核实/推断，给出取证边界（哪些做了全量审计、哪些只是抽样）。
- [ ] 输出以中文撰写，术语保留英文原名以便对照。

## Definition of Done (team quality bar)

- 文档中的每条关键断言都能回溯到具体文件路径（Norma 侧、Pi 侧、myflow 侧各一）。
- 版本敏感处显式标注 Pi `1.2.0`，并说明 `Desktop/pi` 源码为 `1.0.4`、不作为权威依据。
- 不引入实现改动；`git status` 除 `.myflow/tasks/` 外无新增变更。
- 结论可被后续任务直接消费（缺口条目须能一对一转成实现任务）。

## Out of Scope (explicit)

- 不实现任何缺口（方案 A：仅分析交付）。
- 不以「达到 Norma 的功能对齐」或「零依赖」为目标；不评估 Go 与 TypeScript 生态差异的优劣。
- 不重构 myflow harness，不迁移目录，不改 `.pi/` 资产。
- 不审计 Norma 与 Pi 的性能、安全模型与代码质量的完整对标（仅在影响能力判定时提及）。
- 不覆盖 `../pi`、`../Norma`、`../agent`（Obsidian 笔记库）等外部仓库的改造建议。

## Technical Notes

- 已核实路径：`Norma/README.md`、`Norma/` 目录树与 `*.go` 统计；`Desktop/pi/packages/`、`Desktop/pi/packages/coding-agent/package.json`（1.0.4）；`~/.bun/install/global/node_modules/@earendil-works/*/package.json`（1.2.0）及 `pi-coding-agent/docs/`（41 篇）；本仓库 `.pi/`、`.myflow/`、`tests/` 清单；`.myflow/tasks/explain-myflow-directory/prd.md`。
- 取证方式约束：`myflow-research` 子代理仅有 `read, find, grep, ls`；主会话可用 MCP 图检索，但不得把主会话的图访问能力计入子代理能力。
- 需确认的潜在偏差：`Desktop/pi` 为 1.0.4 而运行时为 1.2.0，比较时须以 1.2.0 为准，否则会误判 Pi「缺失」某些新能力。
- 运行时自证证据（本次会话实测）：`pi --version` → `1.2.0`；`PI_CODING_AGENT=true`、`PI_SESSION_ID=01a13934-682f-7570-900a-5d346ddb7d62`、`PI_SESSION_FILE=…\.pi/agent/sessions/--C--Users-wocai-Desktop-myflow--\…jsonl`、`PI_PROVIDER=deepseek`、`PI_MODEL=deepseek-flash`。
- **原「取证空洞」已关闭，且原结论有误（检索模式过窄导致假阴性）**。`docs/compaction.md` 与 `docs/session-format.md` **直接**描述了「压缩 vs 扩展注入」的交互，5 条硬证据：
  1. `compaction.md:134`「Cut Point Rules」把 **Custom messages (`custom_message`, `branch_summary`)** 列为**合法切割点**；`:138` 补充「Metadata alone and newly appended custom messages do not move the cut.」
  2. `session-format.md:178`：`CustomMessageEntry` 是「Extension-injected messages that **DO** participate in LLM context」；而 `:166` 的 `CustomEntry`（extension state persistence）**不参与** LLM context。二者语义相反，不可混用。
  3. `session-format.md:123-137`：`CompactionEntry.systemMessage` 是「a complete system prompt/tool checkpoint」，成为压缩后上下文的**首个 system message**，且「system messages among the kept entries are dropped in its favor」。
  4. `session-format.md`「Context Building」：`compaction -> complete system checkpoint followed by compactionSummary`；「Pre-compaction system messages are folded into the complete checkpoint rather than replayed from the retained range.」
  5. `compaction.md:91-94` 恢复时序：`turn_end` → `agent_end` → append `context_edit` omissions → `session_before_compact` → 写 `compaction`。

  **对 myflow 的直接推论（已取证，「未决」解除）**：`.pi/extensions/myflow/index.ts:237-253` 的 `before_agent_start` 返回 `{ message: { customType: "workflow-state", … } }`，落地即 **`custom_message`**——它**参与 LLM context，同时又是合法压缩切割点**，故压缩**可以**把注入的 `[workflow-state:*]` 摘要掉。myflow 的保证因此**不来自宿主契约，而来自自身两处补偿**：`before_agent_start` 每回合重注入；`index.ts` 的 `context` 钩子以 `lastInjectionTs > lastCompactionTs` 为条件在压缩后重注入（`session_before_compact` 仅盖时间戳）。
- 已取证的反向对照（用于强制层级论证）：`.pi/extensions/myflow/subagent.ts` 中 `mode === "parallel" && isWriteCapable(agent)` 会**抛错拒绝**（唯一写者）、`MAX_PARALLEL_PROMPTS` 上限、`timeoutMs` 默认 15 分钟并落日志；这些是**代码强制**，在这几项上 myflow 不弱于 Norma。
- **归属域必须细分（本会话实测，修正“Pi vs myflow”二分）**：`~/.pi/agent/` 下存在**用户级第三方扩展**，它们**既不是 Pi core 也不是 myflow**：`~/.pi/agent/npm/node_modules/` 含 `pi-subagents-lite`、`pi-rounded-tools`、`pi-agent-loop`、`pi-ask-side`、`pi-mcp-adapter`、`pi-open-tui`、`pi-tui-commands`、`@upstash/context7-pi` 等；`~/.pi/agent/extensions/` 含 `cbmem.ts`、`rtk.ts`；`~/.pi/agent/skills/` 含 `codebase-memory`（以及两个 symlink）。**关键陷阱**：工具列表里的 `Agent` / `StopAgent` / `MessageAgent` / `AgentStatus` 由 `pi-subagents-lite`（`A-EXT`）注册，**不是 Pi core**；而 `myflow_subagent` 由 `A-MF` 注册。不做归属域区分则 `CAP-SUB-*` 必错。故 `design.md §2.2` 把归属细分为 `A-PI / A-EXT / A-MF / A-MCP / A-NONE`（ADR-2）。
- **`myflow-research` 曾无 `write`（已定性为刻意设计，**不是**缺陷）**：`subagent.ts:593` 的写者守卫按 **agent** 判定（`isWriteCapable`，`WRITE_TOOLS = {write, edit}`），拒绝一切写者并行——于是 research 为保住并行能力放弃了 `write`。**已修正**：research 获得 `write` 并声明 `writesUnder: research`，守卫改为**路径级**（仅拒绝「可写且未声明安全范围」的 agent）。写入范围契约见 `.myflow/spec/harness/index.md`。
- **注入预算实测**：`.pi/extensions/myflow/context-injection.ts` 的 `DEFAULT_CONTEXT_INJECTION_LIMITS` = 单文件 32 KiB / 单 artifact 64 KiB / 合计 128 KiB；且 `prd.md`、`info.md`、`.myflow/config.yaml` 始终注入。jsonl 引用的文件内容会占用同一预算，故 `research/*.md` 每个须 ≤ 8 KiB（`implement.md` §6）。
- 文档栈（本任务达到复杂档，进入 `task.py start` 前须评审）：`prd.md` + `design.md`（判定法、归属分类、证据规则、文档骨架）+ `implement.md`（审计执行顺序与分片）。
- 本任务由用户明确授权创建；当前状态 `planning`，尚未批准实现工作。
