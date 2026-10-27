# Implement — mysubagents board

每个步骤自成一次可验证的提交。除 S3 允许改 `subagent.ts` 的传输细节外，其它步骤不改已有语义。

约定：
* 新模块运行期只 import node 内置模块；只有 `board/index.ts` 在命令执行时动态 import pi-tui。
* 所有临时目录前缀必须是 `myflow-`（`tests/leak-audit.test.ts` 的审计 glob）。
* 每步结束跑 `npm run typecheck && node --test tests/<本步相关>.test.ts`；S8 跑全量。

## S1 — 前台 run 注册表 `runs.ts`

文件：`.pi/extensions/myflow/runs.ts`（新）、`tests/runs-registry.test.ts`（新）

* `SUBAGENTS_DIR = join(".myflow", ".runtime", "subagents")`、`runsDir(projectRoot)`、`newRunId(now)`、`newGroupId(now)`。
* `queueGroup(dir, members: QueueInput[])` 一次写入全部成员（`status: "queued"`，`index` 1..n，同一 `group`）。
* `markRunning(dir, runId, { pid })`、`heartbeat(dir, runId)`、`finish(dir, runId, status, patch)`。
* `readRun(dir, runId)`、`listRuns(dir)`（坏文件/坏 JSON 跳过）、`groupRuns(entries)`。
* `displayStatus(entry, now)`：`running` 且 `now - Date.parse(heartbeatAt) > STALE_AFTER_MS(30_000)` → `"stale"`，否则 `entry.status`。
* `pruneRuns(dir, now)`：终态且 `endedAt` 早于 `PRUNE_AFTER_MS`，或超出 `MAX_FINISHED_RUNS(50)` 的最旧终态条目。
* 原子写复用 `background/registry.ts` 的 `writeFileAtomic`。

验证：写-读往返、分组顺序、坏文件跳过、stale 边界（29s 不算 / 31s 算）、prune 两种条件。

## S2 — 控制文件 `ctl.ts`

文件：`.pi/extensions/myflow/ctl.ts`（新）、`tests/ctl.test.ts`（新）

* `ctlPath(dir, runId)`、`appendControl(path, { type, message, by })`（生成 `id`/`at`，一条一行）、
  `readNewControls(path, offset)` → `{ commands, offset, skipped }`。
* 半行不消费（offset 停在最后一个 LF 之后）；坏行跳过并计数；文件不存在返回空且 offset 不变。
* `clearControls(path)`（settle 后删除；派发前也先删）。

验证：追加两条 → 一次读全部 → 再追加 → 只读增量；写入无换行的半行 → 不消费 → 补全后能读到；坏行计数。

## S3 — rpc 传输层 `transport.ts` + `subagent.ts` 接入

文件：`.pi/extensions/myflow/transport.ts`（新，从 `subagent.ts` 抽出 run 的进程部分）、
`.pi/extensions/myflow/subagent.ts`（改）、`tests/subagent-rpc.test.ts`（新）、
`tests/subagent.test.ts`（改写断言）、`tests/mvp.test.ts`（若涉及传输断言）

先做冒烟（写在本步 PR 描述里）：用真实 `pi` 以 `--mode rpc --no-session --approve --tools read
--append-system-prompt <tmp>` 起一个子进程，发送 `{"type":"prompt"}`，确认能收到 `agent_settled`
且 `--append-system-prompt` 生效（问它复述注入的一句话）。冒烟不通过就停下、上报，不要继续改
`subagent.ts`。

然后：

* `startRun(options): RunHandle`：spawn `pi --mode rpc --no-session --approve ...`（`stdio: ["pipe","pipe","pipe"]`，
  env 不变），写注册表（`markRunning`），起 1s ctl 轮询（`heartbeat` + 转发 steer/abort），
  返回 `{ runId, settled, steer, abort }`。
* `subagent.ts` 的 `runSingle` 改为 `startRun(...)` + `await handle.settled`；`single/parallel/chain`
  在派发前调用 `queueGroup`（chain 的成员初始 `queued`，轮到才 `markRunning`）。
* 状态机按 design.md §3 实现：settle 于 `agent_settled`；dialog 类 `extension_ui_request` 回 `cancelled:true`；
  超时 → `abort` → 5s → kill；settle 后关 stdin → 5s → kill；删 ctl 与临时 system prompt；
  写终态（done/failed/timeout/stopped + `stopReason`/`errorMessage`/`exitCode`）。
* `killChildTree`、日志落盘路径、`getFinalOutput`、`isFailedResult` 语义保留；`isFailedResult` 不再看 `exitCode`。

验证（`tests/subagent-rpc.test.ts`，用 `getPiInvocation` 注入假 pi 脚本）：
prompt 是第一条 stdin 记录；`agent_settled` 触发 settle；ctl 里的 steer 被转发为 `{"type":"steer"}` 且日志里出现该文本；
超时先 abort 后 kill（假脚本故意不 settle）；进程提前退出 → `failed`；`extension_ui_request` 收到 `cancelled:true` 回复；
注册表在 settle 后是终态且带 `endedAt`。

## S4 — 日志 transcript `transcript.ts`

文件：`.pi/extensions/myflow/board/transcript.ts`（新）、`tests/transcript.test.ts`（新）

* `parseTranscript(logText: string): TranscriptLine[]`：识别 `message_end`（assistant 文本 → `text`，
  thinking → `thinking`，tool call → `tool`，tool 结果 → `result`，错误 → `error`），未知类型跳过。
