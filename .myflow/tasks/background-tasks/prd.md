# brainstorm: 真后台长任务能力

## Goal

给 myflow 加**真后台长任务**：起一个进程后**立刻返回**，之后能**异步读增量输出**、**列出**、**停止**。
用户要求**完整全面**（不是最小可用），且**每个功能点写完测试后再提交**（一次提交 = 一个功能点）。

用户原话（授权来源，逐字保留）：

> 2，如果/loop合适就在其基础上进行拓展，如果不合适就从零开始进行完整全面的实现，每个小功能点需要编写测试后提交

## What I already know

### `/loop` 是否可作基座 —— **判定：不可以，从零实现**（源码级取证）

`pi-agent-loop` 0.1.1（`~/.pi/agent/npm/node_modules/pi-agent-loop/`，180+157+173 行）：

| # | 证据 | 为什么不能扩展 |
| --- | --- | --- |
| 1 | 推进会话的方式是 `setTimeout(() => pi.sendMessage({customType:"loop-iteration",…}, {triggerTurn:true, deliverAs:"steer"}), 100)`（`tool.ts:78-86`） | 它是在**同一条会话里触发下一轮**。后台任务要的是「起进程、立刻返回、之后异步读输出」。一个是会话内的回合链，一个是进程生命周期 —— 要换的是核心机制，不是扩展 |
| 2 | 状态活在会话分支里并在 `session_switch` / `session_fork` / `session_tree` 时重建（`index.ts:36-48`） | 后台任务必须**活过会话**（关掉会话它还在跑）。两者对「状态存哪、活多久」的前提相反 |
| 3 | 控制面只有 `loop_control(status: next\|done)`（`tool.ts:105-124`） | 它是**进度信号器**，不是**任务管理器**。后台需要 spawn / list / output / stop |
| 4 | 它是用户级 `A-EXT`（publisher 非 `@earendil-works`） | 把 myflow 核心能力建在别人包的内部机制上 = 引入未拥有的依赖。myflow 既有做法是自己拥有扩展层（`subagent.ts` 等） |
| 5 | `await ctx.waitForIdle()`（`index.ts:127`）后 `sendUserMessage` 启动 | 它刻意与「会话空闲/忙」模型协作 —— 恰是「不脱离会话」的设计 |

**可借鉴、不可复用**：`waitForIdle` 的启动时机、状态可观测（widget）、以及「不该自动后台化 `sleep`」这类防呆（见下 Norma）。

**结论**：`/loop` 解决的是「无人值守反复跑」，与「并发独立进程」**正交**。本任务不改它、不依赖它。

### 宿主能力与边界（已取证）
- **扩展跑在 Pi 进程内、拥有同等 OS 权限**（`docs/extensions.md:5`）→ 可用 `node:child_process`。
- **不得在工厂函数里起进程/定时器**（`docs/extensions.md:58`）；**会话级资源必须在 `session_shutdown` 释放，且必须幂等**（`:60`、`:265-266`）；`ctx.shutdown()` 可请求有序退出（`:267`）。
- 现有 `bash` 工具（由 `A-EXT:pi-rounded-tools` 注册）schema 只有 `command` + `timeout`，**没有** `run_in_background`；且它是**别人的包**，不该改。
- ⇒ 工具必须由 **myflow 自己注册**（`A-MF`），与 `myflow_subagent` / `myflow_ask_user` 一致。

### myflow 既有约定（必须沿用以保持一致）
- 机器运行态一律放 `.myflow/.runtime/`（已被 gitignore）：现有 `sessions/`、`subagent-logs/`、`worktrees.json`、`worktree-logs/`
  （`task.py:73`、`get_context.py:116`、`worktree.py:27-28,61`、`subagent.ts:67`）。
- 工具命名前缀 `myflow_`；注册形态走**依赖注入**（`registerX(pi, registration)`），**不 import `index.ts`**（避免循环依赖，`subagent.ts` 范式）。
- 每个门/能力都要有「回退即红」的测试；测试须清空 `MYFLOW_*` 跑。

