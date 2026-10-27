---
title: 长驻 rpc 子进程
---

# 长驻 rpc 子进程

## 一句话结论

一次 `myflow_subagent` 派发不是一个「跑完就死」的命令，而是一个长驻的 `pi --mode rpc` 子进程。它的结束信号是 `agent_settled` 这条记录，不是退出码；同一个改动买到了「a run 在工作途中可以被改方向」。

## 别人怎么做

**一次性子进程**：起一个进程，prompt 作为参数（`pi -p --mode json "<prompt>"`），读完 stdout 到 EOF，信 exit code。它买到的是「进程生命周期 = run 生命周期」：没有状态机，退出码是操作系统、CI、任何 supervisor 都懂的唯一信号，挂了就是挂了，不存在「进程还在但不工作了」的中间态。

**进程内直接调模型 API**：没有子进程，一个函数调用一个 promise，事件走回调或 async iterator。买到的是延迟和无序列化——不需要协议、管道、临时文件。

**库式 sub-agent 框架**：一个 `Agent` / `StopAgent` / `MessageAgent` / `AgentStatus` 之类的工具面，进程内 handle 就是状态，停止就是对 handle 调个方法。买到的是不用自己写状态机。

三条路的共同前提相同：run 的结束等于一个确定的可观测事件——进程退出、promise resolve、handle 变终态。而这些事件都意味着**之后不能再对这次 run 做任何事**。

## 这个项目怎么做

`.pi/extensions/myflow/transport.ts` 的 `startRun` 是全部。它返回一个 `RunHandle`（`settled`、`controlPath`、`steer()`、`abort()`），永不抛异常。

- **argv**：`buildArgs` 组装 `--mode rpc --no-session --approve`，再按需加 `--model M[:thinking]` 或 `--thinking`、`--tools a,b,c`、`--append-system-prompt <临时文件>`；agent 正文写成 `mkdtemp` 目录下 `mode: 0o600` 的文件，settle 时删掉。
- **prompt 走 stdin**，作为第一条记录 `{"id":"p0","type":"prompt","message":…}`（`PROMPT_ID` 固定 `p0`）。
- **stdout 逐行四类记录**（`handleLine`）：`message_end` 累加消息与 usage，并顺带证明 prompt 被接受；`agent_settled` 是**唯一**的 settle 信号（`settleFromAgent`）；`response` 的 `started` / `queued` 算接受，`handled` 表示「处理了 prompt 但没启动 run」，于是立刻失败；`extension_ui_request` 对 `DIALOG_METHODS`（select / confirm / input / editor）一律回 `{cancelled: true}`，因为被派发的子进程背后没有人。解析不了的行忽略，永不致命。
- **失败判定不看退出码**：`isFailedResult` 读 `timedOut` 与 `stopReason ∈ {error, aborted, timeout, unexpected exit}`，注释写明原因——rpc 下子进程可以在一轮失败后 exit 0，也可以在干净停下时非零退出。
- **每个等待有上限**（`DEFAULT_RUN_TIMINGS`）：prompt 接受 10 000 ms、abort 宽限 5 000 ms、退出宽限 5 000 ms、轮询 1 000 ms。
- **收尾顺序**（`finalize`）：清定时器（没有回调能竞争这次写）→ 注册表写终态 → 删控制文件 → 删临时 prompt → 关 stdin（「你可以走了」）→ 宽限期后 `killChildTree`。杀的是 `taskkill /T /F`，因为 MCP server 这类孙进程不会因父进程死而消失。

## 为什么换成这个

`CHANGELOG.md` 0.3.0 是这里唯一的权威：*"A sub-agent run is now a long-lived rpc child … it settles on `agent_settled`, closes stdin for an orderly exit, and is killed by tree when it ignores that. The reason is steering — the same change is what lets a run be redirected while it works."* `transport.ts` 的文件头补上另一半：*"There was no way to say anything to a child that was already thinking, so a stuck run could only be killed."*

所以「长驻」不是目的，是 steering 的前提：要对一个正在思考的子进程说一句话，通道就必须在 prompt 之后还开着；通道还开着，进程的生命周期就不再等于 run 的生命周期。这两件事是一件事。

`agent_settled` 是同一前提的推论。`-p` 模式下进程退出**就是**结束；rpc 模式下我主动关掉 stdin 让它退——它的退出是我要求的结果，不是它告诉我结论。而一个 rpc 子进程可以在一轮之后离开，却仍会被 retry、compact、steer。唯一能说「有结论」的是它自己发的 `agent_settled`。

证据是 `onResponse` 里 `handled` 那个分支：这个值表示子进程处理了 prompt 但没有启动 run。若沿用「退出即结束」，这里会一直等到 `agent_settled`——一个永远不会来的事件，只剩 15 分钟超时兜底。所以它直接 `killChildTree` 加失败。

## 代价

**一套自己维护的协议。** 四类记录、一个固定的 prompt id、四种必须自己回答的对话框方法、以及「未知记录忽略而不抛」的容错；全部对着一个会变的 Pi 版本，守着它的只有 `tests/subagent-rpc.test.ts`。

**`agent_settled` 是 Pi 的、没有版本号的契约。** 如果 Pi 改名、改语义、或不再发它，每一个派发的 run 都变成 `unexpected exit`——一个看起来像 agent 出错的失败模式。这是这个设计里最脆的一根梁。

**退出码变成装饰品。** `exitCode` 只作参考记录，于是任何外部 supervisor、任何「非零即失败」的直觉、任何 `&&` 链在这里都不适用；读者失去了唯一一个不需要读文档的信号。

**一个漏出来的面。** 往刚死的子进程写 stdin 会**异步**抛 `EPIPE`，`writeRecord` 的 `try` 抓不到，未处理的 `error` 事件会杀掉 Pi 会话（`.myflow/spec/harness/index.md` 的 gotcha 记录了发现它的探针就是这么崩的）。现在三条管道都挂了 `error` 监听，只记录、继续跑。

**错误处理更绕。** 因为永不抛，设置失败（写不出临时 prompt、`spawn` 抛了）必须返回一个**已经 settle 的失败结果**加一条失败的注册表条目——一次连 spawn 都失败的派发不能留下 `queued` 让面板一直显示。

**15 分钟默认上限是配套而不是独立决定。** 长驻子进程没有自然的结束点，所以必须给一个；「超时即杀掉、改动留在树里、什么都不回滚」意味着一次超时的 run 留下半成品工作树，下一次从那里开始。[灰度与回滚](../launch/rollback.md)把这条代价归到了回滚面那一格。

## 什么情况下我会改回去

1. **Pi 提供带版本承诺的结构化 settle 事件**：最脆的梁换成 Pi 保证，长驻仍会保留，因为 steering 还需要通道。
2. **Pi 提供进程内 sub-agent API**：不需要管道、协议、临时 system prompt 文件，「run 没结束」和「能对它说话」在同一层表达。那时整个 `transport.ts` 状态机应该消失——它是为了在没有这个 API 时把两件事拼起来才存在的。
3. **反向的警告信号**：一次 Pi 升级之后 `agent_settled` 的语义变了，而 `tests/subagent-rpc.test.ts` 依然绿着。那说明那个测试测的是**我的假设**，不是 Pi 的契约；我会先把 rpc 路径标成不可信，而不是改测试。
