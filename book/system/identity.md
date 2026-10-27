---
title: 三个身份：项目根、会话、任务
---

# 三个身份：项目根、会话、任务

## 职责

myflow 每做一次判断，都要先回答"我在哪个项目里""我是哪个会话""当前是哪个任务"。这三件事分别对应一个磁盘上的具体位置，混掉任何一个，症状都一样：任务明明存在，harness 说 `no_task`。

| 身份 | 回答的问题 | 落点 |
| --- | --- | --- |
| 项目根 | `.myflow/` 在哪 | 向上找到的目录本身 |
| 会话 context key | 我是哪个会话 | `.myflow/.runtime/sessions/<contextKey>.json` |
| 任务 slug | 当前做的是哪件事 | `.myflow/tasks/<slug>/`，指针里存项目相对路径 |

## 项目根

规则只有一条：从起点向上走，第一个含有 `.myflow/workflow.md` 的目录就是根。`workflow.md` 是必须的——`.myflow` 单独存在是任何目录都能带的标记，把家目录里一个游离的 `.myflow` 当成根，会静默改掉所有任务、会话和归档的去向。

这条规则有 5 份实现：扩展里的 `find-project-root.ts` 的 `findProjectRoot`，以及 `task.py`、`get_context.py`、`worktree.py`、`channel.py` 里各自一份 `_find_project_root`。四份 Python 版是复制而非 import：这些脚本要能单独拷进另一个项目运行，不能互相依赖。

差别值得知道：`findProjectRoot` 找不到时返回 `null`，扩展于是退化成"什么都不注入、什么都不拦"；Python 版找不到时把起始目录当作根。同一棵树、同一条规则，找不到时的失败姿态不同。

## 会话 context key

优先级三档，先命中先说：

1. `MYFLOW_CONTEXT_ID` 环境变量，非空则胜出；
2. `pi_<sanitizeKey(sessionId)>`，session id 来自 Pi 的 session manager；
3. `pi_transcript_<sha256 前 24 位>`，只有拿不到 session id 时才用 transcript 路径。

`sanitizeKey` 的规则是承重契约，不是随手写的：只保留 `[A-Za-z0-9._-]`，其余连续片段压成一个 `_`，去掉首尾的 `._-`，截到 160 字符，净化后为空就返回空串；把空串换成哈希的是上一层（`buildContextKey` 与 `deriveContextKey` 的 override 分支，用 `hashValue` 的 sha256 前 24 位）。`index.ts` 的 `sanitizeKey`、`task.py` 的 `_sanitize_key`、`get_context.py` 的 `_sanitize_key` 必须逐字节一致，否则同一个会话在 TypeScript 和 Python 两侧会指向两个文件。

shell 这一侧靠 `PI_SESSION_ID`：Pi 会把它注入 bash 环境，`task.py` 和 `get_context.py` 用同一个 id 拼出同一个 key。这就是为什么"模型在 TUI 里创建的任务"和"模型用 bash 创建的任务"会写进同一个会话指针文件。

`MYFLOW_CONTEXT_ID` 的唯一用途是**继承**：`myflow_subagent` 起子进程时把它设成父会话的 key（见 `transport.ts` 里注入子进程环境的那段），于是子代理读的是父会话的活动任务，而不是自己那份空的会话文件。

## 任务 slug

`task.py create` 用 `--slug`，或者 `_slugify(title)`：小写、非字母数字折叠成 `-`、去掉首尾 `-`，全空就是 `task`。目录是 `.myflow/tasks/<slug>/`，`task.json` 里也记一份 `slug` 字段。

会话指针 `current_task` 存的是项目相对路径（`.myflow/tasks/<slug>`），不是 slug。`task.py` 的 `_relative` 在路径离开项目时返回空串而**不是**绝对路径——绝对路径正是过去让一个项目外的任务被每轮重放的原因。

所有接受任务引用的子命令都过 `_resolve_task_dir`：slug 或路径都行，只要解析后仍在 `.myflow/tasks/` 内；绝对路径、`..` 逃逸、指向外面的符号链接一律返回 `None`，命令打印拒绝并退出 1。

## 不变量：一处定义，多处镜像

| 规则 | 唯一定义 | 镜像 | 违约后果 |
| --- | --- | --- | --- |
| 项目根 = 最近含 `workflow.md` 的祖先 | `find-project-root.ts` | 4 份 Python `_find_project_root` | 注入、任务、归档指向不同目录 |
| context key 净化 | `index.ts` 的 `sanitizeKey` | `task.py` / `get_context.py` 的 `_sanitize_key` | 两侧指向两个会话文件，任务看起来"丢了" |
| 状态字符串 | `task.py` 的三个写入点 | `workflow.md` 的 4 个块键、`status.ts` | 面包屑落进 fallback 文本 |
| 计划哈希 | `task.py` 的 `_plan_hash` | `approval.ts` 只读 `gate-info` 的结果 | 批准门永远判 stale |

镜像不是设计目标，是语言边界逼出来的：Python 脚本和 TypeScript 扩展不能共享一个函数。所以这里的正确性靠"改一处必须改全部"的纪律，而不是靠类型系统——这是[缺陷登记表](../honest/defects.md)里"文档漂移"那一类问题的结构性来源。

## 一处确认的分歧：`myflow_subagent` 用的是 `ctx.cwd`

`index.ts` 里每个 hook 都写 `findProjectRoot(ctx.cwd)`，即先向上找根；`ask.ts`、`approval.ts`、`board/index.ts` 和 `background/` 的四个工具也一样，都是 `findProjectRoot(ctx.cwd) ?? ctx.cwd`。`subagent.ts` 不是：它全文没有 `findProjectRoot`，`runOptions` 直接把 `projectRoot: ctx.cwd` 传下去，注册表用 `runsDir(ctx.cwd)`，活动任务用 `resolveActiveTaskStatus(ctx.cwd, contextKey)` 解析。而 `tool_call` 的写作用域守卫用的是第三个式子，`projectRoot ?? findProjectRoot(ctx.cwd) ?? ctx.cwd`。

从项目根启动会话时三者相等，看不出区别。在一个子目录里启动 Pi 再派发，差别就具体了：注册表条目、控制文件、日志全部落到 `<子目录>/.myflow/.runtime/` 下；`/mysubagents` 面板走 `findProjectRoot`，读的是真项目根那份注册表，于是它既看不见也停不掉这次 run；`resolveActiveTaskStatus(ctx.cwd, …)` 也找不到会话指针，条目里的 `task` 字段就是 `null`。

**这是读代码确认的分歧，不是靠一次实测派发观察到的。** 上面每个调用点都能直接打开核对，没有不可达分支、没有覆盖式回退；我没有在子目录里真跑过那次 run，所以这里只写代码决定的行为，不写观测到的落点。它之所以还停在"确认"而没修，是因为修它要决定哪个根是权威——那属于上面那张"一处定义，多处镜像"的表里的结构性问题，不是一处笔误。

## 常见误解

- **"context key 就是 Pi 的 session id。"** 它是 `pi_` 前缀加净化后的 id，且净化规则在两种语言里各有一份。
- **"目录名就是任务身份。"** harness 从不拿目录名当身份，它读 `task.json` 的 `status` / `title`。
- **"项目根只算一次。"** `index.ts` 在 `session_start` 算一次并缓存，其它 hook 只在缓存为空时补算；`myflow_subagent` 不读这个缓存。
