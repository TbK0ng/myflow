# mysubagents board

## Goal

`myflow_subagent` 派发出去后，用户没有任何办法知道"现在有哪些 run 在跑、谁在编排谁、某次 run 到底说了什么"——只有散落的
`.myflow/.runtime/subagent-logs/<agent>-<ts>.log` 文件。同时已经实现的 detached 后台任务
（`.myflow/.runtime/background/`，终端退出仍在跑）只能靠 `myflow_bg_list` 一条条读，没有可视化。

本任务给 myflow 加一个 `/mysubagents` 命令：一个三视图的 TUI 面板——
**board（只读总览）／tree（编排树，可管理）／background（后台任务，可管理）**，
让前台 subagent run 与后台 detached 任务在同一处用不同颜色区分地看见，并能对 tree/background
执行停止、steer、重跑、整组取消。

## Requirements

### R1 `/mysubagents` 命令入口

* `pi.registerCommand("mysubagents")`，由 myflow 扩展注册（与 `/myflow-status` 同级）。
* 无参数 → 打开菜单：`board` / `tree` / `background`，每项带一行说明与当前条目数。
* `/mysubagents board|tree|background` → 直接进对应视图。
* 仅 TUI 可用；非交互模式（`ctx.mode !== "tui"`）退化为文本报告 + `ctx.ui.notify`，不报错。
* Esc / `q` 关闭，回到会话。

### R2 前台 subagent run 的元数据注册表

新增 `.myflow/.runtime/subagents/<runId>.json`，由派发方（`subagent.ts`）在 run 开始、状态变化、
结束时写入。字段：`runId`、`group`（一次派发调用 = 一个组）、`index`/`total`、`agent`、`mode`
（single/parallel/chain）、`prompt`、`status`（queued/running/done/failed/timeout/stopped）、
`startedAt`/`endedAt`、`pid`、`owner`（父会话 contextKey + pid）、`logPath`、`task`、
`model`、`steers[]`、`heartbeatAt`。

* 读侧据此判定 `stale`：`status === "running"` 且 `heartbeatAt` 超过阈值未更新 → 显示为 `stale`，
  提示"派发会话已消失"。读侧不探测进程，避免每次渲染 spawn 一次 `tasklist`。
* 保留现有日志文件路径不变（日志仍是唯一原文来源）。

### R3 前台 run 传输层切换到 rpc（配合 steer）

子进程从 `pi --mode json -p --no-session --approve` 改为 `pi --mode rpc --no-session --approve`，
stdin 保持打开：

* 首个 stdin 记录是 `{"id","type":"prompt","message"}`；`disposition` 必须为 `started|queued`。
* 完成判定从"进程退出"改为 **`agent_settled` 事件**；随后关闭 stdin 请求有序退出，5s 未退则
  `killChildTree`；进程意外退出也视为 settle（失败路径）。
* 超时：先发 `abort`，5s 未 settle 再 kill，状态记 `timeout`。
* `exitCode` 降级为参考信息；失败判定继续依赖 `stopReason` / `errorMessage`（现有 `isFailedResult`）。
* 现有 JSONL 事件解析、日志落盘、`MYFLOW_*` 环境变量、`writesUnder` 围栏、
  `--append-system-prompt`/`--tools`/`--model` 参数全部保持不变。

### R4 控制通道（跨会话可管理）

新增 `.myflow/.runtime/subagents/<runId>.ctl.jsonl`（append-only，一行一条命令）：

* `{"type":"steer","message":...}` → 派发方转发为子进程 stdin 的 `{"type":"steer",...}`，
  并追加到注册表 `steers[]`。
* `{"type":"abort"}` → 派发方发 `abort`，5s 未 settle 再 kill，状态 `stopped`。
* 派发方在 run 期间以 1s 间隔轮询 ctl 文件并刷新 `heartbeatAt`；settle 后删除 ctl 文件。
* 控制命令只能由看板追加，任何会话都可以（注册表是项目级的，这正是前台 run 被阻塞时
  仍能管理的唯一途径）。解析必须容忍半行/坏行（跳过，不抛）。

