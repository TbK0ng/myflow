---
title: 术语表
---

# 术语表

这 32 个词在书里反复出现，每个都有一个"看起来像、其实不是"的邻居。定义只给本书用到的那一层；完整契约在[文件地图](./file-map.md)指到的文件里。

### 项目根

向上走，第一个含 `.myflow/workflow.md` 的目录。只看 `.myflow` 不够——游离的 `.myflow` 也能把根骗走。

出现于 [三个身份：项目根、会话、任务](../system/identity.md)、[上下文注入](../system/context-injection.md)。

### context key

一个会话在磁盘上的身份，形如 `pi_<净化后的 session id>`；`MYFLOW_CONTEXT_ID` 非空时覆盖它。它同时是 `.myflow/.runtime/sessions/<contextKey>.json` 的文件名。

出现于 [三个身份](../system/identity.md)、[运行注册表与转向](../system/runs-and-steering.md)。

### 任务 slug

任务目录名，来自 `create --slug` 或 `_slugify(title)`。harness 从不拿目录名当身份，读的是 `task.json` 里的字段。

出现于 [任务生命周期与 `task.py`](../system/task-lifecycle.md)。

### hook

Pi 在固定时刻回调进扩展的一段函数，myflow 注册了 8 个。没有一个直接写交付物。

出现于 [一次会话的全景](../system/overview.md)。

### tool（注册工具）

模型可以调用、扩展负责实现的能力，共 7 个。写交付物的只有工具实现和 Python 脚本。

出现于 [一次会话的全景](../system/overview.md)、[命令速查](./commands.md)。

### 斜杠命令

用户输入、不经过模型的命令，共 2 个：`/myflow-status` 与 `/mysubagents`。

出现于 [`/mysubagents` 面板](../system/board.md)、[命令速查](./commands.md)。

### sub-agent run

一次派发产生的一个 `pi` 子进程，加它在磁盘上的三件记录：注册表条目、控制文件、日志。"run" 指这次执行，不指 agent 定义。

出现于 [子代理调度](../system/dispatch.md)、[长驻 rpc 子进程](../design/rpc-child.md)。

### dispatch（派发）

主会话调 `myflow_subagent` 起子进程这件事。只有主会话能做，子代理里再调会被 `tool_call` 拦下。

出现于 [子代理调度](../system/dispatch.md)。

### settle

一次 run 进入终态的那一刻。唯一触发事件是子进程的 `agent_settled`，不是进程退出；退出码只记录不判断。

出现于 [长驻 rpc 子进程](../design/rpc-child.md)、[子代理调度](../system/dispatch.md)。

### steer（转向）

run 还在跑时给它补一句话。写进 `<runId>.ctl.jsonl`，由派发方每秒转发进子进程 stdin。

出现于 [运行注册表与转向](../system/runs-and-steering.md)、[append-only 的转向通道](../design/ctl-jsonl.md)。

### registry（注册表）

`.myflow/.runtime/subagents/<runId>.json`，一个 run 一个文件，只有派发方写。`running` 是被相信的，`stale` 是读者按 30 秒心跳推断的显示状态，不落盘。

出现于 [运行注册表与转向](../system/runs-and-steering.md)、[文件即状态](../design/state-on-disk.md)。

### ctl

`<runId>.ctl.jsonl` 的简称：append-only 的控制文件，只有 `steer` 与 `abort` 两种命令。读取用字节偏移，不消费没有换行结尾的半行。

出现于 [append-only 的转向通道](../design/ctl-jsonl.md)。

### workflow-state block

`.myflow/workflow.md` 里被 `[workflow-state:STATUS]` 包起来的一段文本，每轮作为隐藏消息注入，块键就是任务状态。共 4 个，开闭标签必须完全一致。

出现于 [一次会话的全景](../system/overview.md)、[拒绝优于降级](../design/refuse-not-degrade.md)。

### plan hash

`sha256` 覆盖 `prd.md` / `design.md` / `implement.md` 的文件名与原始字节，唯一实现是 `task.py` 的 `_plan_hash`。改任何一个计划文件，已批准的哈希就失效。

出现于 [用哈希锁住计划](../design/plan-hash.md)。

### approval gate（计划批准门）

`task.py start` 之前的强制检查：`approval.json` 的 `plan_hash` 必须等于当前计划哈希，且至少有一条被回答的选择题。它是防止遗忘的同意记录，可以被绕开，不是一道强制边界。

出现于 [计划批准门](../system/approval-gate.md)、[用哈希锁住计划](../design/plan-hash.md)。

### manifest（jsonl 清单）

`implement.jsonl` / `check.jsonl`，每行一条 `{file, reason}`，只能用 `task.py add-context` 写。`create` 把它们播种成空文件，`start` 拒绝启动没人策展的。

出现于 [任务生命周期与 `task.py`](../system/task-lifecycle.md)、[字节预算](../design/context-budgets.md)。

### artifact

任务目录里的四份固定文档：`prd.md`、`design.md`、`implement.md`、`info.md`。它们先于清单进预算，所以预算紧张时先牺牲的是清单。

出现于 [上下文注入](../system/context-injection.md)、[字节预算](../design/context-budgets.md)。

### curated context（策展上下文）

