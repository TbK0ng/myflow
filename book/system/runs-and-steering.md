---
title: 运行注册表与转向
---

# 运行注册表与转向

## 职责

一次子代理 run 由三样东西描述：**注册表条目**（它是什么、活着吗）、**控制文件**（还能不能改它）、**日志**（它到底说了什么）。三者都在 `.myflow/.runtime/` 下，都是普通文件。没有守护进程、没有 socket、没有内存里的运行列表。

## 触发点

- `subagent.ts` 在**起子进程之前**调 `queueGroup`，一次派发写一整组条目，`status: "queued"`，`group` 形如 `g-<epoch>-<4hex>`。
- `transport.ts` 在子进程受理 prompt 后 `markRunning`，并起 1 秒一次的 `setInterval`：刷心跳 + 读控制文件。
- 任何会话（包括 `/mysubagents` 面板）往后追加一行控制命令。
- settle 时 `finalize` 写终态、删控制文件、按需清日志。

## 读写哪些文件

| 路径 | 写者 | 内容 |
| --- | --- | --- |
| `subagents/<runId>.json` | 只有派发方 | 一条 `RunEntry`，原子写（`.tmp` → rename） |
| `subagents/<runId>.ctl.jsonl` | 任何会话，append-only | `{"type":"steer","message"}` / `{"type":"abort"}` |
| `subagent-logs/<agent>-<epochMs>.log` | 本 transport | 子进程原始输出 |

`RunEntry` 的字段就是这套机制的完整真相：`runId` / `group` / `index` / `total`（一组内的序号）、`agent` / `mode` / `prompt` / `model`、`status`、`startedAt` / `endedAt` / `heartbeatAt`、`pid`、`owner{contextKey,pid}`、`logPath`、`task`、`exitCode` / `stopReason` / `errorMessage`、`steers[]`。未知字段被容忍，所以新写入方能给旧读取方留活路。

`steers[]` 只是**显示副本**，不是传输通道；真正下令的是控制文件。

## 不变量

**状态词是封闭集合。** `queued | running | done | failed | timeout | stopped`，`stale` 不在其中：它是读者临时推断的显示状态，永远不落盘。

**`running` 是被相信的，`stale` 是被推断的。** `displayStatus` 只在 `status === "running"` 时比较 `heartbeatAt` 与 `STALE_AFTER_MS`（30 秒）；心跳每 1 秒刷新一次，所以 30 秒静默意味着派发它的那个会话已经不在了。心跳字段解析不出来也算 `stale`。

这条规则是**故意的性能取舍**：一行一次 `tasklist` 大约 50 毫秒，每秒刷新一次的面板会为此付掉全部预算，而打不开的面板等于不存在。真正探 pid 的地方只有一个：`x` 键。

**注册表一个写者，控制文件多个。** 注册表只有派发方写，`.tmp` + rename 保证读到的总是完整 JSON，不需要锁。控制文件相反：它允许多个会话追加，靠三个约定成立——只追加不重写、`id` 是随机的（`c-<epochMs>-<6 hex>`，同一毫秒追加也不撞号）、派发方按 `id` 去重后按文件顺序转发。

**读控制文件用字节偏移，不用行号。** `readNewControls` 返回"下一个起点"而不是"读了多少行"，并且**停在最后一个 LF 之后**：写入方可能在半行处被打断，消费半行会把一条命令变成解析失败并永久丢掉。解析不了的行计入 `skipped`，绝不终止轮询。

**格式坏掉不等于坏掉。** 一份读不出来的注册表文件变成一条 warning，不是异常；一次写不进控制文件的轮询被吞掉，不会结束 run 也不会终结会话。

**终态一次写，且不覆盖别人的判断。** `isSettled` 保证只有一次终态写入。若面板的 `x` 已抢先杀掉子进程并记下 `stopped`，`finalize` 重读条目后保留它，不改写成 `failed` / `unexpected exit`。

**清理不是自动的。** `pruneRuns` 删除超过 24 小时或超出保留条数的终态条目并带走日志；它只在 `/mysubagents` 打开时跑一次。运行中的条目 `deleteRun` 直接拒绝。

## 为什么非用文件不可

派发方此刻正**卡在自己的工具调用里**：`myflow_subagent.execute` 在 `await handle.settled`，模型这一轮不能再调任何工具，进程里没有第二条控制流去跑一个 IPC 处理器。而面板可能根本是**另一个会话**打开的，它拿不到那个子进程的 stdin。

所以能同时满足"跨会话""派发方被阻塞""没有后台线程"的通道只剩一个：写在两方都能看见的磁盘上。代价全部由轮询和容忍逻辑承担。

## 一个最小走查

`/mysubagents tree` 里选中一条 `running`，按 `s`：

1. 面板先关掉自己再弹出输入框——对话框不能压在 1 秒刷新的组件里。
2. 确认后 `appendControl` 往 `<runId>.ctl.jsonl` 追加一行，带随机 `id`。
3. 派发方的下一次轮询（≤1 秒后）读到这一行，`id` 未见过，于是把 `{type:"steer",message}` 写进子进程 stdin，并 `addSteer` 到注册表的 `steers[]`。
4. 面板下一次刷新从注册表读到 `steers[]` 并显示——**面板看到的永远比真实发生慢一拍**，它是读者不是参与者。
5. run 结束：`finalize` 删控制文件、写终态，5 秒后子进程还不走就杀树。

## 常见误解

- **"`stale` 表示死了。"** 它表示"30 秒没有心跳"。派发方卡顿也会产生 `stale`；真的死掉的 run 在被人观测到之前最多还显示 30 秒 `running`。
- **"转向是即时的。"** 最坏 1 秒延迟，而且子进程什么时候读它由 Pi 决定；转向能改变方向，不能打断正在生成的 token。
- **"注册表会被自动收拾。"** 不。`pruneRuns` 只在有人打开面板时跑一次，孤立的控制文件在崩溃的派发方之后会一直留着。
- **"面板在管 run。"** 面板只写两样东西：控制文件的一行，或注册表的一次修改。它不持有句柄，也不参与 run 的生命周期。
