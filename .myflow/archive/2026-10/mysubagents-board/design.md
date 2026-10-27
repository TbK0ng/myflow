# Design — mysubagents board

## 1. Module layout

```
.pi/extensions/myflow/
  subagent.ts            # (改) 派发编排：modes、结果、工具注册；改用 transport.ts + runs.ts + ctl.ts
  transport.ts           # (新) rpc 子进程传输：startRun() 句柄，settle/abort/kill 状态机
  runs.ts                # (新) 前台 run 注册表：写/读/分组/stale/heartbeat/prune
  ctl.ts                 # (新) 控制文件：追加与增量读（坏行容忍）
  board/
    index.ts             # (新) /mysubagents 命令注册 + 视图路由（TUI glue，唯一动态 import pi-tui 的地方）
    state.ts             # (新) 把 runs + background 注册表汇成一份视图状态（node-only，纯数据）
    render.ts            # (新) 三个视图 + 查看器的纯 render 函数（注入 theme/width/truncate）
    keys.ts              # (新) 纯 reducer：applyKey(view, state, key) -> { state, action }
    transcript.ts        # (新) 日志 JSONL -> 可读行（纯函数）
    actions.ts           # (新) 执行 reducer 产出的 action（stop/steer/restart/bg-*）
```

`transport.ts` / `runs.ts` / `ctl.ts` / `state.ts` / `transcript.ts` / `render.ts` / `keys.ts` 运行期只 import
node 内置模块，因此在 `node --test` 下可直接导入。只有 `board/index.ts` 在命令执行时才
`await import("@earendil-works/pi-tui")`，模块加载期不依赖 pi 包。

## 2. 注册表（runs.ts）

目录 `.myflow/.runtime/subagents/`；文件 `<runId>.json`；原子写复用
`background/registry.ts` 的 `writeFileAtomic()`。

```ts
type RunStatus = "queued" | "running" | "done" | "failed" | "timeout" | "stopped";

interface RunEntry {
  runId: string;        // r-<epochMs>-<4hex>；created 时即分配
  group: string;        // g-<epochMs>-<4hex>；一次派发调用 = 一个组
  index: number;        // 组内 1-based
  total: number;        // 组内总数
  agent: string;        // myflow-implement
  mode: "single" | "parallel" | "chain";
  prompt: string;
  status: RunStatus;
  startedAt: string;    // ISO
  endedAt: string | null;
  heartbeatAt: string;  // 派发方每 1s 刷新
  pid: number | null;
  owner: { contextKey: string | null; pid: number };
  logPath: string;      // 项目相对 posix
  task: string | null;  // 项目相对 posix
  model: string | null;
  exitCode: number | null;
  stopReason: string | null;
  errorMessage: string | null;
  steers: { message: string; at: string }[];
}
```

* `queueGroup(...)`：派发前写入 `status: "queued"` 的全部成员（parallel/chain 一次写完，
  `index` 1..n）。这让"还没轮到"的 chain 成员在 board 里也可见。
* `markRunning(id, pid)` / `heartbeat(id)` / `finish(id, status, patch)`。
* `listRuns(dir)`：读全部条目，坏文件跳过；返回按 `group` + `index` 排序的结果与按组聚合的视图。
* `displayStatus(entry, now)`：`running` 且 `now - heartbeatAt > STALE_AFTER_MS (30_000)` → `"stale"`。
  纯函数，读侧不探测进程。
* `pruneRuns(dir, now)`：删除 `endedAt` 早于 `PRUNE_AFTER_MS`（复用既有 24h）的终态条目，
  以及超过 `MAX_FINISHED_RUNS (50)` 的最旧终态条目。命令打开时调用一次。

## 3. 传输层（transport.ts）

```ts
interface StartRunOptions {
  agentName: string; prompt: string; projectRoot: string;
  contextKey: string | null; taskDir: string | null;
  group: string; index: number; total: number; mode: RunMode;
  config: RunConfig;          // model/thinking/tools（沿用 resolveRunConfig）
  timeoutMs: number;
  onUpdate?: (result: SingleResult) => void;
}
interface RunHandle {
  runId: string;
  settled: Promise<SingleResult>;
  steer(message: string): boolean;   // 写 ctl，返回是否已排队
  abort(reason: "abort" | "timeout"): void;
}
```

**参数**：`["--mode", "rpc", "--no-session", "--approve", ...]` + 现有 model/thinking/tools +
`--append-system-prompt <tmp>`。`env` 与现有完全一致（`MYFLOW_AGENT_TYPE` /
`MYFLOW_CONTEXT_ID` / `MYFLOW_WRITES_UNDER`）。`stdio: ["pipe","pipe","pipe"]`。

