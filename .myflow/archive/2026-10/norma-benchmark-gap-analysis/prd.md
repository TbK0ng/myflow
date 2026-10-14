# myflow × Norma 横评与能力补足标准

## Goal

以 `../Norma`（Go 编写的通用 Agent Harness SDK）为参照物，对 **myflow 及其宿主 Pi 运行时**做一次
能力**横评**：逐项识别 Norma 具备、而「Pi 运行时 ∪ 用户级扩展 ∪ myflow 层」尚未覆盖的能力缺口，
为每个缺口写出可直接执行的**补足标准**，并把整份横评交付到 `../critic_doc/`。

明确**不以「零依赖」为目标**——myflow 建立在 Pi 之上，Pi 已提供的能力不计为缺口。
横评的价值在于分清三类：「宿主已给」「宿主没给但 Norma 证明有价值」「Norma 特有且与 myflow 场景无关」。

本任务只产出**分析文档**，不写实现代码。缺口条目本身就是后续实现任务的输入。

## 用户已定的决策（本回合确认）

| 编号 | 问题 | 决定 |
| --- | --- | --- |
| `U-1` | 是否创建/接管 myflow 任务并进入 planning | **同意**。接管已有 planning 任务 `norma-benchmark-gap-analysis`，不新建 |
| `U-2` | 产出落点与子代理写权限 | **方案 a**：research 分片写进任务目录 `research/`（并发受限目录，`writesUnder: research` 已支持并行）；**最终 8+1 份文档由主会话写入 `../critic_doc/`**。仓库外目录只收成品 |
| `U-3` | 审计语料是否纳入 `noa/` + `noaadapter/` + `transcript/` | **纳入**（见下方「语料修正」，这是本回合发现的实质漏洞） |
| `U-4` | 交付粒度 | **横评语境重排**：不再用「7 个平铺文件」，改为 README + 8 篇编号正文 + `evidence/` 快照，按「结论 → 矩阵 → 缺口 → 风险 → 优势 → 非缺口 → 方法 → 取证边界」的横评阅读顺序组织 |

## What I already know

### 对比对象事实（已核实）

**Norma**（`C:/Users/wocai/Desktop/Norma`，Go，module `github.com/Autumn-27/norma`）

- 规模：206 个 `.go` 文件、约 37,226 行、98 个 `*_test.go`。
- 定位：通用 Agent Harness **SDK**，provider/scenario 无关，不自带系统提示词。
- **语料修正（本回合实测，推翻原计划）**：`README.md` 的「Packages」表只列 13 个包，但仓库里另有
  三个未出现在该表中的目录，合计约 7.6k 行非测试代码、占全仓 ~20%：

  | 目录 | 非测试行数 | 是什么 | 是否被原计划覆盖 |
  | --- | --- | --- | --- |
  | `noa/` | **5392** | 纯上下文引擎：`m00001` ref 寻址、`bN` 压缩块、tier 分层、Compress 工具、nudge 节律、turn 完整性、tool pair 完整性、硬保护消息、紧急截断、归档与 state | ❌ **完全漏掉** |
  | `noaadapter/` | **1918** | 把 noa 接进 `agentcore` 的适配层：接管 `ContextView`/`Compactor`、内容哈希身份、子代理状态继承、溢出学习窗口、`materialize` 降级、工具输出压缩、ref tag 渲染/剥离 | ❌ **完全漏掉** |
  | `transcript/` | **268** | append-only JSONL + 冷启动从边界重建压缩后视图 + 子代理 sidechain | ❌ **完全漏掉** |

  其余目录非测试行数：`tool` 5115、`llm` 2422、`harness` 1397、`compaction` 766、`examples` 588、
  `agentcore` 554、`mcp` 328、`skill` 331、`memory` 412、`cmd` 196、`subagent` 179、`hook` 152、
  `permission` 151、`plan` 144、`coordinator` 130。

  漏掉 `noa` 尤其致命：它恰好是 myflow 最该对照的那一块（`CTX` 域：注入的状态如何在长会话里存活）。

