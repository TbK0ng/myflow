---
title: 如果要重写
---

# 如果要重写

「重写」在这里不该被理解成换一套架构。绝大多数机制我会原样再写一遍——文件即状态、长驻 rpc 子进程、append-only 的控制文件、以哈希绑定的批准门。要改的是另一类东西：那些**靠约定而不是靠代码**成立的守卫，和那些**付了一半的账**。

## 会改的

**把 `MYFLOW_AGENT_TYPE` 发给 channel worker，或者删掉 channel 这条并行路径。** 现在 `.myflow/scripts/channel.py` 只设 `MYFLOW_SKIP_BREADCRUMB`，于是 `detectAgentType()` 返回 `null`，一个 channel worker 在 `index.ts` 的四道守卫眼里就是主会话。修法不是加一行环境变量：一旦它被当成子代理，`writesUnder` 守卫生效，而 worker 没有声明作用域，每次写入都会被拒绝，可 `reviewer` 的工作就是在范围内改代码。所以要么在 Python 启动器里复刻 transport 的整套环境注入（作用域、context key、agent 类型），要么承认这条路径没有独立守卫模型，把它删掉。我倾向于后者——真正的并行会话已经有 `worktree.py`，channel 提供的是"一个可以被叫醒的对话者"，而这套东西并不需要它去写文件。

**把 `done` / `completed` 从代码和文档里彻底删一次。** 现状是三处半：`workflow.md` 里有一个永远不会被注入的 `[workflow-state:completed]` 块，`tests/workflow-invariant.test.ts` 认证它，`status.ts` 的 `phaseForStatus` 还在映射历史状态，`.pi/prompts/myflow-continue.md` 还在把它写成可达。要么删掉这个块和它的测试映射，要么让 `finish` 真的写 `completed`、把「标记完成」和「移进归档」拆成两步。我会选前者——一个绿着的、保护死路的测试比没有测试更坏。

**给 `myflow_subagent` 的结果加一个上限。** 每条输入路径都有字节预算（`context-injection.ts` 的 `ContextBudget`），输出路径一个也没有：`getResultOutput` 原样返回子代理最后一条文本，`parallel` 最多把六份拼起来。一个话多的子代理可以一次往调度方上下文里灌进几万 token。超限就写一段说明加日志路径，和 `[myflow: truncated …]` 用同一种语气。

**把 `EXPECTED_COMMANDS` 扩到两条斜杠命令。** `tools/release.py` 里只有 `("myflow-status",)`，冒烟脚本只检查"缺了没有"，所以 `/mysubagents` 从发布包里消失不会有任何测试报红。这条改起来是字面意义上的一个元组，属于那种明知该改却没改的账。

**给后台任务加日志轮转与配额。** `.myflow/scripts/bg_runner.mjs` 用 `exec >> <log>` 一路追加，没有上限。这是唯一一处**写操作没有边界**的地方，和别处的字节预算放在一起看，不一致。

**把两套 pid 存活判定合成一套。** `background/registry.ts` 的 `isAlive` 用 `process.kill(pid, 0)`（`EPERM` 记为存活），`.myflow/scripts/worktree.py` 明确说这条路在本平台不可靠，改用 `ctypes` 调 `OpenProcess` / `GetExitCodeProcess`。同一个仓库对同一个问题有两个答案，而用弱那套的地方恰好是"要不要 `taskkill` 这个 pid"。合并不难，难的是承认它们不一致过。

**让 `myflow_subagent` 也用 `findProjectRoot(ctx.cwd)`。** `index.ts`、`ask.ts`、`approval.ts` 都先向上找根，只有派发路径直接把 `ctx.cwd` 当根。从子目录派发时注册表、控制文件和日志会落到子目录下的 `.myflow/.runtime/`，而 `/mysubagents` 读的是真根，于是那次 run 从面板上消失。改起来只是换个函数调用，但它是「一个概念一个实现」这条原则的反例。

**把 `SingleResult.usage` 落盘。** token 与 cost 已经在 `transport.ts` 的 `applyUsage` 里累加了，然后随工具调用一起消失。不需要成本系统，注册表条目里多一个字段就够了。

## 不会改的

**只支持 Windows + Git Bash。** 我不会为了显得通用而留一条从没跑过的 `else`。[论证篇](../design/windows-only.md)里那句话我仍然同意：一条分支只有在被真实执行时才算被支持，而我没有第二台机器去执行它。

**长驻 `pi --mode rpc` 子进程，靠 `agent_settled` 收尾。** 转向能力是从这个选择里长出来的，没有它就只能杀进程。[这一章](../design/rpc-child.md)的代价也一样成立：协议要自己维护，`agent_settled` 是 Pi 契约，退出码变成装饰。

**文件即状态，没有守护进程。** 我可能还是会这么做，因为"能在另一个终端里 `cat` 出来"这件事，比任何仪表盘都好用；代价是每秒心跳写盘和 30 秒的 `stale` 猜测，这两点我知道，也接受。[这一章](../design/state-on-disk.md)

**append-only 转向通道。** 调度方阻塞在自己的工具调用里时，磁盘上的追加文件是唯一还有控制流的路径。1 秒延迟和手写的容错（半个行不消费、坏行跳过计数）是这个设计的税，交得起。[这一章](../design/ctl-jsonl.md)

**[`writesUnder` 当边界而不是锁](../design/write-scope.md)，以及[拒绝优于降级](../design/refuse-not-degrade.md)。** 前者明确写着不管 `bash`，后者让工具在没把握时停下来而不是半工作。两条都会被误读成"更弱"，其实它们是把弱点写进文档：一个声称是沙箱的字符串检查，比一个说明自己是边界检查的字符串检查危险得多。

## 最后

左边那一栏的共同点不是"bug"，而是一件事：**守卫依赖约定**。环境变量由启动方决定，漏一个启动方就整类失效；状态靠人写进文档，删一处会留下三处；输出没有人量过，所以长得没有上限。右边的共同点相反：**代价被写下来了**。我的判断标准只有一条——下一个人能不能从代码和文档里读出"这里我付过账"。左边目前读不出来。
