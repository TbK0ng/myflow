---
title: append-only 的转向通道
---

# append-only 的转向通道

## 一句话结论

转向不是一个 IPC 调用，而是一行 append 到 `<runId>.ctl.jsonl` 的 JSON；派发方每秒从上次的**字节**偏移读一次。理由只有一个：派发方正阻塞在自己的工具调用里，任何需要事件循环的通道都用不上。

## 别人怎么做

- **管道**：派发方持有子进程的 stdin，把 steer 写进去。最直接、最低延迟，本项目也用它——但只对**自己**拥有的那个子进程。
- **Unix socket / named pipe / TCP loopback**：面板连一个端点，派发方在那头监听。双向、有序、有连接语义。
- **进程内队列**：共享数组加一个事件，几乎零延迟。
- **信号**：最省事，但没地方带消息，只能表达「停」。

它们为什么是主流：都靠操作系统做同步——socket 有连接与背压，管道有写入阻塞，队列有一把锁，信号有投递保证。代价是通道两端都必须活着**且在监听**。

## 这个项目怎么做

`.pi/extensions/myflow/ctl.ts` 就是全部。

**文件**：`<dir>/<runId>.ctl.jsonl`（`CTL_SUFFIX`），一行一个 JSON 对象，只有两种命令——`steer`（带 `message`）与 `abort`（`ControlType`）。

**写入**：`appendControl` 用 `appendFileSync` 追加，id 是随机的 `c-<epochMs>-<6hex>` 而不是计数器，理由写在注释里：*"so two sessions appending to the same file cannot mint the same id"*——两个会话同时转向同一个 run 时，计数器会撞，撞了就会有一条命令被当成重复丢掉。

**读取**：`readNewControls(path, offset)` 返回 `{ commands, offset, skipped }`。偏移是**字节**偏移，多字节字符的 steer 不会让下一次读从半个字符开始；读取到最后一个 `0x0a` 为止，**没有换行的尾行不消费**（写者可能在 `appendFileSync` 中途被打断，消费半行会把一条命令变成一个解析错误并永久丢掉）；解析不了或类型不认识的行跳过并计入 `skipped`，永不致命；文件不存在返回「还没有命令」而不是错误。

**派发方**：`startRun` 的 `setInterval`（`timings.pollMs` = 1 000 ms）里顺序做三件事——`heartbeat()`、`readNewControls`、逐条转发。按命令 `id` 去重（`handledControls`），`steer` 写进子进程 stdin 并镜像进注册表的 `steers[]` 供显示，`abort` 走 `requestAbort`（5 秒宽限后按树杀）。整块包在 `try/catch` 里：一次写不出的轮询不能让 run 结束，也不能让会话崩。

**清理**：`clearControls` 在 settle 时跑，**派发之前**也跑一次——上一轮残留的控制行绝不能转向这一轮。

**面板**：`tree` 视图的 `s` 键用同一个 `appendControl` 追加。所以「第二个会话能管第一个会话派发的 run」不是后来加的功能，是这个文件格式的推论：谁都能写，只有派发方在读。

## 为什么换成这个

`ctl.ts` 头一段：*"the dispatcher owns the child's stdin, the board does not, and the dispatcher may be blocked inside its own turn (or be another session entirely)"*。`CHANGELOG.md` 0.3.0 更短：*"this is the only path that works when the dispatching session is blocked inside its own tool call."*

这不是措辞，是单线程事件循环的事实：`myflow_subagent.execute` 在 `await handle.settled`，这段时间里同一进程没有控制流能跑到一个 socket 的 `data` 回调里；进程内队列也救不了，因为队列的消费者正是那个被 await 卡住的函数。而 `appendFileSync` 不需要对方在线——文件是唯一一个「写者不需要读者活着」的通道。

通道一旦是磁盘，规则就是被逼出来的：append-only（两个写者不能互相覆盖）、随机 id（去重不能靠自增序号）、字节偏移（读要能从中断处继续）、半行不消费（丢一条命令比晚一秒更糟）。socket 会自己给出这四样，所以这个设计的成本基本等于「把 socket 帮你想过的东西手写一遍」。

## 代价

**一秒延迟，外加每个活着的 run 每秒一次唤醒。** 对一个正在思考的 agent 够用；对「立刻打断」不够——真正的停止是面板先写 `stopped` 再 `taskkill`，`abort` 只是给面子。

**容错是手写的，而且承重。** 坏行跳过并计数、半行等换行，各自只有几行，都容易被一次「清理」顺手删掉；删掉之后，一次中断的写入就变成一条永久丢失且无报错的命令。

**没有锁。** 这套机制建立在 append-only 语义加每写者随机 id 上，比一把互斥锁弱：在 `write` 与 `flush` 之间被杀掉的写者会留下半行，第二个写者往它后面 append，两截永远拼不起来——拼不起来是**好**结果（都成了坏行、被计入 `skipped`），但它仍然是「靠规矩而不是靠机制」。

**崩溃的派发方会留下文件。** `clearControls` 只在 settle 与派发前跑，而 id 带时间戳，实践中就一直在，直到 `pruneRuns`。

**它是单向的。** 能说「转一下」「停」，不能问「你现在在做什么」；子进程的中间状态只能从注册表和日志反推。加第三种命令也不是加一个枚举值：`ControlType` 联合类型、面板输入、`startRun` 里的 `if/else`、文档里「两条命令」的每一处都要同时改。

**轮询是永久成本。** 只要有一个 run 活着，就有一个 1 Hz 定时器在跑、在读文件、在写心跳。它便宜，但它不消失。

## 什么情况下我会改回去

1. **Pi 提供一条从工具调用内部仍能读输入的通道**——一个被 `await` 卡住的工具调用还能收到注入的消息。那时磁盘轮询的全部理由消失，延迟直接降到零。
2. **`myflow_subagent` 改成不阻塞工具调用**：返回句柄、事件走 Pi 的 hook。那时派发方不再卡住，socket 或进程内队列都可行——但派发的语义也变了（主会话可以同时做别的），那是另一篇。
3. **转向变成主要交互方式**，1 秒延迟被明确抱怨。这个信号可观测：如果 steer 的次数超过派发次数的量级，延迟就从「可接受」变成「限制工作方式」。
