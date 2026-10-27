---
title: 文件即状态：没有守护进程
---

# 文件即状态：没有守护进程

## 一句话结论

harness 里没有守护进程。所有跨会话、跨进程的真相都是 `.myflow/.runtime/` 下的文件：一个 run 一个 `<runId>.json`，一条控制命令一行 jsonl，一个后台任务一套 `.json` / `.log` / `.exit` / `.pid`。读者永远读文件，写者永远是那个唯一的写者。

## 别人怎么做

**守护进程 + 内存状态 + API。** 一个常驻进程持有 sub-agent 与后台任务的真实状态，面板和 CLI 走 RPC 拿快照、发命令。买到的是：状态权威、有序、能推送，还有一个地方统一做超时与清理。代价是那个进程——要启动、要重启、会挂、会跟 Pi 版本不匹配。

**库式 sub-agent 框架。** 一个 `Agent` / `StopAgent` / `MessageAgent` / `AgentStatus` 之类的工具面，抽象是进程内 handle。买到的是不用自己写状态机；代价是抽象决定能力边界——库不认识的字段，面板就显示不出来。

**会话结束就 kill。** `child_process` 拿 handle，存在内存里，shutdown 时杀掉。这是绝大多数「跑个命令」工具的默认：一个进程的存活区间就是一个会话的区间，不需要「孤儿进程」这个概念。

三条的共同前提是：状态有一个权威副本在内存里，文件只是持久化。

## 这个项目怎么做

三个决定合起来才成立。

**一、`running` 靠相信，`stale` 靠推断。** `runs.ts` 每个 run 一个 json，原子写（`.tmp` + rename），字段含 `status` / `heartbeatAt` / `pid` / `owner{contextKey, pid}` / `logPath` / `steers[]`；派发方在同一个 1 000 ms 轮询里 `heartbeat()`。读者用 `displayStatus` 比较 `heartbeatAt` 与 `STALE_AFTER_MS = 30_000`，超出报 `stale`——**只用于显示，从不写回磁盘**。所以在 run 注册表这一侧，探 pid 的地方只有一处：面板 `x` 键背后的 `taskkill /T /F`。后台任务走的是相反的路——`resolveStatus` 每次读状态都探一次 pid（见[后台任务](../system/background-tasks.md)），两套 pid 判定并存这件事登记在[缺陷登记表](../honest/defects.md)里。

**二、面板建在两套项目级注册表上。** `board/` 六个文件：`state.ts`（注册表里有什么）、`render.ts`（纯排版）、`keys.ts` + `actions.ts`（键 → 动作 → 磁盘写入）、`transcript.ts`（日志 jsonl → 可读行）、`index.ts`（唯一碰终端，开 `ctx.ui.custom()`，持 1 000 ms 刷新）。三个视图：`board` 只读、`tree` 按一次派发分组（`x` 停、`X` 取消整组、`s` 转向、`r` 重跑、`d` / `D` 遗忘）、`background`。每个变更都写控制行或注册表条目，**从不写内存状态**——第二个会话能管第一个会话派发的 run，是这条规则的推论。`@earendil-works/pi-tui` 在命令 handler 里动态 import。

**三、后台任务比会话活得久。** `background/start.ts` 先校验命令与 `cwd`、再弹确认框显示确切命令和解析后的目录；无 UI 且没传 `unattended: true`（记录成 `confirmed_by: "no-ui-explicit"`）就拒绝；条目先写 `starting` / `pid: 0`，以 `{ detached: true }` spawn 并 `unref()`，再回填 pid。`bg_runner.mjs` 自己写 `<taskId>.pid` 握手——在解析 shell、建日志目录、执行任何东西之前——并自己写 `<taskId>.exit`。`resolveStatus` 优先级固定：`.exit` 记录 → 记录里的 `stopped` → 记录里的 `exited` → pid 活着 → `starting` 且未过 `STARTING_TIMEOUT_MS` → 自愈成 `exited`（`exit_code: null`）。`session_shutdown` **什么都不杀**，只报告本会话启动且仍在跑的任务。

## 为什么换成这个

`index.ts` 的 shutdown 注释把话说完了：background tasks are **project-level**, not session-level——任务必须活过会话，它的状态就不能只活在一个会话的内存里。而派发方卡在 `await handle.settled` 里，那段时间没有别的控制流能跑，所以注册、心跳、查快照都只能靠 `readFileSync`。没有守护进程，就没有启动顺序、没有重启、没有「连不上守护进程」这个错误类别；轮询只发生在派发方本来就在等的那个定时器里。最后一条是诊断收益：`cat` 就知道一个 run 为什么不结束、最后一条 steer 是什么——对自己半夜排障的单人项目，这比「状态看起来更整洁」值钱。不引库的理由是能力边界：这里要的不是「派发一个 agent」（Pi 有），而是「管住一个另一个会话拥有的 run」，那需要**这些**磁盘契约；`CHANGELOG.md` 0.3.0 也明说没有新依赖、不涉及 `pi-subagents-lite`。

## 代价

**唯一写者是约定，不是锁。** 正确性靠「一个 run 一个文件」这个粒度：两个 session 不会写同一个文件，所以没有丢失更新。这是**结构上的**论证，不是**机制上的**——一旦某个字段有两个写者（比如 `steers[]` 的镜像写），它立刻不成立。这一点必须说清，因为它读起来像并发设计，实际只是文件粒度。

**心跳是写操作。** 每个活着的 run 每秒重写一次自己的 json。

**`running` 是相信的。** 派发方卡住 30 秒看起来就像死了，真死的 run 最多 30 秒看起来还活着；没有任何地方记录「这个进程死了」，只有「它没在心跳」。

**pid 复用是残余风险。** 粘性优先级（`.exit` 与已判定的 `exited` 都压过 pid 存活）防住旧 pid 复活任务、防住 `stop` 误杀无关进程，但**第一次**读取时 pid 已被复用仍会读成 `running`。

**没有日志轮转、没有资源限制、没有超时。** 保留策略至今未定：截断会丢历史，滚动要加一套命名契约，所以两个都不选。确认框是唯一门禁，而能跑 `bash` 的人可以绕过它。

**`board/` 那六个文件要维护。** 一个必须在 1 Hz 刷新下活下来的 reducer 是真实成本：`selectionAnchor` 曾经锚定光标**来自**的那一行，于是每次刷新都静默撤销移动——每个键都被处理，光标看起来是死的。spec 把它记成「shipped once」。

**还有两处缝。** `.exit` 记录和 pid 存活可以说不同的话，靠固定优先级弥合而不是单一真相源；「只读」不是保证，只是 `board` 视图没接动作；无 UI 时打印纯文本报告是第二条会漂移的渲染路径。

## 什么情况下我会改回去

1. **实时推送成为需求**：面板要在几十毫秒内看到事件，而不是一秒一次的快照。
2. **多机协作**：两个人在不同机器上管同一个项目。文件方案的整个前提是「大家在同一个磁盘上」。
3. **出现一个必须长期运行、要在 Pi 挂了之后继续对外服务的组件**：那时每秒每 run 一次写、加一秒的发现延迟，会超过一个常驻进程的运维成本。
