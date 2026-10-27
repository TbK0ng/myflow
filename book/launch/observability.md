---
title: 埋点就是运行留痕
---

# 埋点就是运行留痕

**分类判断：** 日志与指标（维度 7）**部分存在**，可观测性（维度 9）**部分存在**——这个项目**不埋点**，一行上报代码都没有，因为它没有任何地方可以上报；但**运行本身在留痕**。所以「出事了能不能查」和「有没有指标体系」是两个不同的问题：前者能，后者只有一半。

## 一句话结论

埋点是主动造数据发出去：计数、事件、耗时，发到一个以后能查的地方。这里一个都没有——载荷不联网，`/myflow-status` 与 `/mysubagents` 都是本地读盘渲染。这里做的是反过来的事：**每个动作先在磁盘上留一份**，指标是事后对这些文件做的算术。好处是排查不依赖任何上报链路；代价是只有当下，没有历史。

## 这棵树留了什么

下表都相对项目根；channel 注册表在用户主目录，不在这个仓库里。

| 产物 | 路径 | 谁写 | 能算出什么 |
| --- | --- | --- | --- |
| 运行条目 | `.myflow/.runtime/subagents/<runId>.json` | `runs.ts` `writeRun`（经 `queueGroup` / `markRunning` / `heartbeat` / `addSteer` / `finish`） | `status` / `startedAt` / `endedAt` / `heartbeatAt` / `exitCode` / `stopReason` / `errorMessage` / `steers` |
| 单次运行原文 | `.myflow/.runtime/subagent-logs/<agent>-<epochMs>.log` | `transport.ts` 的 `lazyLogStream` | 逐条 rpc 记录：`message_start` / `message_end` / `turn_end` / 工具调用与结果 / stderr / `usage` |
| 控制命令 | `.myflow/.runtime/subagents/<runId>.ctl.jsonl` | `ctl.ts` `appendControl` | steer 与 abort 发生过什么、谁在什么时刻介入 |
| 后台任务条目 | `.myflow/.runtime/background/<taskId>.json` | `background/registry.ts` `writeEntry` | `command` / `cwd` / `status` / `exit_code` / `started_at` / `ended_at` / `confirmed_by` / `spawn_error` |
| 后台任务输出 | `.myflow/.runtime/background/<taskId>.log` | `bg_runner.mjs` | 命令的 stdout 与 stderr 原文 |
| 后台退出记录 | `.myflow/.runtime/background/<taskId>.exit` | `bg_runner.mjs` | `exit_code` / `shell` / `retries` / `signal` / `at` / `error` |
| pid 握手 | `.myflow/.runtime/background/<taskId>.pid` | `bg_runner.mjs`（不是工具写的） | 权威 pid；`readPid` 先读它，再退回条目的 `pid` |
| 任务记录 | `.myflow/tasks/<slug>/task.json` | `task.py` 的 `create` / `start` / `archive` | `created_at` / `started_at` / `finished_at` / `archived_at` / `status` |
| 提问审计 | `.myflow/tasks/<slug>/questions.jsonl` | `ask.ts` `appendQuestionRow` | 每行的 `at` / `tool` / `header` / `question` / `options` / `answer` / `via` |
| 批准记录 | `.myflow/tasks/<slug>/approval.json` | `task.py` `_write_approval` | `approved_at` / `approved_by` / `session_id` / `plan_files` / `plan_hash` / `questions_asked` |

## 能算的五个指标

### 1. 调度成功率

**文件与字段：** `.myflow/.runtime/subagents/<runId>.json` 的 `status`（`queued` / `running` / `done` / `failed` / `timeout` / `stopped`）与 `endedAt`。