规划阶段逐行挑进 jsonl 的规格与源码。是"被挑过的"而不是"被检索到的"，这正是它和向量检索的分界。

出现于 [字节预算，而不是塞满 prompt](../design/context-budgets.md)。

### omission notice

预算不足时留下的一行字面量，形如 `[myflow: omitted <path> (<n> bytes) — <reason>]`。它是通知不是错误：文件仍在磁盘上，模型得自己去读。

出现于 [上下文注入](../system/context-injection.md)。

### writesUnder

agent 定义 frontmatter 里的字段，声明该 agent 只写 `<active task>/<dir>/`。它只拦 `write` 与 `edit`，`bash` 按设计绕过它——边界，不是锁。

出现于 [`writesUnder` 是边界，不是锁](../design/write-scope.md)。

### active task（活动任务）

会话指针 `current_task` 指向的任务目录。`writesUnder` 的判定基准、派发 prompt 的第一行、注册表条目的 `task` 字段都以它为准。

出现于 [`writesUnder` 是边界，不是锁](../design/write-scope.md)、[子代理调度](../system/dispatch.md)。

### verify gate

`agent_before_settle` 里的一段：`myflow-check`（或带 `MYFLOW_VERIFY_GATE=1` 的进程）收尾前必须让 `.myflow/worktree.yaml` 的 `verify:` 命令跑通，最多重推 2 次。它只和配置里那几命令一样强。

出现于 [一次会话的全景](../system/overview.md)、[发布载荷与安装](../system/release.md)。

### `.myflow/spec` 三层

`index.md` 是路由，`harness/index.md` 是区域契约，`guides/index.md` 是"怎么判断什么为真"的思考清单。同一句话仍可能写在五处，这是主动接受的维护债。

出现于 [这是什么](../intro/what-is-myflow.md)、[拒绝优于降级](../design/refuse-not-degrade.md)。

### release payload（发布载荷）

随包发布的 `.pi/` 与 `.myflow/` 整棵树，减去机器状态、任务历史与本仓库的 `worktree.yaml`。清单只有一个来源 `tools/release-payload.json`。

出现于 [发布载荷与安装](../system/release.md)、[文件地图](./file-map.md)。

### `dist` 产物

`release.py` 的 `build()` 写出的 `dist/myflow-<version>/` 目录加同名 zip，目录名里的版本取自 `package.json`。它**不进版本库**（`dist/` 在 `.gitignore` 里），所以它是本机状态：换台机器 clone 下来是空的，而 tag 还在。

出现于 [构建、发布、更新、版本](../launch/delivery.md)、[灰度与回滚](../launch/rollback.md)。

### 版本标记

安装树里用来回答"我装的是哪一版"那个字段。**它现在不存在**：载荷里没有 version 文件，`INSTALL.md` 明确要求不要把 `RELEASE.md` 复制进目标项目。缺它的代价是回滚变成猜测。

出现于 [灰度与回滚](../launch/rollback.md)、[如果它是一个产品](../launch/if-it-were-a-product.md)。

### 可重建（rebuildable）

从某个 tag 的树重新跑一次 `release.py --out`，得到一份**内容等价**的载荷；字节不一定相同，因为 epoch 与 deflate 输出都不保证。它和「可回滚」差两件事：取不回当初的字节，也没有东西替你切换版本。

出现于 [灰度与回滚](../launch/rollback.md)、[这个项目是哪一类](../launch/positioning.md)。

### 回滚面（rollback surface）

一个发布物能退回到哪里、退不回哪里。这里它只到「重新构建并重新安装上一版」为止，因为产物不留存、安装处没有版本标记。

出现于 [灰度与回滚](../launch/rollback.md)、[如果它是一个产品](../launch/if-it-were-a-product.md)。

### 灰度（canary）

把新版本先放给一部分使用者，观察之后全量。两个前提是「有那一部分人」与「能观察他们」——这个项目两个都没有，所以它是**不存在**，而不是一个待办。

出现于 [灰度与回滚](../launch/rollback.md)、[这个项目是哪一类](../launch/positioning.md)。

### 埋点（instrumentation）

主动造数据、发到一个以后能查的地方：计数、事件、耗时。这里一行都没有。这里做的是反过来的事：每个动作先在磁盘上留一份，指标是事后对这些文件做的算术。

出现于 [埋点就是运行留痕](../launch/observability.md)、[三条真实事故的排障走查](../launch/operating-the-tree.md)。

### 可观测性（observability）

出事了能不能沿一条身份线索找到现场。这里只有 **5 类 id**（context key、`runId`、group id、`bg taskId`、plan hash）——**没有 exception id，也没有跨进程 trace**，而被派发的子代理是 `--no-session`，连自己的会话 id 都没有。

出现于 [埋点就是运行留痕](../launch/observability.md)、[运行注册表与转向](../system/runs-and-steering.md)。

### 事故复盘（postmortem）

对一个真实发生过的故障，按六段写下来：现象 / 从哪个 id 起手 / 沿哪个文件查 / 根因 / 修复 / 现在怎么更早发现。它和「教训」的区别是每条都能指到文件与字段。

出现于 [三条真实事故的排障走查](../launch/operating-the-tree.md)、[已知缺陷登记表](../honest/defects.md)。