**启动**：spawn 后立即 `write({"id":"p0","type":"prompt","message":prompt})`。
`response` 到达时 `data.disposition` ∈ {`started`,`queued`} 视为接受；`handled`/`success:false`
→ 直接 settle 为 failed（带原因）。

**状态机**：

| 输入 | 动作 |
|---|---|
| stdout `message_end` | 追加到 `SingleResult.messages`、累加 usage、更新 `onUpdate`、写日志（现有解析不变） |
| stdout `agent_settled` | settle（`aborted:true` → stopped，否则按 `isFailedResult` 判 done/failed） |
| stdout `extension_ui_request`（dialog 类） | 立即回 `{"type":"extension_ui_response","id":...,"cancelled":true}`；fire-and-forget 类忽略 |
| stdout 其它记录（response/状态事件） | 忽略（未知记录不抛） |
| ctl 轮询（1s） | 转发 steer → 子进程 stdin `{"type":"steer",...}`；`abort` → 发 `{"type":"abort"}` 并进入 abort 宽限 |
| 超时计时器 | 发 `abort`，开 5s 宽限计时器；到点 `killChildTree`，状态 `timeout` |
| 子进程 exit 早于 settle | settle 为 `failed`（`stopReason` 取「unexpected exit」，除非已请求 abort/timeout） |
| settle 之后 | `stdin.end()` 请求有序退出；5s 内未 exit → `killChildTree`；停止 ctl 轮询、删 ctl 文件、写终态、删临时 system prompt |

`exitCode` 仍记录（参考信息），不再参与成败判定。

**为什么不会挂住**：每个等待都有上限——prompt 接受 10s、abort 宽限 5s、关 stdin 后退出 5s、
ctl 轮询仅在 settled 之前运行且 `unref()`。任何路径都以 `clearInterval` + 一次终态写入结束。

## 4. 控制通道（ctl.ts）

`<runId>.ctl.jsonl`，一行一条：

```json
{"id":"c-1","type":"steer","message":"focus on the tests","at":"ISO","by":"pi_xxx"}
{"id":"c-2","type":"abort","message":"","at":"ISO","by":"pi_xxx"}
```

* `appendControl(path, command)`：`appendFileSync` 一行 JSON。
* `readNewControls(path, offset)`：从 `offset` 读增量，按 LF 切分，**最后一段无换行则保留为不完整行
  （不消费）**；`JSON.parse` 失败的行跳过并计入 `skipped`。返回 `{ commands, offset }`。
* 写侧幂等：同一 `id` 只转发一次（派发方维护内存集合）。
* settle 后删除 ctl 文件；残留的旧 ctl 在派发开始前先删除，避免 steer 串到下一条 run。

## 5. 视图与渲染

`state.ts` 输出一份纯数据：

```ts
interface BoardState {
  task: string | null;
  runs: RunView[];            // 含 displayStatus/elapsed/group/index/lastLogLine
  groups: GroupView[];        // mode/agent/members/aggregate status/elapsed
  background: BgView[];       // id/command/status/exitCode/elapsed/detached
  selection: { view: View; groupIndex: number; runIndex: number };
}
```

`render.ts` 里每个视图是一个纯函数：

```ts
renderView(view, state, { theme, width, truncate }): string[]
```

* `theme` 只用到 `fg(name, text)` 与 `bold`；测试传 `{ fg: (n, t) => \`<${n}>${t}\`, bold: (t) => t }`。
* `truncate` 由调用方注入（生产是 `truncateToWidth`），测试传 `(s) => s`。
* 颜色约定：前台 run = `accent`，后台 detached = `warning`，running = `success` 字形，
  failed/timeout = `error`，stopped/stale = `muted`，steer 过的 run 加 `»` 标记。
* board 两个分区各自带标题行，后台分区标题固定包含「detached · 终端退出后仍在运行」。
* 查看器：`transcript.ts` 把日志行转成 `{kind, text}`（assistant/thinking/tool/result/error），
  `render.ts` 再按宽度折行；running 的 run 每秒从文件尾部重读最后 N KB（`readTail`），不整文件重解析。

`keys.ts` 纯 reducer：输入 `key`（已由 `keybindings.matches` 归一成 `up/down/enter/esc/x/X/s/r/c/q`）
返回 `{ state, action }`，action 是下列判别联合：

