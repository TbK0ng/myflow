# brainstorm: plan 阶段的提问与批准门

## Goal

让 myflow 的**规划阶段**变成有门的交互：每次制定 plan 时，**先用选择题向用户提问**，
**用户答完再给出 plan**，并且**只有用户明确批准 plan 之后**才允许继续（进入执行）。

用户原话（本任务授权来源，逐字保留）：

> 我的myflow需要修改：每次制定plan时候需要向我提问选择性问题并在我回答后提供plan，在我同意plan后才能继续

## What I already know

### 用户意图
- 三个动作**有序**：提问 → （答）→ 出 plan → （批准）→ 才能继续。
- 「选择性提问」= 给选项让用户选，不是开放式的「你有什么要求」。
- 「继续」的落点是 myflow 的规划→执行转换，即 `task.py start`。

### myflow 现状（E3，已核实）
- 规划阶段由 `.pi/skills/myflow-brainstorm/SKILL.md` 承担，其原文要求「一次问一个问题」、
  「为每个问题给出推荐答案」——但这是**提示词约定（`E-P`）**，没有任何代码拦住
  「一个问题都不问就直接出 plan」或「用户没批准就 `task.py start`」。
- `task.py start` 目前只检查一件事：`implement.jsonl`/`check.jsonl` 是否有 curated 条目
  （空上下文门禁，`task.py:496-512`），**不检查是否问过问题、是否获批准**。
- `.pi/extensions/myflow/` 9 个 TS 文件里**从未调用** `ctx.ui.*`（全仓 + 全 A-EXT 检索确认）。

### Pi 能力（E1/E2，本回合新取证 —— 这改变了「要不要自己造」的结论）
- **Pi 提供交互式问答 API**：`ExtensionContext.ui`
  （`.pi/extensions/myflow/pi-coding-agent.d.ts:22-27`）：
  - `confirm(title, message): Promise<boolean>` —— 是/否
  - `select(title, options: string[]): Promise<string | undefined>` —— **单选列表**
  - `notify(message, type)` —— 通知
- **Pi 官方文档就是拿它做审批拦截的**（`docs/extensions.md:175`）：
  `if (needsApproval && !(await ctx.ui.confirm("Allow tool call?", event.toolName))) { ... }`
  → 在 `tool_call` 钩子里阻断该次调用。这正是 Norma `CanUseTool` 的等价物。
- `ctx.ui` 之外还有 `ctx.hasUI` 与 `ctx.mode: "tui" | "rpc" | "json" | "print"`
  （`.d.ts:14-15`）→ **非 TUI 模式（`print`/`json`/`rpc`）多半没有可交互 UI**，
  这是「有选项但可能问不出来」的硬边界，必须设计降级路径。
- **已有先例**：`A-EXT` 的 `pi-mcp-adapter` 自带 `tool-approval.ts` 与
  `elicitation-handler.ts`，已经在用 `ctx.ui.confirm` 做工具审批
  （`~/.pi/agent/npm/node_modules/pi-mcp-adapter/tool-approval.ts:198` 用 `ui.select`）；
 Pi 随包还带 `examples/extensions/confirm-destructive.ts` 与 `permission-gate.ts` 两个官方范本。
  → 机制在本机已被验证可用；同时意味着**可能出现两处审批互相干扰**，设计时须考虑。

### 工具处理器能不能弹对话框（**决定 Q2 的关键取证**）
- **能**。工具定义里 `execute` 的第 5 个参数就是 `ctx`：
  `execute: async (id, params, signal, onUpdate, _ctx) => {...}`
  （Pi 随包示例 `examples/extensions/bash-spawn-hook.ts:26`）。
- 斜杠命令的 `handler: async (args, ctx) => {...}` 也拿 `ctx`
  （`examples/extensions/bookmark.ts:15,24`，其中直接调 `ctx.ui.notify`）。