### R5 board 视图（只读）

上下两区，颜色区分：

* 前台 subagent run（accent 色）：runId 短码、agent、mode+组内序号、已运行时长、状态字形、
  日志最后一行。
* 后台 detached 任务（warning 色）：id、命令首行、状态 running/exited、退出码、已运行时长；
  明确标注"终端退出仍在跑"。
* 选中任意行（Enter）→ 只读会话查看器：前台 run 渲染日志 JSONL 为可读 transcript
  （assistant 文本、thinking 折为 dim 单行、tool call 一行、tool 结果截断）；
  后台任务渲染输出尾部（复用现有 cursor 读逻辑，只读、不推进 cursor）。
* board 不提供任何修改操作。

### R6 tree 视图（可管理）

* 按 group 分组的编排树：组头（mode、agent、n 个 run、整组耗时、聚合状态）+ 成员 run（`1/3` 序号、状态、耗时）。
* 关键操作：`x` 停止选中 run（`killChildTree` + 状态 `stopped`）；`X` 取消整组（组内所有 running run）；
  `s` steer（输入一行消息 → 追加 ctl）；`r` 重跑选中 run（复用注册表里的 agent + prompt 重新派发）。
* 重跑产生新的 runId 与 group，不覆盖原条目。

### R7 background 视图（可管理）

* 列出 `.myflow/.runtime/background/` 注册表全部条目（含已退出）。
* 关键操作：`x` 停止（复用现有 stop 逻辑）；`c` 清理已完成条目（复用 prune）；`r` 重跑（复用 start 逻辑重放存储的 command）；Enter 查看输出尾部。

### R8 不改动的东西

* 不引入新依赖；不修改 `pi-subagents-lite`（无 env 注入点，不进这条链路）。
* 不新增"后台 agent"：`myflow_subagent` 仍全部前台（后台指的是已有的 detached shell 任务）。
* `.pi/agents/myflow-*.md` 的 `hidden: true`（避免 lite 的 `Agent` 类型列表误选）**不**在本任务内。

## Acceptance Criteria

* [x] `/mysubagents` 在 TUI 下打开菜单，三视图均可进入并 Esc 退出；非 TUI 模式输出文本报告不抛错。
      （TUI 部分由 `mountPanel` 以字面按键驱动测试覆盖；**真机人眼未验**，手验步骤见 check 报告。）
* [x] 一次 `mode: parallel` 派发在 board 里显示为 1 个组 + n 个 run，颜色为 accent；同时打印的后台任务显示为 warning 色且标注 detached。
* [x] 运行中 run 在 board 里可见，结束时状态从 running → done/failed/timeout/stopped。
* [x] 父进程被杀后，条目在阈值后显示 `stale`，不永久停在 running。
* [x] tree 里 `x` 能真正杀掉子进程树（子进程与其 MCP 子进程都不残留）；`X` 取消整组。
      （假 pi 脚本验过进程树死亡；真实孤儿 pid 未实测。）
* [x] tree 里 `s` 写入的 steer 在子进程日志里表现为新的 assistant turn（同一个 runId，不新建 run）。
      （真实 pi 1.4.0 端到端冒烟：turns 1→2、steer 文本入库。）
* [x] 从第二个 pi 会话打开 board，能看到并 steer 第一个会话正在跑的 run。
      （机制已证：注册表与 ctl 均为项目级文件，真实 steer 通；两终端同开未人验。）