```ts
type Action =
  | { kind: "none" }
  | { kind: "close" }
  | { kind: "open-view"; view: View }
  | { kind: "open-viewer"; target: ViewTarget }
  | { kind: "stop-run"; runId: string }
  | { kind: "cancel-group"; group: string }
  | { kind: "steer"; runId: string }
  | { kind: "restart-run"; runId: string }
  | { kind: "stop-bg"; id: string }
  | { kind: "prune-bg" }
  | { kind: "rerun-bg"; id: string };
```

`actions.ts` 执行 action；它需要 `pi`/`ctx` 时由 `board/index.ts` 传入回调，因此 `actions.ts` 里
不出现 pi-tui 类型，测试可对每个 action 断言它写了什么（ctl 文件 / 注册表 / 调用注入的
`killTree`、`startRun`、`startBackgroundTask`）。

## 6. 复用与必要的抽取

| 用途 | 复用 |
|---|---|
| 原子写 | `background/registry.ts: writeFileAtomic` |
| 进程树杀死 | `subagent.ts: killChildTree`（前台）、`background/stop.ts: terminateTree`（后台） |
| 后台列表/状态 | `background/registry.ts: listEntries` + `resolveStatus` |
| 后台清理 | `background/registry.ts: prune(dir, now)` |
| 后台输出尾部 | `background/output.ts` 的 tail 读取（只读：不写 cursor）；需要把读尾逻辑抽成
`readTail(path, maxBytes)` 导出 |
| 后台重跑 | 从 `createBgStartTool` 抽出 `startBackgroundTask(params, deps)` 导出，
tool 与看板都调用它；看板按下 `r` 本身即用户确认，不再弹第二次确认 |

抽取**只移动代码不改语义**：现有 `bg-start.test.ts` / `bg-stop.test.ts` 必须原样通过。

## 7. 生命周期与刷新

* 视图组件工厂里起一个 1s 定时器刷新 state 并 `tui.requestRender()`；包装 `done()` 以先
  `clearInterval` 再完成，避免视图关闭后定时器泄漏（对齐 `leak-audit` 的取向）。
* 选择位置按 `runId`/后台 `id` 记忆，刷新重排时保持选中而不跳行。
* 关闭 `ctx.ui.custom()` 的组件实例即可，不持有 overlay handle；不使用 `setWidget`。

## 8. 失败模式与对策

| 风险 | 对策 |
|---|---|
| rpc 模式在本机 pi 上不接受 `--append-system-prompt` / `--tools` | 步骤 S3 先做冒烟脚本（`pi --mode rpc --no-session --approve --tools read --append-system-prompt f -e` 式最小验证）再改 subagent.ts；失败则整体退回 json 模式并把 steer 降级为「不支持」 |
| 子进程要弹对话（child 调 ask_user/审批） | 自动 `cancelled: true`，run 继续或在该轮自然结束，不挂死 |
| 派发会话被杀，run 变孤儿 | `stale` 显示 + `x` 直接按 registry 里的 `pid` 杀（不依赖父进程） |
| ctl 写到一半 | 增量读只消费完整行；坏行跳过并计数，board 显示 skipped 数 |
| 重跑风暴 | `r` 每次产生新 group；同一视图内连按不会复用旧 runId |
| 两个会话同时 steer 同一 run | ctl 是 append-only，两边都能投递；steer 顺序按文件行序，registry `steers[]` 保留全部 |

## 9. 测试策略

| 文件 | 覆盖 |
|---|---|
| `tests/runs-registry.test.ts` | 写/读/坏文件跳过/分组/index/stale 阈值/heartbeat/prune |
| `tests/ctl.test.ts` | 追加、增量 offset、半行不消费、坏行跳过、删文件后重新追加 |
| `tests/subagent-rpc.test.ts` | 用 `getPiInvocation` 注入假 pi 脚本（node 脚本回放 rpc 记录）：prompt 首记录、settle 于 `agent_settled`、steer 从 ctl 转发并在日志出现、超时 → abort → kill、意外退出 → failed、extension_ui_request 被 cancelled |
| `tests/transcript.test.ts` | 日志 JSONL → 行模型（thinking 折叠、tool 一行、错误行） |
| `tests/board-render.test.ts` | 三视图 + 查看器纯 render：分区标题、颜色标记、选中高亮、宽度截断（注入假 theme/truncate） |
| `tests/board-keys.test.ts` | 每视图键 → action 映射；board 视图不产出修改类 action |
| `tests/board-actions.test.ts` | 每个 action 的实际副作用（ctl 内容、registry 状态、注入的 kill/start 调用） |
| 既有 `tests/subagent.test.ts` | 按 rpc 语义改写断言（保留用例意图，注释说明判定变化） |

全部用 `node --test`，不引入新依赖；TUI 组件本身不做快照测试，只测纯函数与 action 副作用。