**必须一起说的偏差：** 分母不是全部运行，是**还留在注册表里的**运行。`pruneRuns` 删两类终态条目——结束时间超过 24 小时（`PRUNE_AFTER_MS`）的，以及终态条目超过 `MAX_FINISHED_RUNS = 50` 条之后最旧的部分；日志跟着删，`sweepOrphanLogs` 再清掉没人引用的 `.log`。第二个偏差更麻烦：`status: "running"` 的条目如果派发它的会话已经死了，文件里的状态**永远停在 `running`**——`displayStatus` 只在读的瞬间把心跳超过 `STALE_AFTER_MS`（30 秒）的算成 `stale`，从不写回。朴素统计会把僵尸算成「还在跑」，成功率因此虚高。

### 2. time-to-settle

**文件与字段：** 同一文件的 `startedAt` 与 `endedAt`。

**必须一起说的偏差：** `markRunning` 在真正启动时**重置 `startedAt`**，因为 chain 里排队的成员不该把排队时间报成运行时间。所以「从派发到结束」这个口径不能用 `startedAt`，要用 group id 里的时间：`newGroupId` 是 `g-<epochMs>-<4hex>`，epoch 就在 id 前缀里（`groupRecencyMillis` 就是这么解析的）。

### 3. 后台任务结果

**文件与字段：** `background/<taskId>.exit` 优先于条目里的 `status`。`resolveStatus` 的优先级是固定的：`.exit` 记录 → 记录里的 `stopped` → 记录里的 `exited` → pid 活着 → `starting` 且未超时 → 自愈成 `exited`。

**必须一起说的偏差：** `exit_code` 为 `null` 且 `spawn_error` 非空，是「**根本没起来**」，不是「失败退出」，两个要分开数；`shell: null` 是「没解析到 POSIX shell，所以什么都没跑」，不是「未知」；`<taskId>.pid` 是 wrapper 自己写的握手，比条目里 `spawn` 返回的 pid 权威。

### 4. 任务周期（规划 → 开工 → 收尾）

**文件与字段：** `.myflow/tasks/<slug>/task.json` 的 `created_at`（`create` 写）、`started_at`（`start` 写）、`finished_at` 与 `archived_at`（只有 `archive` 写）。

**必须一起说的偏差：** `task.py finish` 只清会话指针，**明确不改状态、不写结束时间戳**。所以「做完了但没 archive」的任务在指标里永远算进行中，规划时长与交付时长的分母被它抬高。

### 5. 批准等待时长

**文件与字段：** `approval.json` 的 `approved_at` 减 `created_at`（或减该任务 `questions.jsonl` 最后一行的 `at`）。

**必须一起说的偏差：** `plan_hash` 的历史不保留——每次 `approve` 覆盖同一个文件，所以「计划改了几次、批了几次」没有序列可看。能回答的只有「这一次批准是哪个会话给的」（`session_id`）。

## 算不出的四个

### token 成本

**聚合值不存在。** `transport.ts` 的 `applyUsage` 把 provider 报的数累加进 `UsageStats`，但它只到 `SingleResult.usage`——`RunEntry` 里没有 usage 或 cost 字段，所以它随那次 tool call 一起消失。原始数字确实在 `.log` 里（`message_end` 与 `turn_end` 记录带 `usage.input` / `output` / `cacheRead` / `cacheWrite` / `totalTokens` / `cost.total`），但那是**解析日志重算**，不是字段；而且依赖 provider 真报数——本仓库里既有能读到真实数字的运行，也有 usage 全为 0 的运行。日志一被清理，历史成本就没了。

### verify-gate 拦截次数

**不存在。** `index.ts` 的 `verifyAttempts` 是一个会话内存变量，`session_start` 时归零；`agent_before_settle` 里累加之后只塞一条 `display: false` 的 `custom_message`。没有落盘。更彻底的是：子代理跑在 `--no-session` 上，连那条 custom message 都没有。`MAX_VERIFY_ATTEMPTS = 2` 说的是「最多拦两次」，不是「拦过几次」。

### check 代理的一次通过率

**不存在。** 「一次就过」和「被拦两次之后才过」在磁盘上完全同形——都是 `status: "done"`。没有任何字段区分它们。想间接推断只能读日志里「verify 失败之后模型又转了几轮」，那是推测，不是计数。