### Norma 的参照功能集（横评已登记为缺口，E4）
`run_in_background`（bash 参数）+ 四件套 `TaskOutput` / `TaskStop` / `TaskList` / `Monitor` + `sleep`；
`tool/task.go` 有 **per-session 任务目录 + 陈旧任务 GC**（`:169`）；
`tool/bash.go:27-29` 有 **`disallowedAutoBackground = ["sleep"]`**（绝不静默把 `sleep` 转后台）。
另有 `Monitor`：专门起**流式**进程（`tail -f`、dev server、watch）并立刻返回任务 id + 输出文件路径（`monitor.go:15-16`）。

## Assumptions (temporary)

- 「完整全面」= 覆盖 `run_in_background` 式的起后台、读输出、停止、列表、（可能）流式监视与 `sleep` 配套。
- 用户痛点是 `/loop` 那种「会话一走就停」，所以**任务必须能活过会话**才叫「真后台」。
- 本任务属于**新功能**，不是修 bug；不需要与 Norma 逐项对齐，但可参照其功能集。

## Open Questions

### Q1（已定 — 用户选 **1**）后台任务的生命周期归谁
**项目级**：注册表与日志放 `.myflow/.runtime/`，任务**活过会话**（新会话能 list / output / stop）；
`session_shutdown` **不杀任务**，而是列出「本会话起的、仍在跑」的任务并提示。
- 理由：用户痛点是 `/loop` 那种「会话一走就停」，选会话级等于放弃本任务的核心目标；
  项目级注册表会积累，不提示的话残留进程会变成「不知道谁起的、还在占端口」。
- 比 Norma 更进一步：Norma 是 per-session 任务目录 + 陈旧任务 GC（`tool/task.go:169`），
  本项目级 + 提示 + **pid 存活检测**（pid 死了就把状态自愈成 exited）。

### Q2（已定 — 用户选 **2**）命令执行的确认门
**起后台前必须 `ctx.ui.confirm` 显示即将执行的命令**；**无 UI 时可显式放行，但必须留痕**。
- 留痕的含义（写进设计的硬要求）：注册表条目记录 **`confirmed_by`**（`ui-confirm` | `no-ui-explicit`），
  且工具结果里**显式回显**「本次未经用户确认」；**不得**把它当成正常路径。
- 理由：后台任务比前台 `bash` 更危险——前台你有 `Ctrl-C`，后台没有，且它活过会话；
  用一句显式「是」替代失去的安全网。选 2 而非 1 是为了保留无 UI 环境的可用性（用户决定）。
- 为什么**不**提供「只对危险命令确认」：那靠模式匹配判危险，而横评已点名「靠匹配/约定的门会静默失效」。
  宁可每次问，不要假装问。

### Q3（已定 — 用户选 **1**）输出读取语义
**增量 + 尾部都给**，游标**按会话分开**（用现有 `deriveContextKey` 作键），互不吞掉对方已读字节。
- 覆盖两种真实用法：跟长任务看进展（delta）与只看当前状态（tail）。
- 游标按会话分开几乎零成本（`deriveContextKey` 已存在，就是 plan 门用的那套）；
  选全局单游标会在「后台任务活过会话」这个核心场景上出错（新会话 tail 之后回旧会话读增量为空）。
- 代价：每会话多一个小游标文件（放 `.myflow/.runtime/`，已被 gitignore）；
  游标丢失最坏是**重读一遍**，不会漏。

### Q4（已自行判定，非提问）子代理能不能用后台任务工具
**不能。** 与 `myflow_ask_user` / `myflow_request_approval` 同款：子代理无 UI（只能走 `unattended` 绕过确认）、
且它们会在共享的项目级注册表里留东西。主会话专用：两个白名单不含它们 + `tool_call` 二次拦截。
（若你不同意，评审时说一句即可改。）

## Requirements (evolving)

- 起后台任务后**立刻返回**（不阻塞会话），返回可寻址的**任务 id**。
- 能**异步读取**该任务的输出（含「还在跑 / 已退出 / 退出码」状态）。
- 能**列出**任务、能**停止**任务。
- 任务状态与输出可**跨会话**存活（Q1 已定：项目级）。
- `session_shutdown` **不杀任务**，但必须**幂等释放本会话自己的句柄/定时器**，并列出本会话起的、仍在跑的任务。
- **不得**在扩展工厂里起进程；`session_shutdown` 必须幂等释放本会话持有的资源。
- 每个功能点**自带测试**，并且**单独一次提交**（用户的硬要求）。