- ⇒ **myflow 可以注册一个「提问工具」**：模型调用 → 处理器 `await ctx.ui.select(...)` 弹出选项列表
  → 答案作为工具结果返回给模型 → **不结束回合**即可继续。
  这正是 Norma `AskUserQuestion` 的语义，且用 Pi 原生 API 实现。
- **限制（必须写进设计）**：Pi 的 `select` 签名是 `options: string[]` —— **只有单选**，
  无 `multiSelect`、无 per-option description（Norma 的 Option 有 `Label + Description`）。
  ⇒ 「选择性提问」在本机只能做到「单行文本选项的单选」，多选/选项说明需自己拼进字符串。

### Norma 的等价物（E4，参照，不要求对齐）
- `AskUserQuestion`（`../Norma/tool/ask.go`）：结构化多选提问，**不结束回合**即拿到答案；
  由 Pi 提供 `AskUserFunc` 回调决定 UI（CLI / GUI / 网页表单）。
- plan 模式：只读探索 → `ExitPlanMode` 交出计划待批准 → **权限模式中途翻转**开始实现。
- `permission.CanUseTool`：逐调用审批。

### `/loop` 已排除（本回合取证，不再作为问题）
`pi-agent-loop`（`A-EXT`，1.0.1）的 `/loop goal|passes|pipeline` 是**前台自动重复会话回合**
（同一会话被占用，`Ctrl+Shift+X` 中止），**不是后台进程并发**，也没有「进程」概念。
与本任务的「提问 + 批准门」无关，`myflow` 也从未使用它。**不纳入本任务。**

## Assumptions (temporary)

- 用户说的「plan」= myflow 规划阶段的产物（`prd.md` / `design.md` / `implement.md`），
  而不是执行期每一步的临时计划。**Q1 已确认。**
- 「继续」= 执行阶段的开端（派 `myflow-implement`），门挂在 `task.py start`。
- 用户希望**结构化选择**（Pi 的 `ctx.ui.select`）而不只是散文式提问，因为他说的是「选择性提问」。

## Open Questions

### Q1（已定 — 用户选 **1**）门卡在哪个转换点
**只卡 Phase 1 → Phase 2 一次**：规划期必须先问完选择题，出 plan 后必须用户批准，
`task.py start` 才放行。进入执行后不再逐动作打断。
- 理由：用户原话直译；且「逐调用审批」属横评已登记的 `PERM` 域（5 条 `GAP-PERM-*`），
  是独立任务，混进来会把范围撑大。
- **后果**：本任务**不改**执行期行为，只改「规划 → 执行」这一个转换点。

### Q2（已定 — 用户选 **1**）提问用什么机制
**新增一个 myflow 提问工具**：模型调用 → 处理器 `await ctx.ui.select(...)` 弹选项列表 →
答案作为工具结果回模型（**不结束回合**）。非 TUI 模式（`print`/`json`/`rpc`）自动降级为
散文编号选项。
- 理由：这是唯一能让「选择性提问」成为**真机制**而非文字约定的选项；且选 2 等于把现有提示词
  约定换个写法，选 3 则把「先问后给 plan」这半个需求放掉。
- **已知限制（必须在设计与实现里处理）**：`select` 只有 `options: string[]` ——
  **仅单选、无 per-option 描述**。多选/选项说明需自拼进选项字符串，或拆成多轮问答。
- **后果**：本任务增加一个模型可见工具（需同步到 `.pi/agents/*.md` 的 `tools:` 白名单
  与 `myflow-meta` 的工具清单，否则契约漂移）。

### Q3（已定 — 用户选 **1**）「已批准」怎么记录并强制
**任务目录写 `approval.json`**（批准时间 / 会话 id / plan 内容哈希），`task.py start`
校验其存在**且哈希匹配当前 plan**。
- 理由：批准是**用户的决定记录**，不是任务生命周期元数据（`task.json` 由 `start`/`archive` 重写，
  不混入审批负载）；哈希绑定才能让「同意 plan 后才能继续」成立（否则批准 v1、执行 v2）；
  删文件即撤销。