### stale 的历史占比

**不存在。** `displayStatus` 是纯函数，只在读的瞬间算；磁盘上没有「这条曾经 stale」的字段。能做的只有对「此刻还在表里的非终态条目」做快照——而那正是最容易被僵尸 `running` 条目污染的一类。`pruneRuns` 只删终态条目，僵尸会一直留在表里，把比例永久抬高。

## 五类 id，以及没有的那两类

| 标识 | 形态 | 落在哪 |
| --- | --- | --- |
| 会话（context key） | `pi_<sanitized>`（源是 `PI_SESSION_ID`，`MYFLOW_CONTEXT_ID` 可覆盖） | `.myflow/.runtime/sessions/<contextKey>.json`；也出现在 run 条目的 `owner.contextKey` 与后台游标文件名里 |
| run id | `r-<epochMs>-<4hex>` | `<runId>.json` 与 `<runId>.ctl.jsonl` |
| group id | `g-<epochMs>-<4hex>`（一次 dispatch 一个） | run 条目的 `group` 字段 |
| 后台任务 id | `bg-<base36 ms>-<4hex>` | 四个文件共用一个 id：`.json` / `.log` / `.exit` / `.pid` |
| 计划哈希 | `sha256:<hex>` | `approval.json` 的 `plan_hash`；由 `task.py plan-hash` 单独重算 |

**没有 exception id，也没有跨进程 trace。** 没有任何 id 跨进程传播；等价物只有自由文本：run 条目的 `errorMessage` 与 `stopReason`、`.exit` 的 `error` 与 `signal`、`spawn_error`。子代理跑 `--no-session`，连自己的会话 id 都没有——**一次子运行的身份就是 runId 加那个日志文件名，而日志文件名里不含 runId**（它是 `<agent>-<epochMs>.log`），只能靠条目的 `logPath` 反查。

## 从症状到文件：三条走查

### 「某个子代理产出的东西不对」

1. 在 `.myflow/.runtime/subagents/` 里按 `startedAt` 找最近的条目，读 `agent`、`prompt`、`model`、`task`。
2. 用同一文件里的 `logPath` 打开那个 `.log`，逐条看 `message_end`。
3. 如果 `status` 是 `failed`，先看 `errorMessage`：写着 `spawn pi ENOENT` 就说明问题不在模型，在进程根本没起来。

### 「面板说某个 run 是 running，但什么都没发生」

1. 读那条条目的 `heartbeatAt`，和现在比。超过 30 秒 ⇒ `displayStatus` 会显示 `stale`。
2. `stale` 的含义是**派发它的会话没了**，不是子进程卡了——注册表故意不探测 pid，这是 `runs.ts` 头注释里写明的取舍。
3. 要判断子进程死活得自己看条目里的 `pid`。

### 「后台命令到底是怎么退的」

1. 先读 `.myflow/.runtime/background/<taskId>.exit`，不要先看条目里的 `status`。
2. `shell: null` 表示根本没解析到 POSIX shell，什么都没跑；`exit_code` 为 `null` 且 `spawn_error` 非空表示从没起来。
3. `.pid` 是权威 pid，条目里的那个只是 `spawn` 的返回值。

## 代价

这套东西的代价是**没有历史，只有当下**。`pruneRuns` 是唯一的保留策略：终态条目超过 24 小时或超过 50 条就删，日志跟着删；它**只在人打开 `/mysubagents` 时触发一次**，不是守护进程、不是定时器——不打开面板就没有清理。日志没有按大小轮转、没有压缩；任务目录完全不轮转，`archive` 只是把目录移到 `.myflow/archive/<YYYY-MM>/`，没有人删。

按这本书的口径，这一切属于**运行指标**，不属于成本或质量指标：能算的是调度、时长、后台任务、任务周期、批准等待，算不出的是花了多少钱、拦过几次、一次就对的概率。换成多人或有外部用户的形态要补什么，见[如果它是一个产品](./if-it-were-a-product.md)。