- 包清单（`README.md`「Packages」表）：`llm`（Anthropic + OpenAI 双协议归一）、`tool`（fail-closed
  工厂 + Registry + 轻量 JSON-Schema 校验 + 核心工具集 + 延迟工具）、`permission`（allow/deny/ask、
  6 种 mode、deny 优先、四阶段 `Evaluate`）、`harness`（`iter.Seq2` 循环、只读并行/写串行调度、
  tool_use↔tool_result 配对、终止原因、取消传播）、`compaction`（Snip/MicroCompact/Context Collapse/
  AutoCompact + 熔断 + prompt-too-long 反应式恢复 + 非破坏性 boundary）、`hook`（8 个生命周期回调）、
  `subagent`（复用同一循环 + 递归深度守卫）、`mcp`（stdio JSON-RPC + 进程内 server）、`plan`（只读探索
  → ExitPlanMode → 中途翻转权限模式）、`memory`（frontmatter markdown + `MEMORY.md` 索引 + 相关度选择
  + 陈旧告警）、`skill`（`SKILL.md` + 按需注入且可存活于压缩 + 解锁 skill 声明的 MCP 工具）、
  `coordinator`（LLM 驱动 Agent 工具 or 编程式 `RunParallel` 扇出）、`agentcore`（`Session`/`Prompt`/
  一次性 `Run`/JSONL 转录 + `Resume`）。
- 自述设计要点：双协议归一、宿主拥有 prompt、fail-closed 工具默认值、`iter.Seq2` 流式。
- noa 的设计主张（已抽读源码，供分片取证时对照）：**一次只压一层**（`noa/tier.go`）、
  **身份用内容哈希而非下标**（`noaadapter/identity.go`）、**turn 与 tool pair 不可拆半**
  （`noa/turnintegrity.go`、`noa/toolpairs.go`）、**硬保护与软保护区分**
  （`noa/protected.go`）、**nudge 按上下文增长节律而非固定轮数**（`noa/nudge.go`）、
  **all-or-nothing 装配**（`noaadapter/noa.go`：Compactor + Compress 工具 + 常驻提示词必须同生共死）。

**Pi 运行时**（用户定义：*当前运行本会话的那个运行时*；TypeScript 上游产物，myflow 不拥有、不可修改）

- 权威面是**已安装的 1.2.0 产物**，不是任何源码工作区。自证证据（会话实测）：
  `pi --version` → `1.2.0`；`PI_CODING_AGENT=true`、`PI_SESSION_ID=<session>`、`PI_PROVIDER`、`PI_MODEL` 均可读。
- 安装版本（`C:/Users/wocai/.bun/install/global/node_modules/@earendil-works/`）：
  `pi-coding-agent 1.2.0`、`pi-agent-core 1.2.0`、`pi-ai 1.2.0`、`pi-mcp 1.2.0`、`pi-codemode 1.2.0`、
  `pi-telemetry 1.2.0`、`pi-tui 1.2.0`、`chord 1.1.0`。
- **版本落差（重要）**：源码工作区 `Desktop/pi/packages/coding-agent/package.json` 为 **1.0.4**，
  落后于运行中的 **1.2.0**。因此 `Desktop/pi` **不是**本次对比的运行时，只可作「实现细节参考」，
  且**可能过期**；凡以其为据的结论一律标为推断（`E5`）。
- 权威取证面 = 安装目录 `docs/`（41 篇）+ 各包公开 API + 仓库内的宿主类型快照
  `.pi/extensions/myflow/pi-coding-agent.d.ts`。
- Pi 自述：「minimal, extensible agent harness」，并**明确声明跳过 sub-agents 与 plan mode**、
  鼓励「让 Pi 构建你想要的」。这决定了横评的真正问题不是「Pi 有没有 X」，而是**「X 这个关注点归谁」**：
  - **宿主内建**：Pi core 直接提供（compaction、sessions、extensions/hooks、MCP、skills、tools、
    providers 等）→ 不是缺口，但要检查 myflow 是否在重复造轮子或没用上宿主能力。
  - **宿主刻意外包**：Pi 设计上就推给扩展层（subagent、plan mode、多智能体编排、长期记忆、
    工作流状态持久化）→ **这才是 myflow 必须拥有的地方，也是真缺口集中的地方**。
  - **两者皆无**：Norma 有、Pi 既未内建也未暗示外包 → 逐个判断是否值得补。
