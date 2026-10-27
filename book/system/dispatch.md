---
title: 子代理调度
---

# 子代理调度

## 职责

`myflow_subagent` 是主会话唯一能起子代理的地方，只回答"派什么"：哪个 agent、哪种模式、几条 prompt、哪个模型。**怎么跑**由 `transport.ts` 决定：拼 argv、写 stdin、读协议、判定结束、杀进程树。

工具描述里有一句承重的话：**子代理共享调用者的工作树**。它决定了后面的并行限制。

| 入参 | 取值 | 默认与约束 |
| --- | --- | --- |
| `agent` | `myflow-implement` / `myflow-check` / `myflow-research` | 默认 `myflow-implement`；`normalizeAgentName` 补 `myflow-` 前缀；必须能在 `.pi/agents/` 找到定义文件 |
| `prompt` / `prompts` | 字符串 / 字符串数组 | `prompts` 上限 `MAX_PARALLEL_PROMPTS`，作用在共享数组上，所以 `chain` 也受限 |
| `mode` | `single` / `parallel` / `chain` | 默认 `single`；`chain` 给下一条 prompt 追加 `Previous output:`，遇到第一个失败就停 |
| `model` / `thinking` | 模型引用、思考档位 | 调用参数 → agent 定义 → 调用者，`model:thinking` 后缀会被拆开 |
| `timeoutMs` | 毫秒 | `SUBAGENT_TIMEOUT_MS`，15 分钟；`0` 关闭 |

未知 agent 名不抛异常，而是返回一个列出已定义 agent 的工具结果，会话不中断。

## 触发点

调用链只有一条，全在主会话的一轮工具调用里：

1. 模型调 `myflow_subagent`，`execute` 拿到 `ctx.cwd`、`ctx.model` 与思考档位。
2. `discoverAgents` 读 `.pi/agents/*.md`，`resolveRunConfig` 定模型，`resolveActiveTaskStatus` 定 `task` 字段。
3. `queueGroup` 把**整次派发**作为一组 `queued` 写进注册表，然后才起第一个子进程——`chain` 里还没轮到的那条也已在盘上，看得见也停得掉。
4. `transport.ts` 的 `buildArgs` 拼出 `pi --mode rpc --no-session --approve`，按需追加 `--model`（或 `--thinking`）、`--tools a,b,c`、`--append-system-prompt <临时文件>`。
5. agent 正文写进 OS 临时目录下的 `mkdtemp` 目录，权限 `0o600`；prompt 本身不放进 argv，而是作为子进程 stdin 的第一条记录 `{"id":"p0","type":"prompt","message":…}`。

用 `--mode rpc` 而不是一次性的 `-p --mode json`，唯一理由是 stdin 要一直开着——转向和 abort 都从这条路进去（见[运行注册表与转向](./runs-and-steering.md)）。

## 读写哪些文件

| 位置 | 谁写 | 内容 |
| --- | --- | --- |
| `.myflow/.runtime/subagents/<runId>.json` | 派发方（`runs.ts`，`.tmp` + rename） | 注册表条目，起子进程前就已存在 |
| `.myflow/.runtime/subagents/<runId>.ctl.jsonl` | 任何会话 | 转向与 abort 命令，settle 时删除 |
| `.myflow/.runtime/subagent-logs/<agent>-<epochMs>.log` | 本 transport | 子进程原始输出，收到第一个字节才打开文件 |
| 系统临时目录 `myflow-subagent-*/prompt-<agent>.md` | 本 transport | agent 正文，settle 时删除 |

子进程侧读的是 `<task-context>`（由 `session_start` 注入）和注入的三个环境变量：`MYFLOW_AGENT_TYPE` 永远是 agent 名，`MYFLOW_CONTEXT_ID` 是父会话的 context key，`MYFLOW_WRITES_UNDER` 只在 agent 声明了作用域时才设——否则**显式删除**，于是继承来的旧值不可能悄悄限制一个没有作用域的写者。

## 不变量

