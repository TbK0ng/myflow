---
title: 任务生命周期与 task.py
---

# 任务生命周期与 task.py

## 职责

把一个需求变成磁盘上一个目录、三个状态、一次移动。`.myflow/scripts/task.py`（stdlib，无第三方依赖）是任务目录的唯一写入者；另有两个文件不由它写——`questions.jsonl` 由 `myflow_ask_user` 追加，`approval.json` 由 `myflow_request_approval` 或 `task.py approve` 写。

## 12 个子命令

| 子命令 | 一句话 | 磁盘效果 |
| --- | --- | --- |
| `create <title> [--slug] [--parent]` | 建任务目录 | 写 `task.json`（`status: planning`）＋ 空的 `implement.jsonl` / `check.jsonl`；会话指针为空时才指向它 |
| `start <task>` | 过两道门，激活任务 | `status: in_progress`、`started_at`、会话指针指向它 |
| `current [--source] [--json]` | 打印活动任务 | 只读 |
| `archive <task>` | 完结并归档 | `status: completed`、`finished_at`、`archived_at`；目录移到 `.myflow/archive/<YYYY-MM>/<slug>/`；清掉所有指向它的会话指针 |
| `add-subtask <parent> <child>` | 连父子 | 只改子任务的 `parent` 字段 |
| `finish` | 清本会话指针 | 只改会话文件，不动 `task.json` |
| `add-context <task> <implement\|check> <path> "<why>"` | 往清单追加一行 | 追加到对应的 `.jsonl` |
| `plan-hash <task>` | 打印计划哈希 | 只读（唯一的哈希实现） |
| `gate-info <task>` | 打印批准门快照 | 只读，一行 JSON |
| `approve <task>` | 人在终端里批准 | 写 `approval.json` |
| `validate <task>` | 检查清单的可读性 | 只读（是报告器，不是门） |
| `list [--status] [--json]` | 列出任务 | 只读 |

## 三个状态，三个写入点

| 状态 | 唯一写入者 | 同时发生的事 |
| --- | --- | --- |
| `planning` | `create` | 目录出现，清单被播种成空文件 |
| `in_progress` | `start` | 指针指向它，`started_at` 落盘 |
| `completed` | `archive` | 目录离开 `tasks/`，指针被清 |

没有 `done`。这个字符串不只是元数据：它是 `<workflow-state:STATUS>` 块的键，写一个 `workflow.md` 里不存在的状态等于让模型拿到 fallback 文本。

## `start` 会拒绝什么

四道检查，按代码顺序：

1. **清单门**：`implement.jsonl` / `check.jsonl` 存在但一行可用条目都没有 → 拒绝。文件**不存在**不设门，因为那意味着这套安装没有子代理清单，而不是"清单忘了填"。`create` 会播种空文件，所以正常流程一定撞上这道门。
2. **没有计划文件**：`prd.md` 缺失 → 拒绝，因为没有任何东西可批准。
3. **批准状态不是 `approved`**：`_approval_report` 给出 5 种状态——`approved`、`stale`（批准过但之后计划被改）、`missing`、`invalid`（文件不可解析）、`unhashable`（计划文件读不出来）。只有第一种放行。
4. **零个已回答的选择题**：即使 `approval.json` 哈希匹配，也再数一遍 `questions.jsonl`——只有 `via: "ui-select"` 且 `answer` 非空的行才算。这道后备检查是故意的：写批准的那一侧会拒绝没问过用户的情况，但**放行**的那一侧不能依赖写入方诚实。

两个口子都是明知故犯，都会留痕：

| 参数 | 跳过什么 | 留下的证据 |
| --- | --- | --- |
| `--allow-empty-context` | 清单门 | 无（只在 stderr 说明） |
| `--allow-unapproved` | 整个计划门，包括数问题 | `task.json` 里 `started_without_approval: true` |

## `add-context` 写进清单的是什么

每行一个 JSON 对象，注入时按行物化：

```json
{"file": ".myflow/spec/index.md", "reason": "项目约定入口"}
{"file": ".pi/extensions/myflow/transport.ts", "reason": "子进程传输层"}
{"file": "docs/adr/", "type": "directory", "reason": "全部架构记录"}
```

目录会补尾斜杠并带 `type: "directory"`；路径必须是项目相对（或存在的绝对路径），找不到就报错退出；同一路径重复添加只打印一行警告、返回 0，不写第二行。这套清单的唯一写入入口就是这条命令——手改文件也不会立刻坏，但 `start` 的计数和 `validate` 的检查都按同样的行格式判读。

## 一个最小走查

```bash
python3 .myflow/scripts/task.py create "新增 X" --slug add-x
python3 .myflow/scripts/task.py add-context .myflow/tasks/add-x implement .myflow/spec/index.md "项目约定入口"
python3 .myflow/scripts/task.py add-context .myflow/tasks/add-x check .myflow/spec/index.md "项目约定入口"
```

两个清单各要至少一行，因为 `create` 把两个都播种成了空文件，而 `start` 对存在的空清单一律拒绝。此时目录里是 `task.json`（`planning`）、`prd.md`、两个各一行的 jsonl。然后人点头：

```bash
python3 .myflow/scripts/task.py approve .myflow/tasks/add-x   # 需要 tty，且已有一个已回答的选择题
python3 .myflow/scripts/task.py start .myflow/tasks/add-x
```

`start` 打印 `started: .myflow/tasks/add-x`。此后的每一轮，扩展读会话指针、读 `task.json`、选 `[workflow-state:in_progress]` 块注入。

做完之后：

```bash
python3 .myflow/scripts/task.py archive .myflow/tasks/add-x
```

目录变成 `.myflow/archive/<YYYY-MM>/add-x/`，`status` 是 `completed`，指针被清回 `null`——所以下一个 `session_start` 看到的是 `no_task`，而不是一个已经归档的旧任务。

## 常见误解

- **"`start` 之后子代理能读整个仓库。"** 它只拿到任务 artifact 加上清单里那几行引用的文件，其余靠它自己用 `read`/`grep` 去开。
- **"`validate` 不通过就没法 `start`。"** `validate` 是报告器；`start` 自己重算清单和哈希，不读 `validate` 的结论。
- **"`archive` 会删除任务。"** 只是移动，`archive/` 里的内容随代码一起提交。
- **"`create` 会抢占会话指针。"** 只在指针为空时写；已经有活动任务时新建第二个任务不会劫持当前会话。