- **认知陷阱（必须写入文档）**：从会话内部看，Pi core 与 myflow 注册的工具/事件/命令是**融合**的
  （`myflow_subagent` 由 myflow 注册，并非 Pi 内建）。因此「宿主能力」的判定必须依据 Pi 文档与包 API，
  **不得以「我当前能用什么」为准**——否则会把 myflow 的能力记到 Pi 头上，恰好掩盖掉真正的缺口。

**myflow 层**（本仓库）

- `.pi/extensions/myflow/`（TS）：`index.ts`、`context-injection.ts`、`parse-workflow-state.ts`、
  `turn-cache.ts`、`status.ts`、`subagent.ts`、`agents.ts`、`escape-hatch.ts`、`find-project-root.ts`。
- `.pi/agents/`：`myflow-implement.md`、`myflow-check.md`、`myflow-research.md`（后者含 `writesUnder: research`）。
- `.pi/prompts/`：`myflow-continue.md`、`myflow-finish-work.md`、`myflow-parallel.md`。
- `.pi/skills/`：`myflow-before-dev`、`myflow-brainstorm`、`myflow-break-loop`、`myflow-channel`、
  `myflow-check`、`myflow-meta`(+`references/harness-conventions.md`)、`myflow-spec-bootstrap`(+3 refs)、
  `myflow-update-spec`。
- `.myflow/`：`workflow.md`（状态机单一事实源，3 Phase / 10 Step）、`scripts/`（`task.py`、`channel.py`、
  `get_context.py`、`worktree.py`）、`agents/`、`spec/`、`tasks/`、`archive/`。
- 测试：`tests/` 15 个文件。
- 已有生命周期：brainstorm → research → 配置 jsonl → `task.py start` → implement → check → update-spec
  → commit → finish/archive；状态通过 `[workflow-state:*]` 块注入。

### 上一轮审计的产物已丢失（本回合核实）

- commit `4dd6f7d`「Commit the audit deliverables and the task artifacts」的正文提到
  「the four-P0 summary that drove this work, the eleven research shards behind it」，
  但其 `--stat` 只有 10 个任务 artifact 文件、**没有** `p0-summary.md` 与任何 `research/` 分片；
  磁盘上 `find . -name 'p0-summary*'` 与 `find . -type d -name research` 均为空。
- 结论：上一轮审计的**分析**产物不可恢复，只有它驱动的 **4 条 P0 修复**落地
  （空上下文门禁、面包屑不变式测试、`design.md`/`implement.md` 注入、指针包含性校验）。
- 因此本任务是**重做并升级**那次审计，而非续做。

### 已存在的相关任务

- `.myflow/tasks/explain-myflow-directory/`（`planning`）已解释 `.pi/` 与 `.myflow/` 的职责边界、
  可复制 payload vs 项目文件 vs 机器运行态、`findProjectRoot` 依赖 `.myflow/workflow.md`、
  `.myflow/.runtime/` 被 gitignore。本任务**复用其结论**，不重复论证目录设计。

### 已知的环境约束

- `.myflow/spec/` 目前只有 `index.md` 与 `harness/index.md`（已在 P0 补足中沉淀写范围与门禁契约）。
- 主机无 WSL，shell 必须走 Git for Windows Bash。
- `myflow-research` 子代理工具白名单为 `read, write, find, grep, ls`（无 MCP、无 bash），
  写范围被代码限制在 `<active task>/research/`；**不得**假定它可访问 MCP 或执行命令。
- 注入预算：`context_injection.max_artifact_bytes` = 65536、`max_total_bytes` = 131072；
  超出时该条目被替换为 `[myflow: context limit reached; omitted …]` 提示，**不是静默丢弃**，
  但仍会丢失证据——故必须有预算算术步骤（见 `implement.md` §6）。

## Assumptions (temporary)

- 用户真正的痛点不是「缺引擎功能」，而是**不清楚 myflow 相对成熟 harness 到底差在哪、
  哪些该补哪些不该补**，因此文档的可信度取决于「宿主已覆盖」这一列的准确性。