**四次等待，每个都有上限。** `DEFAULT_RUN_TIMINGS` 写明四个数：prompt 被接受 ≤10 000 ms，abort 宽限 5 000 ms，关闭 stdin 后等退出 5 000 ms，控制文件轮询 1 000 ms。它们各自的含义不同：10 秒是"子进程有没有开始干活"，超时直接判 failed 并杀掉整棵树；5 秒是"它愿不愿意自己走"，超时由 `taskkill /T /F` 收场。用 `/T` 是因为普通 kill 会留下孙子进程（MCP server）继续握着句柄。

**结束信号只有一个。** `agent_settled` 是唯一让 run 进终态的事件。`message_end` 只累积消息，`agent_end` 不算结束——跑完一轮还可能有重试、压缩恢复和转向。

**退出码不作数。** `isFailedResult` 读的是 `timedOut` 和 `stopReason ∈ {error, aborted, timeout, unexpected exit}`。原因写在注释里：rpc 子进程可以在失败后退出 0，也可以在干净停下后退出非零，所以退出码只记录、不判断。

**`parallel` 要过写者门。** `isWriteCapable` 认为 tools 含 `write`/`edit` 的 agent 会写，**没有 `tools` 白名单的也算**。这样的 agent 如果 `hasWriteScope` 为假，`mode: "parallel"` 直接被拒。`hasWriteScope` 要求声明存在且 `isSafeWriteScope` 通过——空值、绝对路径、盘符、`..` 都判为不合格。结果就是 `myflow-implement` 和 `myflow-check` 一次一个，`myflow-research`（`writesUnder: research`）可以并行。这是**边界保证**，不是互斥保证：代码无法证明并行的几条 prompt 写的是不相交的文件，它只把爆炸半径缩到一个目录。

**超时不回滚。** 撞上限的 run 报告上限值、日志路径，并说明改动仍在工作树里、什么都没被撤销；唯一补救是重派一个更小的下一步。

## 一个最小走查

主会话派一个 `myflow-research` 去做调研：

1. `queueGroup` 写一条 `r-<epochMs>-<4hex>.json`，`status: "queued"`，`group: "g-…"`，`task` 是当前任务目录的项目相对路径。
2. `buildArgs` 得到 `pi --mode rpc --no-session --approve --tools read,write,find,grep,ls --append-system-prompt <tmp>/prompt-myflow-research.md`；环境里多了 `MYFLOW_AGENT_TYPE=myflow-research`、`MYFLOW_CONTEXT_ID=pi_…`、`MYFLOW_WRITES_UNDER=research`。
3. prompt 写进 stdin，`status` 变 `running`，`heartbeatAt` 开始每秒刷新；日志文件在收到第一段输出时创建。
4. 子进程要求弹选择框：`extension_ui_request` 就地答成 `{cancelled: true}`——派发出去的 run 背后没有人，阻塞在一个永远没人回答的对话框上是更坏的失败。
5. 它写 `research/<topic>.md`。若写到别处，子进程里的 `tool_call` 守卫按 `MYFLOW_WRITES_UNDER` 拒绝。
6. 子进程发 `agent_settled`，`finalize` 依次清定时器、注册表写终态、删 ctl 文件与临时 prompt、关 stdin，再留 5 秒等它自己退出。
7. `getResultOutput` 把最后一条 assistant 文本作为工具结果交回主会话。

## 常见误解

- **"退出码就是结论。"** 不是。结论来自 `agent_settled` 加 `stopReason`；`exitCode` 只写进注册表供人参考。
- **"`parallel` 意味着互斥。"** 它意味着"这些 run 的写都各自被限制在一个目录里"，不意味着它们不会改同一个文件。
- **"子代理有自己的工作树。"** 没有，共享同一棵树。需要真正分离的工作树，走 `/myflow-parallel` 的 `worktree.py`。
- **"10 秒是模型超时。"** 不是。它只覆盖"prompt 有没有被受理"这一段，模型随后想跑多久由 `timeoutMs` 管。
