---
title: 一次会话的全景
---

# 一次会话的全景

## 职责

这一页回答一个问题：从 Pi 加载扩展，到进程退出，myflow 在哪些时刻被调用，每次被允许做什么，结果落在哪个文件上。后面九页都是这一条时间轴上的放大。

扩展加载时只做两件事：一句平台守卫（`index.ts` 的 `extension` 工厂，`process.platform !== "win32"` 直接 `throw`），然后注册 **8 个 hook**、7 个工具、2 个斜杠命令。从那以后它不再主动运行——每个 hook 都是 Pi 在固定时刻回调进来的一段函数，没被调用的部分等于不存在。

## 触发点：8 个 hook

顺序以 Pi 自己的生命周期为准（`docs/extensions.md` 的 run/turn 图）：`session_start` 一次，然后每一轮是 `input` → `before_agent_start` → 每个模型请求前 `context` → 每次工具调用 `tool_call`；`session_before_compact` 只在压缩时出现，`agent_before_settle` 在一次 run 收尾前出现，`session_shutdown` 在进程退出时出现。

| 时机 | hook | 能做什么 | 落盘 |
| --- | --- | --- | --- |
| 会话开始 | `session_start` | 解析项目根与 context key；主会话注入 `<session-context>` 再注入 `<task-context>`，子代理只注入 `<task-context>` 后直接 return | 只读；子进程 `get_context.py` 读 `.myflow/workflow.md`、`.myflow/.runtime/sessions/<contextKey>.json`、`git status` |
| 用户输入进入 | `input` | 读 `prompt_injection.skip_keyword`（默认 `no-myflow`），开始这一轮的 turn cache；`MYFLOW_SKIP_BREADCRUMB=1` 会让整个进程都不出现面包屑 | 只读 |
| run 启动 | `before_agent_start` | 从 turn cache 取出 `workflow-state` 文本，返回成一条 `display: false` 的 custom message | 只读 `turn-cache.ts` 读过的文件 |
| 每个模型请求前 | `context` | 重投影过期的 `<task-context>` / `<session-context>`，去重，按本轮是否跳过决定补上还是删掉面包屑 | 只读 |
| 每次工具调用 | `tool_call` | 四个守卫，只能 `{block: true, reason}`：子代理不许再派子代理、不许问用户/请求批准、不许管后台任务；声明了 `writesUnder` 的子代理只许写 `<active task>/<scope>/` | 只读 |
| 压缩前 | `session_before_compact` | 记一个内存时间戳，让面包屑在压缩后被重新注入 | 无 |
| run 收尾前 | `agent_before_settle` | 只对 `myflow-check`（或 `MYFLOW_VERIFY_GATE=1`）生效：跑 `.myflow/scripts/worktree.py verify`，失败就返回 `{continue: true, entries: [...]}` 重新推一轮，最多 2 次 | 子进程读 `.myflow/worktree.yaml` 的 `verify:`，写的是命令自己的产物 |
| 会话结束 | `session_shutdown` | 幂等；**不杀任何进程**，只报告本会话启动、此刻仍在跑的后台任务；`hasUI === false` 时完全静默 | 只读 `.myflow/.runtime/background/<taskId>.json` |

关键事实：**8 个 hook 没有一个直接写交付物**。所有写入都发生在注册的工具实现里（`myflow_subagent` → `.myflow/.runtime/subagents/<runId>.json`，`myflow_ask_user` → `questions.jsonl`，`myflow_request_approval` → `approval.json`，`myflow_bg_*` → `.myflow/.runtime/background/`）和模型自己跑的 Python 脚本里（`task.py`、`worktree.py`）。hook 只在读盘、裁剪文本、拦截调用。

## 四个 workflow-state 块何时出现

`.myflow/workflow.md` 里有 4 个块：`no_task`、`planning`、`in_progress`、`completed`。选哪个块只由一件事决定：会话指针 `.myflow/.runtime/sessions/<contextKey>.json` 的 `current_task` 指向的任务，其 `task.json` 的 `status` 字段。没有指针、指针指向 `.myflow/tasks/` 之外、或 `task.json` 读不出来，一律是 `no_task`。

注入路径有两条，这是必须记住的重复：

1. `before_agent_start` 把整段 `<workflow-state>…</workflow-state>` 外加 `<session-overview>` 作为一条 custom message 交给本轮；
2. `context` 在每次模型请求前检查最后一条 `workflow-state` 还在不在；不在（压缩吃了、被跳过逻辑删了）就补一条，本轮被跳过就把它删掉。

块解析要求开闭标签完全一致（`parse-workflow-state.ts` 的正则回引用了状态名），配对不一致的块被静默丢弃；找不到对应块时注入的是字面量 `Refer to workflow.md for current step.`，不是报错。turn cache 有效期 1500 ms，`input` 时失效，所以同一轮里反复调工具不会反复解析 `workflow.md`。

`<session-context>` 是另一份内容：`get_context.py` 把 4 个块全部列出，再附上 `CURRENT TASK:` 与 `GIT:` 两段（分支、脏文件数、最近提交）。它只在 `session_start` 和"活动任务或状态变了"时重建；子代理永远拿不到它。

## 一个最小走查

假设活动任务是 `portfolio-book`，状态 `in_progress`。

1. 启动会话：`session_start` 找到项目根，读出 context key，跑 `get_context.py` 注入 `<session-context>`，再用 `buildTaskContext` 注入 `<task-context>`，并把快照记成 `<taskDir>|in_progress`。
2. 用户发一句话：`input` 读 skip keyword，判定本轮不跳过，清空 turn cache。
3. run 启动：`before_agent_start` 从 cache 拿到 `[workflow-state:in_progress]` 那段文本，作为隐藏消息返回。
4. 模型决定调工具：`tool_call` 先过四个守卫。假设它调 `write`，而当前进程是声明了 `writesUnder: research` 的 `myflow-research`，路径不在 `<active task>/research/` 下——直接 blocked，原因写进工具结果，磁盘没有任何变化。
5. 出现压缩：`session_before_compact` 记时间戳；下一个模型请求前 `context` 发现最后一条 `workflow-state` 已被压掉，追加一条新的。
6. run 准备收尾：若当前进程是 `myflow-check`，`agent_before_settle` 跑 `npm run check`；失败则重新推一轮（带 `<verify-gate attempt="1/2">`）。
7. 退出：`session_shutdown` 只跑一次，列出本会话启动且仍在跑的后台任务，然后什么都不做。

## 常见误解

- **"hook 是一个状态机。"** 不是。myflow 没有"当前阶段"变量，阶段是 `task.json` 里的一个字符串，每个 hook 各自去读它。
- **"退出时会清理子进程。"** 不会，而且是故意的：后台任务是项目级的，必须比会话活得久（见[后台任务](./background-tasks.md)）。
- **"`context` hook 负责注入。"** 它主要负责**修**：把过期或被压缩弄丢的注入内容重新对齐，顺手去重。
- **"hook 顺序就是注册顺序。"** 注册顺序只是 `index.ts` 里的书写顺序；实际触发顺序由 Pi 的生命周期决定，`context` 每轮都会跑，`session_start` 只跑一次。