* `readTail(path, maxBytes)`：只读文件尾部，切掉首个不完整行；文件不存在返回 `""`。
* 输出保持"每条 tool call 一行、结果截断到 200 字符"。

验证：一段固定日志 → 行模型种类与顺序；半文件尾部不产生残行；空/缺失文件。

## S5 — 视图状态、纯 render、键 reducer

文件：`.pi/extensions/myflow/board/{state,render,keys}.ts`（新）、
`tests/board-render.test.ts`、`tests/board-keys.test.ts`（新）

* `state.ts`：`buildState({ projectRoot, now, view, selection })` → `BoardState`（runs/groups/background
  三份数据 + 每行的 `displayStatus`/`elapsed`/`lastLogLine`/`steered` 标记）。数据来源只有
  `listRuns()` 与 `background/registry.ts: listEntries()/resolveStatus()`。
* `render.ts`：`renderMenu/renderBoard/renderTree/renderBackground/renderViewer`，签名
  `(state, ctx: { theme, width, truncate }) => string[]`。颜色/分区/标注按 design.md §5；
  `board` 视图不渲染任何可执行操作的提示。
* `keys.ts`：`normalizeKey(data, keybindings)` → `"up"|"down"|"enter"|"esc"|"x"|"X"|"s"|"r"|"c"|"q"|null`；
  `applyKey(view, state, key)` → `{ state, action }`。board 视图只产出 `open-viewer`/`close`/导航类 action。

验证：假 theme（`fg` → `<name>text`）断言分区标题、accent/warning 标记、steer 标记、选中行；
board 视图按键不产生 `stop-run`/`steer`/`restart-run`；tree 的 `X` 产出 `cancel-group` 且 group 取自选中 run。

## S6 — 命令与 TUI glue

文件：`.pi/extensions/myflow/board/index.ts`（新）、`.pi/extensions/myflow/board/actions.ts`（新）、
`.pi/extensions/myflow/pi-coding-agent.d.ts`（改：补 `ctx.ui.custom`、`setStatus` 的最小形状与
`registerCommand` handler ctx）、`.pi/extensions/myflow/index.ts`（注册命令）

* `registerMyflowSubagentsCommand(pi)`：`/mysubagents [board|tree|background]`；无参数进菜单。
* `ctx.mode !== "tui"` → 生成同一份 state 的纯文本报告（`renderBoard` 的降级版：去色、
  `truncate` 用恒等），`pi.sendMessage({ customType: "myflow-subagents", content, display: true })` +
  `ctx.ui.notify`；不抛错。
* TUI：`await import("@earendil-works/pi-tui")` 取 `truncateToWidth`，`ctx.ui.custom((tui, theme, keybindings, done) => component)`；
  组件内 1s 定时器刷新 state + `requestRender`，包装 `done` 先 `clearInterval`。
* `actions.ts` 执行 action，依赖注入：`{ kills: killChildTree, terminateTree, startRun, startBackgroundTask, writeControl, ... }`；
  结果以 `ctx.ui.notify` 回报（"steered run r-… ", "stopped", 失败原因）。
* `steer` 的输入：`ctx.ui.input()` 取一行（在关闭 custom 组件之后调用，避免两层输入抢焦点）。

验证：`tests/board-actions.test.ts` 覆盖每个 action 的副作用（ctl 文件内容、注册表终态、
注入的 kill/start 收到正确参数）；手动冒烟（记录在 PR 描述）：TUI 里打开三视图、进入查看器、Esc 退出、无定时器残留。

## S7 — background 视图的三个管理操作

文件：`.pi/extensions/myflow/background/start.ts`（改：抽出 `startBackgroundTask()`）、
`.pi/extensions/myflow/background/output.ts`（改：抽出只读 `readTail`）、
`.pi/extensions/myflow/board/actions.ts`（改）、`tests/bg-start.test.ts`/`tests/bg-stop.test.ts`（保持不变即通过）

* 抽出 `startBackgroundTask(params, deps)`，`createBgStartTool` 与看板 `r` 共用；看板的 `r` 即用户确认，
  不再弹二次确认。
* `x` → `terminateTree(pid)` + 现有 stop 的等待/失败语义（复用，不重写）。
* `c` → `prune(dir, Date.now())`。
* Enter → `readTail(logPath, 32KB)`，**不写 cursor**。

验证：既有 bg 测试全绿；新增断言：board `r` 走 `startBackgroundTask` 且注册表新增一条；`c` 只删已完成；
`readTail` 不改 cursor 文件。

## S8 — 文档、清点、全量回归

文件：`.pi/skills/myflow-meta/SKILL.md`（Layout 增加 `transport.ts`/`runs.ts`/`ctl.ts`/`board/`）、
`.myflow/workflow.md`（工具段提到 `/mysubagents` 三视图 + 只读/可管理的边界）、
`CHANGELOG.md`（若 release 流程要求）、`.pi/extensions/myflow/board/*` 顶部注释

* 确认 `tools/release-payload.json` 的 `.pi/extensions/myflow` 树自动包含新文件（`tests/scaffold.test.ts` 会验证）。
* 全量：`npm run typecheck && npm test`。
* 若 `tests/doc-numbers.test.ts` 因文档新增数字报警，按它的规则把数字来源写进 `harness-conventions.md` 或避免在文档里写死数字。
