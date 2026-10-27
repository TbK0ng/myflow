---
title: 这是什么
---

# 这是什么

## 先说 Pi

这本书里的所有机制都寄生在一个外部程序上，所以必须先认识它。

Pi（npm 包名 `@earendil-works/pi-coding-agent`）是一个极简、可扩展的编码代理外壳。它自己提供：一个交互式 TUI、print 与 JSON 两种非交互模式、一个 `pi --mode rpc` 的子进程模式，以及一组扩展 API —— 事件 hook、工具注册、斜杠命令、skill、prompt 模板、主题。

Pi 的 README 里有一句关键的话：它自带很强的默认值，但**故意不做子代理和 plan mode**。这个空缺就是 myflow 的全部工作范围。

myflow 是一个 Pi 扩展加一组配套脚本，它不重新实现 Pi：不解析模型输出，不管 tokenizer，不自己画界面。它只做三件事——**往会话里注入文本**、**拦截工具调用**、**把状态写成文件**。所有跨会话的能力都来自第三件事。

## 它由哪几块组成

| 块 | 真实路径 | 作用 |
| --- | --- | --- |
| Pi 扩展 | `.pi/extensions/myflow/index.ts` 与同目录的辅助模块；`background/` 7 个文件；`board/` 6 个文件 | 注册 8 个 hook、7 个工具、2 个斜杠命令 |
| Python 脚本 | `.myflow/scripts/task.py`、`worktree.py`、`channel.py`、`get_context.py`、`bg_runner.mjs` | 任务生命周期（12 个子命令）、并行 worktree（7 个）、通道运行时（10 个）、会话上下文、后台任务包装器 |
| 工作流文本 | `.myflow/workflow.md` | 三个阶段、带 `[required · once]` 标记的步骤表、4 个 `[workflow-state:*]` 块 |
| 交给模型的角色 | `.pi/agents/`（3 个子代理定义）、`.pi/prompts/`（3 个入口模板）、`.pi/skills/`（8 个 skill）、`.myflow/agents/`（2 个通道 peer） | 规定"谁在什么阶段做什么" |
| 规格树 | `.myflow/spec/index.md`、`harness/`、`guides/` | 契约、设计决定、已知坑，按区域分文件 |
| 发布载荷 | `tools/release-payload.json`、`tools/release.py`、`tools/INSTALL.md` | 把 `.pi/` 和 `.myflow/` 整棵树打包、校验、安装 |

## 一次任务长什么样

规划阶段的产物先落盘：`prd.md`，复杂任务再加 `design.md` 和 `implement.md`，以及用 `task.py add-context` 逐行挑出来的 `implement.jsonl` / `check.jsonl`。人点过头之后 `myflow_request_approval` 写下 `approval.json`，里面是计划文件字节的 `plan_hash`；`task.py start` 校验这个哈希、把状态改成 `in_progress`、并把会话指针指到这个任务上。

然后主会话用 `myflow_subagent` 派一个 `myflow-implement` 子进程。子进程一启动就收到按字节预算裁剪过的 `<task-context>`，不需要自己"回忆"上一轮谈了什么。实现完成，`myflow-check` 被 `agent_before_settle` 按住，直到 `.myflow/scripts/worktree.py verify` 跑通才允许收尾。最后 `task.py archive` 把状态改写成 `completed`，把目录移到 `.myflow/archive/<YYYY-MM>/<slug>`。

这条链上的每一步都读写磁盘上的具体文件，没有一步依赖"模型记得"。

## 它明确不是什么

- **不是模型，也不是 Pi 的分支。** 它是一款扩展加一堆脚本，Pi 升级后它可能就坏。
- **不是权限系统。** 只有一条 `writesUnder` 路径边界、一个确认对话框和一个 verify gate，没有 allow/deny/ask，也没有逐次批准；`bash` 按设计就是绕过路径边界的那扇门（见[`writesUnder` 是边界，不是锁](../design/write-scope.md)）。
- **子代理不独立。** 它们和调用者共用同一棵工作树，`write` / `edit` 被限定在声明的目录内，仅此而已。
- **不能搬到别的操作系统。** `index.ts` 在非 `win32` 平台上加载时直接抛错；`bg_runner.mjs`、`channel.py`、`worktree.py` 也各自拒绝启动。这不是没来得及支持，是删掉了没法测的代码路径（见[只支持 Windows + Git Bash](../design/windows-only.md)）。
- **依赖不是零。** 运行时需要 Node 内置模块、Pi、`python3`、Git Bash、`git`、`taskkill`。
- **不是产品。** 单用户、单机器。`tools/` 和 `tests/` 不随包发布，`book/`（就是这本书）也在载荷之外——`release-payload.json` 只选 `.pi` 和 `.myflow`。

一本书如果先讲清"边界在哪"，后面每个设计选择就不必再解释一遍动机。