* [x] background 视图 `x`/`c`/`r` 分别等价于现有 `myflow_bg_stop`/prune/`myflow_bg_start`。
* [x] 现有 `tests/subagent.test.ts` 在 rpc 传输下全部通过（或按新语义等价改写并有注释说明）。
* [x] 超时路径仍产出可读日志文件并在结果里报告日志路径。
* [x] 新模块中 `runs.ts` / `ctl.ts` / `transcript.ts` / 各视图 render 函数可在 `node --test` 下导入（不硬依赖 pi-tui）。
* [x] `tests/doc-numbers.test.ts`、`tests/scaffold.test.ts`、`tests/release.test.ts` 仍通过（新增文件落在 payload 的 `.pi/extensions/myflow` 树内）。

## Definition of Done

* 单测覆盖：注册表读写/分组/stale、ctl 追加与坏行容忍、transcript 渲染、三视图渲染（纯函数 + 假 theme）、rpc 传输（假 `pi` 脚本）。
* `npm run typecheck`（若存在）/ `node --test` 全绿。
* 文档更新：`.pi/skills/myflow-meta/SKILL.md` 的 Layout 增加 `board/`，`.myflow/workflow.md` 提及 `/mysubagents`。
* 无新增运行时依赖；`subagent.ts` 仍保持"运行期只 import node 内置模块"。

## Technical Approach

见 [`design.md`](design.md)。要点：注册表 + 控制文件两条 node-only 通道；子进程 rpc 传输；
视图层用"纯 render 函数 + 注入 theme/truncate"实现，`@earendil-works/pi-tui` 只在命令执行时动态导入。

## Decision (ADR-lite)

**Context**: 看板要能"管理"，就必须在 run 运行中向子进程发消息；一次性 `-p --mode json` 没有输入通道。
**Decision**: 全部 run 统一切到 `pi --mode rpc`（用户已确认 A 方案），完成判定改为 `agent_settled`，跨会话控制走 ctl 文件队列。
**Consequences**: 单条派发链路更统一、steer 随时可用；代价是完成/超时/失败判定全部重写并需回归现有 subagent 测试；`exitCode` 不再可信。若 rpc 在 Windows 上出现协议抖动，回退点是把传输层收敛到 `transport.ts` 一处。

## Out of Scope

* 后台 agent（脱离终端继续跑的 `myflow-implement`）。
* 从看板发起新 run / 新后台命令（用户已确认 A：只控制已有）。
* 在 board 里做任何修改操作（board 严格只读）。
* `steer` 的图像输入、`follow_up`、`clear_queue` 等 rpc 其它命令。
* 修改 `pi-subagents-lite`，或让 myflow 的 run 出现在 lite 的 `/agents` 面板里。
* 会话查看器的搜索/导出/复制。

## Technical Notes

* 现有派发实现：`.pi/extensions/myflow/subagent.ts`（`runSingle` 里 `-p --mode json`、`killChildTree`、`processLine` 事件解析、`getFinalOutput`、`isFailedResult`）。
* 现有后台注册表：`.pi/extensions/myflow/background/{registry,tools,start,output,list,stop}.ts`；`backgroundDir()`、`entryPath()`、cursor 均已存在。
* 现有命令注册与 ctx 形状：`.pi/extensions/myflow/index.ts:328`（`/myflow-status` 的 handler 与 `mode`/`hasUI` 处理）。
* 类型面： `.pi/extensions/myflow/pi-coding-agent.d.ts`（手写最小面，需补 `ui.custom`、`registerCommand` 的 handler ctx 细节）。
* Pi 文档：`docs/tui.md`（`ctx.ui.custom()` 生命周期、`render(width)`、`handleInput`、`theme.fg`、`truncateToWidth`）、`docs/rpc.md`、`docs/rpc-commands.md`（`prompt`/`steer`/`abort`、`agent_settled`、关 stdin 即有序退出）。
* 约束：`subagent.ts` 运行期只允许 import node 内置模块（`node --test` 可导入）；`tests/leak-audit.test.ts` 要求 `mkdtempSync(join(tmpdir(), "myflow-..."))` 前缀。
* 参考实现（不可复制，仅模式参考）：`~/.pi/agent/npm/node_modules/pi-subagents-lite/src/ui/{agent-widget,conversation-viewer}.ts`。