- Pi 指**当前运行本会话的运行时**，即已安装的 `@earendil-works/*` 1.2.0；**不是** `../pi` 源码
  工作区，**也不是**本仓库的 `.pi/` 资产。三者不可混用。
- 用户级第三方扩展（`~/.pi/agent/npm/node_modules/`、`~/.pi/agent/extensions/`、
  `~/.pi/agent/skills/`）算「宿主侧已有能力」，但**必须单独标注来源**（`A-EXT`），
  不得混同为 Pi core 或 myflow——否则 `CAP-SUB-*` 会被记到错误的层上。
- `../critic_doc/` 允许被创建与写入；它不在版本控制内，故每次交付需附**来源提交号**快照。

## Open Questions

- **Q1（已定，U-1）**：Pi 侧基准面 = **当前运行本会话的运行时**。对比因此是三层：

  | 层 | 对象 | 归属 |
  | --- | --- | --- |
  | L1 参照 | Norma（Go SDK，`../Norma`） | 外部，只读参考 |
  | L2 宿主 | **Pi 运行时 1.2.0** + 用户级扩展 | 上游，**不可修改**，只能依赖或规避 |
  | L3 自有 | myflow（本仓库 `.pi/` + `.myflow/`） | 用户拥有，可改 |

  判定规则：
  - **真缺口** = Norma 有 ∧ Pi 运行时没有 ∧ myflow 没有。
  - **已承担的关注点** = Norma 有 ∧ Pi 没有 ∧ myflow 有 → 转入**机制强度对比**（不是缺口，是质量差）。
  - **约束而非缺口** = 必须改 Pi 才能补 → myflow 补不了，只能规避或在文档中登记为上游依赖。
  - **非缺口** = Pi 已内建（或用户级扩展已提供，单独标注）。

- **Q2（已定 — U-4）**：交付粒度改为横评语境重排。骨架见 `design.md` §8.1。

- **Q3（已定 — 上一轮用户选定第 3 档）**：横评比对的**判定维度** = 功能清单 + 强制层级 +
  宿主契约风险 + 相对优势保护。决策记录见 `design.md` ADR-1。已取证的两类反例：
  - **名义有、实际靠约定**：`myflow-research` 的递归守卫是 agent md 里的**提示词文字**；
    Norma 的 `subagent` 是**代码**深度守卫。
  - **悄悄会坏**：`task.py` 用 `PI_SESSION_ID` 派生上下文键，`turn-cache.ts` 必须派生**完全相同**的键，
    而 Pi 的会话恢复/分支/压缩会改变会话语义，任务指针却存在被 gitignore 的 `.myflow/.runtime/` 里。
  - **注入会被压缩吃掉，全靠自身补偿（已取证）**：`custom_message` 既是合法压缩切割点又参与 LLM
    context → 压缩可摘要掉 `[workflow-state:*]`；兜底来自 myflow 自己的「每回合重注入 +
    压缩后按 `lastInjectionTs > lastCompactionTs` 重注入」。宿主一旦改切点规则或事件时序，
    myflow 会**静默**失去状态注入。

- **Q4（已定 — U-2）**：产出落点。research 分片留在任务目录（可追溯、受写范围代码约束），
  最终文档由主会话写入 `../critic_doc/`。

- **Q5（已定 — 新增，U-3）**：语料范围纳入 `noa/`、`noaadapter/`、`transcript/`，
  并在矩阵中新增 `NOA` / `NOAA` / `TRANS` 三个域。此法把 AC 从「覆盖 13 个包」改为
  **「覆盖 Norma 全部 16 个实现包（README 13 + noa + noaadapter + transcript）」**。

## Requirements (evolving)

- 产出可信的**能力矩阵**：行 = 能力项，列 = 〔Norma / Pi 运行时 / myflow〕，单元格须给
  **证据路径**（文件或文档，带行号）而非印象式判断。
- 对每个**真缺口**产出**补足标准**条目，格式统一，可直接作为后续任务的验收依据。
- 对每个**质量差**（myflow 有但强度弱于 Norma）产出**提升标准**条目。
- 明确标注**非缺口**及其理由（Pi 已提供 / 用户级扩展已提供 / Norma 特有但场景无关 /
  与「不做零依赖」的定位冲突）。