- 已接受代价：批准后任何 plan 改动（哪怕改错别字）都使批准失效，必须重新批准。
- 哈希覆盖面（用户未反对，采用默认）：`prd.md` + `design.md` + `implement.md` 的**内容**
  （不存在的文件不算），按字节内容哈希，不看修改时间。

### Q4（已自行排除，不提问）
`/loop` 与本需求无关（见上）。

## Requirements (evolving)

- 规划阶段必须**先提问后给 plan**，且问题为**选择题**形式。
- 用户答完后才产出 plan。
- 用户**明确批准**前，不得进入执行。
- 门必须**可被代码强制**（不接受纯提示词约定），并有回退即红的测试。
- 非 TUI 模式（`print`/`json`/`rpc`）必须有明确降级行为，不得静默跳过提问与批准。
- **不得引入第二份哈希实现**（两侧各写一份 = 横评已点名的 `RISK-01` 漂移陷阱），
  plan 哈希只能有一个实现源。
- **不得因本次改动削弱 `ADV-01`**（`writesUnder` 路径级 fail-closed 写范围门）。

## Acceptance Criteria (evolving)

- [ ] 在 TUI 下开始一个复杂任务时，模型先弹出选择题（不是直接写 plan）。
- [ ] **没问过任何问题就请求批准** → 拒绝（`questions.jsonl` 无已作答记录）。
- [ ] 未获批准时 `task.py start` 以非零退出并给出可操作提示。
- [ ] 批准记录与**当前 plan 内容**绑定：plan 被改动后旧批准失效（哈希不匹配）。
- [ ] 非 TUI 模式下行为明确（降级或拒绝），**不得伪造同意**，且有测试锁定。
- [ ] 子代理**不能**调用这两个新工具（`tool_call` 拦下）。
- [ ] plan 哈希只有**一份实现**（Python 侧），TS 不重复实现。
- [ ] 回退该门即测试变红。

## Definition of Done (team quality bar)

- 契约变更同步更新 `.myflow/spec/harness/index.md`、`.myflow/workflow.md` 与所有规则副本
  （`myflow-brainstorm` 技能、`myflow-meta` 的 conventions 文档）。
- `node --test tests/` 全绿（主会话直跑，或清空 `MYFLOW_*`）。
- 不削弱既有 `ADV-01`（`writesUnder` 路径级 fail-closed 写范围门）。

## Out of Scope (explicit)

- 不实现 Norma 式的**逐调用权限系统**（`PERM` 域 5 条 `GAP-*` 是独立任务）。
- 不实现**多选**提问与 per-option 描述（受 Pi `select` 签名限制；降级方式见 Q2 限制）。
- 不引入 `/loop`。
- 不动横评已交付的 `critic_doc/`。
- 不改执行期的任何行为（Q1 已定为只卡规划→执行一次）。

## Technical Notes

- 已核实路径：`.pi/skills/myflow-brainstorm/SKILL.md`、`.pi/extensions/myflow/pi-coding-agent.d.ts:14-27`、
  `.pi/extensions/myflow/index.ts`、`.myflow/scripts/task.py:478-521`、
  `docs/extensions.md:175,247-248`、`../Norma/tool/ask.go`、
  `~/.pi/agent/npm/node_modules/pi-mcp-adapter/tool-approval.ts`。
- 待核实（进 planning 后需读）：`.pi/extensions/myflow/index.ts` 的 `tool_call` 钩子现有拦截点、
  `tests/` 里现有的门禁测试写法（`task-gate.test.ts`、`workflow-invariant.test.ts`）。
- 任务创建：`.myflow/tasks/plan-approval-gate`（`implement.jsonl` / `check.jsonl` 由 `create` 播种为空，
  Step 1.3 前必须 curate，否则 `start` 会拒绝）。
- 本文件由 `myflow-brainstorm` 流程增量维护；每个问题答完即更新。
