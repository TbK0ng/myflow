---
title: 为什么造它
---

# 为什么造它

Pi 的默认形态是一次会话、一个模型、一棵工作树。它会压缩上下文，但不会记得你两小时前划定的边界条件；它把工具调用结果留在 transcript 里，但没有哪个文件写着"这次改动的验证命令跑过了"。

myflow 存在的理由只有三条。每一条都对应一个具体机制和一个具体文件——如果某条在这棵树里找不到落点，它就不该出现在这一章。

## 一、会话会忘掉自己已经决定的事

新会话是一种失忆：`prd.md` 里写过的约束、上一轮否掉的方案、为什么选了这个接口，全会随上下文窗一起消失。主流的补法是"写得更详细一点"或者"让用户再说一遍"，两者都把责任推给人。

myflow 的做法是**把决定变成磁盘上的产物**，再在会话启动时把它们喂回去：

- `task.py create` 建出 `.myflow/tasks/<slug>/`，写 `task.json`，把 `implement.jsonl` / `check.jsonl` 播种成空文件，并在 `.myflow/.runtime/sessions/<contextKey>.json` 里记下 `current_task` 指针（只在指针为空时写，不会抢走正在进行的任务）。
- `session_start` 触发 `context-injection.ts` 的 `buildTaskContext`：把 `prd.md`、`design.md`、`implement.md`、`info.md` 以及清单里列出的文件**实体化**进 `<task-context>` 消息，不是只给路径让模型自己去读。
- 指针本身不可信也不怕：`turn-cache.ts` 的 `resolveActiveTaskStatus` 通过 `isTaskDirWithinTasks` 解析真实路径，`..` 逃逸或指向 `.myflow/tasks/` 之外的符号链接一律当作"没有任务"，而不是当作"任务坏了"。

结果是一个子代理启动时不需要任何历史对话：它拿到的就是被挑选过的那几份文件。

## 二、长跑会漂移

一次会话跑过压缩之后，模型对"现在是第几步、下一步该干什么"的记忆是最先消失的东西。主流做法是把流程写进系统提示词，代价是它变成一个静态的、永不过期也永不确定的段落。

myflow 改成**每轮重新注入一段状态**：

- `before_agent_start` 返回 `<workflow-state>`，内容由 `turn-cache.ts` 缓存（TTL 1500 毫秒，`input` 时失效），块本体存在 `.myflow/workflow.md`。
- 状态块按任务状态选：`no_task`、`planning`、`in_progress`、`completed` 四块。找不到对应块时退化成一句 `"Refer to workflow.md for current step."`，从不报错。`parse-workflow-state.ts` 要求开闭标签同名，不匹配就静默丢弃。
- `context` hook 会在每轮把过期的块重新投影（`projectCustomMessage`），`session_before_compact` 记下压缩时间戳，压缩后重新注入——这是"压缩完就不知道自己走到哪"的直接对策。

这一条也有出口：输入里带上 `no-myflow`（`escape-hatch.ts` 的 `shouldSkipWorkflowState`）就跳过当轮的面包屑，聊天不必被流程绑架。

## 三、没有证据链

代理跑完之后，"它做了什么"通常只剩两个来源：模型的自述，和一大坨 transcript。前者不可靠，后者不可读。

myflow 把证据拆成几份小文件，各自有唯一的写入者：

| 问题 | 落点 | 写入者 |
| --- | --- | --- |
| 派了谁、还活着吗 | `.myflow/.runtime/subagents/<runId>.json` | `runs.ts`（含 `pid`、`owner`、`heartbeatAt`、`steers[]`、`logPath`） |
| 它到底输出了什么 | `.myflow/.runtime/subagent-logs/<agent>-<epochMs>.log` | `transport.ts` |
| 问过用户吗 | `<task>/questions.jsonl` | `ask.ts`，只有 `via: "ui-select"` 且答案非空才算"问过" |
| 计划被批准了吗 | `<task>/approval.json` 的 `plan_hash` | `approval.ts` 或 `task.py approve` |
| 验证跑过吗 | `agent_before_settle` 的 verify gate | `index.ts`，失败时把输出塞回 `myflow-check`，最多两次 |
| 什么时候开始、什么时候收尾 | `task.json` 的 `started_at` / `archived_at` | `task.py` |

关键在于这些都是**别的进程能读的普通文件**，所以 `/mysubagents` 面板可以在另一个会话里管一个它没派发过的运行——不需要任何 IPC。

## 代价在哪

上述三条都不是免费的，而且这本书不打算把它们藏进脚注：

- 状态在磁盘上，就没有守护进程告诉你谁还活着。`runs.ts` 只能用 30 秒心跳**推断** `stale`，一个卡住的调度器和死掉的调度器在 30 秒内长得一样（见[文件即状态](../design/state-on-disk.md)）。
- 每轮注入意味着两处注入路径（`session_start` 与 `context`）要一直同步，也意味着压缩之后有一个回合的窗口——那正是[拒绝优于降级](../design/refuse-not-degrade.md)那一章要结的账。
- 证据链意味着 `.myflow/.runtime/` 只增不减；后台任务的日志没有轮转（见[后台任务](../system/background-tasks.md)）。

换句话说，这一章解释的是**动机**，那些代价的账本在[论证篇](../design/windows-only.md)的每一页末尾。