- 矩阵须给出每项的**归属域**（`A-PI` / `A-EXT` / `A-MF` / `A-MCP` / `A-NONE`）与
  **强制层级**（`E-C` 代码 / `E-G` 门控 / `E-P` 提示词 / `E-N` 无），并标注施加强制者。
- 必须包含**宿主契约风险**清单：myflow 假设了 Pi 的哪些行为、证据强度、假设不成立的后果、
  可用什么方式钉住。
- 必须包含**相对优势清单**：Norma 没有而 myflow 有的能力，标注为不可回退。
- 明确区分「已核实」与「推断」，不得把推断写成事实。
- **交付到 `../critic_doc/`**：README + 8 篇编号正文 + `evidence/` 快照，且快照注明来源提交号。
- 不修改任何实现代码、不运行开发生命周期（`task.py start` 之外无副作用操作）。

## Acceptance Criteria (evolving)

- [ ] 能力矩阵覆盖 Norma **全部 16 个实现包**（README 13 + `noa` + `noaadapter` + `transcript`），
      每项有 Norma 侧证据路径。
- [ ] `NOA` 域至少 9 个能力项（ref 寻址 / tier 分层 / block 与 rebuild / nudge 节律 /
      turn 完整性 / tool pair 完整性 / 硬保护 / 紧急截断 / 归档与 state 持久化），
      `NOAA` 域至少 5 个，`TRANS` 域至少 3 个。
- [ ] 矩阵每一行的 Pi 侧判定都指向 1.2.0 安装目录的具体文档或包 API，并注明所依据的版本。
- [ ] 每个缺口条目含：能力描述、Norma 机制与证据、Pi 现状、myflow 现状、补足标准（可验收）、
      依赖与代价、优先级、证据等级。
- [ ] 明确列出至少 3 项「看似缺口但实际不是」的条目及理由。
- [ ] 每个「有」的判定都附强制层级，且至少给出 2 个「名义有但仅靠提示词约定」的实证条目。
- [ ] 宿主契约风险清单至少覆盖：会话键派生（`PI_SESSION_ID`）、注入状态与压缩/分支的交互、
      `.myflow/.runtime/` 的机器本地性。
- [ ] 至少 3 项相对优势被明确标为不可回退。
- [ ] 全文区分已核实/推断，给出取证边界（哪些做了全量审计、哪些只是抽样），并集中列出所有
      负向断言的检索式（`NEG` 块）。
- [ ] `../critic_doc/` 下 README + 8 篇正文 + `evidence/` 全部存在，编号与 `design.md` §8.1 一致，
      `evidence/` 内含来源提交号（本仓库 HEAD 与 Norma HEAD）。
- [ ] 输出以中文撰写，术语保留英文原名以便对照。

## Definition of Done (team quality bar)

- 文档中的每条关键断言都能回溯到具体文件路径（Norma 侧、Pi 侧、myflow 侧各一）。
- 版本敏感处显式标注 Pi `1.2.0`，并说明 `Desktop/pi` 源码为 `1.0.4`、不作为权威依据。
- 不引入实现改动；`git status` 除 `.myflow/tasks/norma-benchmark-gap-analysis/` 外无新增变更，
  `../critic_doc/` 在仓库之外故不影响工作树。
- 结论可被后续任务直接消费（缺口条目须能一对一转成实现任务）。
- 注入预算有实测算术，且实际注入未触发 `[myflow: context limit reached …]`。

## Out of Scope (explicit)

- 不实现任何缺口（仅分析交付）。缺口→实现将拆成**每 `GAP-*` 一个后续任务**，在本任务评审通过后创建。
- 不以「达到 Norma 的功能对齐」或「零依赖」为目标；不评估 Go 与 TypeScript 生态差异的优劣。
- 不重构 myflow harness，不迁移目录，不改 `.pi/` 资产。
- 不审计 Norma 与 Pi 的性能、安全模型与代码质量的完整对标（仅在影响能力判定时提及）。
- 不覆盖 `../pi`、`../agent` 等外部仓库的改造建议；不评估 `../Norma` 自身的改进空间。
- 不写 `.myflow/spec/`（见 `design.md` ADR-4）；可沉淀结论在 `coverage.md` 列出候选清单。