## Acceptance Criteria (evolving)

- [ ] 起一个长跑命令 → 工具**立刻**返回任务 id（用可测的时间上界断言，不是「看起来很快」）。
- [ ] 该任务在**会话结束后仍在跑**（依 Q1）且新会话能读到它。
- [ ] 读输出能看到**增量**（依 Q3），且已退出任务能给出退出码。
- [ ] `stop` 能真正杀死进程树（Windows 上要覆盖 —— 这是本机平台）。
- [ ] `list` 能列出、且能区分「运行中 / 已退出 / 已停止」。
- [ ] 每个功能点有一个「删掉该实现即变红」的测试。
- [ ] 不破坏既有 254 条测试；不引入第二个 `bash` 工具。

## Definition of Done (team quality bar)

- 契约变更同步：`.myflow/spec/harness/index.md`（新契约条目 + Checklist）、
  `.myflow/workflow.md` 若涉及、`myflow-meta` 的工具清单与 conventions。
- `env -u MYFLOW_AGENT_TYPE … node --test tests/` 全绿。
- 不削弱既有优势：`writesUnder` 路径级 fail-closed 写范围门、子代理守卫、plan 批准门。
- 逐功能点提交，每个提交自带测试。

## Out of Scope (explicit)

- 不改 `/loop`、不依赖 `pi-agent-loop`。
- 不改 `pi-rounded-tools` 的 `bash`（别人的包，属用户级 `A-EXT`）。
- 不实现 Norma 式的**逐调用权限系统**（横评 `GAP-PERM-*`，独立任务）。
- 不做「会话并发的后台 agent」（即后台跑一个 `pi` 子进程继续用工具）—— 除非后续单列；本任务的后台是**进程级**。
- 不动已交付的 `../critic_doc/`。

## Technical Notes

- 取证路径：`~/.pi/agent/npm/node_modules/pi-agent-loop/{index,tool,state}.ts`；
  `docs/extensions.md:5,58,60,265-267`；`../Norma/tool/{task,monitor,bash}.go`；
  `.myflow/scripts/{task,get_context,worktree}.py`；`.pi/extensions/myflow/subagent.ts:67`。
- **已实测（本回合，Windows + Git Bash，全部真跑）**：
  1. ✅ **`spawn({detached:true, stdio:"ignore"}).unref()` 在 Windows 上真能留下子进程**：父进程 0.228s 退出，
     2 秒后子进程（pid 仍在）继续写日志，日志 71B → 162B。→ 项目级存活可行。
  2. ✅ **追加写对后续读取可见**：同一文件在另一次进程读取时能看到新增字节（无需 fsync）。→ 增量读取可行。
  3. ✅ **`taskkill /F /T /PID <pid>` 能杀进程树**（从 Node 用参数数组调）：exit 0，
     报告杀掉 3 个 PID，root 与孙进程全部消失，心跳冻结。→ 定为 Windows 的 stop 实现。
  4. ⚠️ **`process.kill(pid)` 在本测试里“也”杀了孙进程** —— 但测试的后代是 **Node/libuv 生的**（Windows 上
     libuv 会给子进程建 job object），**真实任务的 `cmd`/`bash` 后代链未被覆盖**。
     ⇒ **不得依赖它**；`/T` 才是依据。（此条是「实测否定了我的预设」的记录）
  5. ⚠️ **陷阱（现场撞上）**：在 Git Bash 里直接写 `taskkill /F /T /PID` 会被 MSYS 路径转换把 `/F` 改成 `F:/`
     而报「无效参数」。**必须从 Node 用参数数组调用**（生产环境本就如此），且测试不得经 Git Bash 转发。
- 待核实（进设计期再确认）：pid 存活检测在**跨会话**读取时对「pid 已被系统重用」的误判风险（低，但要写清）。
- 本文件由 `myflow-brainstorm` 增量维护；每个问题答完即更新。
