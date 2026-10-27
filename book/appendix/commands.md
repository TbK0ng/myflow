---
title: 命令速查
---

# 命令速查

示例只给形状，不列全部 flag；真要用，`python3 .myflow/scripts/<script>.py <sub> --help` 是权威。工具那一组是模型看到的 JSON 参数，不是 shell 命令。

## 斜杠命令（2 个）

| 命令 | 作用 | 最小调用 |
| --- | --- | --- |
| `/myflow-status` | 打印活动任务、工作流阶段、批准状态、git 状态；不调模型 | `/myflow-status` |
| `/mysubagents` | 三个视图（`board` 只读 / `tree` / `background`）管理 run 与后台任务 | `/mysubagents tree` |

## 工具（7 个）

| 工具 | 作用 | 最小参数 |
| --- | --- | --- |
| `myflow_subagent` | 派发子代理：`single` / `parallel` / `chain`；只有主会话能调 | `{ "agent": "myflow-research", "prompt": "…" }` |
| `myflow_ask_user` | 提一个 2–4 选项的问题并追加 `questions.jsonl` | `{ "header": "Scope", "question": "…", "options": ["A", "B"] }` |
| `myflow_request_approval` | 请求批准当前计划，确认后才写 `approval.json` | `{}` |
| `myflow_bg_start` | detach 一条命令，返回 `id` 与 `pid`；`cwd` 必须在项目根内 | `{ "command": "npm run dev" }` |
| `myflow_bg_output` | 读输出：`delta` 按本会话光标推进，`tail` 不推进 | `{ "task_id": "bg-…" }` |
| `myflow_bg_list` | 列出全部后台任务，顺手自愈已消失的进程 | `{}` |
| `myflow_bg_stop` | 杀掉任务整棵进程树并复查 pid 消失 | `{ "task_id": "bg-…" }` |

## `task.py`（12 个子命令）

| 子命令 | 作用 | 最小调用 |
| --- | --- | --- |
| `create` | 建任务目录、`task.json`、空的两份 jsonl | `create "标题" --slug my-task` |
| `start` | 过两道门后激活：状态 `in_progress` + 写会话指针 | `start .myflow/tasks/my-task` |
| `current` | 打印会话指针指向的任务（`--source` 说明来源） | `current --json` |
| `finish` | 清空会话指针，不改状态 | `finish` |
| `archive` | 改写成 `completed`，移到 `archive/<YYYY-MM>/` | `archive .myflow/tasks/my-task` |
| `add-subtask` | 把子任务挂到父任务上 | `add-subtask .myflow/tasks/p .myflow/tasks/c` |
| `add-context` | 往 `implement.jsonl` / `check.jsonl` 追一条策展条目 | `add-context .myflow/tasks/my-task implement src/a.ts "入口"` |
| `plan-hash` | 打印当前计划的 sha256（唯一实现） | `plan-hash .myflow/tasks/my-task` |
| `gate-info` | 一行 JSON 的只读批准门快照 | `gate-info .myflow/tasks/my-task` |
| `approve` | 从人类终端批准当前计划 | `approve .myflow/tasks/my-task` |
| `validate` | 检查两份清单是否有策展条目 | `validate .myflow/tasks/my-task` |
| `list` | 列出任务（`--status` / `--json`） | `list --status in_progress` |

`start` 的两个逃生门：`--allow-empty-context`、`--allow-unapproved`，两者都会把"我知道我在跳过什么"写进 `task.json`。

## `worktree.py`（7 个）

| 子命令 | 作用 | 最小调用 |
| --- | --- | --- |
| `create` | 建一个带独立分支的 git worktree | `create exp-1 --branch exp/1` |
| `list` | 列出记录过的 worktree 会话 | `list --json` |
| `remove` | 移除一个会话（`--force` 强删） | `remove exp-1` |
| `prune` | 清掉已被删除路径的 worktree 元数据 | `prune` |
| `start` | 建 worktree 并在其中跑 `pi` | `start exp-1 --prompt "…"` |
| `verify` | 跑 `.myflow/worktree.yaml` 里的 `verify:` 命令 | `verify` |
| `config` | 打印生效的 worktree 配置 | `config --json` |

## `channel.py`（10 个）

| 子命令 | 作用 | 最小调用 |
| --- | --- | --- |
| `create` | 建一个通道（`--scope project\|global`） | `create chat` |
| `list` | 列出通道（`--all` 含全局桶） | `list --all` |
| `send` | 追加一条消息，必须有 `--as` | `send chat --as me "看下这个"` |
| `messages` | 读消息（`--since` / `--json` / `--raw`） | `messages chat --since 3` |
| `wait` | 等一条完成事件（默认 `--kind done`） | `wait chat --from reviewer` |
| `spawn` | 起一个 runtime agent worker | `spawn chat --agent reviewer` |
| `workers` | 列出已起的 worker | `workers --json` |
| `kill` | 停掉 worker（`--all` 全停） | `kill chat --all` |
| `rm` | 删通道（`--force` 先停 worker） | `rm chat` |
| `prune` | 清掉死 worker、停掉空闲的 | `prune` |

## `release.py`

| 调用 | 作用 |
| --- | --- |
| `python tools/release.py --check` | 只校验清单与载荷，不产出文件 |
| `python tools/release.py --out dist` | 产出 `dist/myflow-<version>/` 与 `.zip` |
| `python tools/release.py --out dist --verify` | 同上，再解压到临时项目跑冒烟检查（`--verify` 必须配 `--out`） |
| `python tools/release.py --release patch` | 改版本、写 CHANGELOG、检查、构建、验证、commit、打 tag |
| `python tools/release.py --release patch --yes` | 再额外推送 commit 与 tag |
| `python tools/release.py --release minor --dry-run` | 打印将要发生的事，不写任何文件 |

`--check` / `--out` / `--release` 三选一，脚本自己会拒绝其它组合；版本号只有一个来源：`package.json`（现在是 `0.3.0`）。

要读代码找实现时，[文件地图](./file-map.md)是这张表的路由；要弄清某个词的确切含义，回[术语表](./glossary.md)。