## Technical Notes

- 已核实路径：`Norma/README.md`、`Norma/` 目录树与 `*.go` 逐目录行数统计（含 `noa`/`noaadapter`/
  `transcript`）；`Desktop/pi/packages/coding-agent/package.json`（1.0.4）；
  `~/.bun/install/global/node_modules/@earendil-works/*/package.json`（1.2.0）及 `pi-coding-agent/docs/`；
  本仓库 `.pi/`、`.myflow/`、`tests/` 清单；`.myflow/tasks/explain-myflow-directory/prd.md`。
- 已抽读的 Norma 源码（供分片取证时对照，均为抽样而非全量）：`noa/pipeline.go`、`noa/refs.go`、
  `noa/tier.go`、`noa/nudge.go`、`noa/boundaries.go`、`noa/turnintegrity.go`、`noa/toolpairs.go`、
  `noa/protected.go`、`noa/state.go`、`noa/archive.go`、`noaadapter/noa.go`、`noaadapter/compactor.go`、
  `noaadapter/overflow.go`、`noaadapter/deadrange.go`、`noaadapter/identity.go`、`noaadapter/inherit.go`、
  `noaadapter/materialize.go`、`noaadapter/tags.go`、`noaadapter/state_store.go`、`noaadapter/session.go`、
  `noaadapter/tool_compress.go`、`transcript/transcript.go`。
- 取证方式约束：`myflow-research` 子代理仅有 `read, write, find, grep, ls`，无 bash/MCP；
  主会话可用 MCP 图检索，但不得把主会话的图访问能力计入子代理能力。
- 预算：`prd.md` + `design.md` + `implement.md` 三者都会被自动注入（P0-3 已落地），
  故 jsonl 可用的余量 = 131072 − 三者字节数。**实测三者合计 65,161 B（≈63.6 KiB）**，
  即每次 dispatch 的 jsonl 余量 ≈ 64.4 KiB。
- **分片尺寸与策展实际（偏离原计划，已实测修正两次）**：原计划要求「每个分片 ≤ 6 KiB」，
  实际 12 个分片落在 **6.6–17.7 KiB**，jsonl 策展因此从「implement 5 / check 8」改为「**6 / 7**」。
  第一版算术（120,099 / 123,573）**漏算了 wrapper + 每文件 header 开销（约 1 KB）且未随 B5 增长重算**；
  P3 用「含 wrapper/header 的全量注入实算」复核，得 `implement.jsonl` = **126,081 B（slack 4,991）**，
  `check.jsonl` 原 7 条 = **131,137 B > 131,072 → 触发 1 条 `omitted`**（`norma-plan-mem.md`），
  已移除该条使其降到 **121,514 B（slack 9,558）**。
  **教训**：同类任务应在 dispatch prompt 给定**字节上限**，并用「含开销的全量注入实算」而非
  「引用文件字节和」定稿，且在**每次分片改动后**重算。完整记录见 `08-coverage.md` 的 `DV-1`/`DV-7`。
- 已取证的反向对照（用于强制层级论证）：`.pi/extensions/myflow/subagent.ts` 中
  `mode === "parallel"` + 写者但无 `writesUnder` → **抛错拒绝**；`MAX_PARALLEL_PROMPTS` 上限；
  `timeoutMs` 默认 15 分钟并落日志——这些是**代码强制**，在这几项上 myflow 不弱于 Norma。
- 归属域必须细分：工具列表里的 `Agent` / `StopAgent` / `MessageAgent` / `AgentStatus` 由用户级扩展
  `pi-subagents-lite` 注册（`A-EXT`），**不是** Pi core；`myflow_subagent` 由 `A-MF` 注册。
- 文档栈（复杂档）：`prd.md` + `design.md`（判定法、归属分类、证据规则、交付骨架）+
  `implement.md`（审计执行顺序与分片）。进入 `task.py start` 前须经用户评审。
- 本任务由用户明确授权创建；当前状态 `planning`，尚未批准执行 P0/P1。
