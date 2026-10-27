---
title: 文件地图
---

# 文件地图

一个子系统一行，路径全部相对仓库根。读某一章卡住时，先在这里找到文件，再去读它的头部注释——那几行通常就是该文件自己的设计说明。

| 子系统 | 文件 | 一句话职责 |
| --- | --- | --- |
| 扩展 / 入口 | `.pi/extensions/myflow/index.ts` | `extension()` 工厂：平台守卫、8 个 hook、注册 7 个工具与 2 个命令、`evaluateWriteScope`、verify gate |
| 扩展 / 类型 | `.pi/extensions/myflow/pi-coding-agent.d.ts` | 手写的 Pi 扩展 API 类型子集，只有 `import type`，运行时不引入依赖 |
| 扩展 / agent 发现 | `.pi/extensions/myflow/agents.ts` | 从 `.pi/agents/*.md` 读 frontmatter；`isSafeWriteScope` / `isWithinWriteScope` 两个路径谓词 |
| 扩展 / 派发工具 | `.pi/extensions/myflow/subagent.ts` | `myflow_subagent` 的入参、agent 与模型解析、并行写者门、`queueGroup` |
| 扩展 / 传输 | `.pi/extensions/myflow/transport.ts` | 一个 run 的 rpc 子进程：拼 argv、写 stdin、读协议、按 `agent_settled` 结算、限时与杀树 |
| 扩展 / 控制通道 | `.pi/extensions/myflow/ctl.ts` | `<runId>.ctl.jsonl` 的追加，与按字节偏移的增量读取 |
| 扩展 / 运行注册表 | `.pi/extensions/myflow/runs.ts` | `<runId>.json` 的读写、`displayStatus` 的 stale 推断、分类与清理 |
| 扩展 / 上下文注入 | `.pi/extensions/myflow/context-injection.ts` | `buildTaskContext`：artifact 与 jsonl 的读取顺序、三层字节预算、trusted roots、omission notice |
| 扩展 / 每轮状态 | `.pi/extensions/myflow/turn-cache.ts` | 活动任务解析、`workflow-state` 组装、1500 ms 缓存 |
| 扩展 / 跳过关键词 | `.pi/extensions/myflow/escape-hatch.ts` | 读 `prompt_injection.skip_keyword`，判定本轮是否抑制面包屑 |
| 扩展 / 状态报告 | `.pi/extensions/myflow/status.ts` | `/myflow-status` 的数据与措辞，不调模型 |
| 扩展 / 提问工具 | `.pi/extensions/myflow/ask.ts` | `myflow_ask_user`：一次选择、追加 `questions.jsonl`、无 UI 时不编造答案 |
| 扩展 / 批准工具 | `.pi/extensions/myflow/approval.ts` | `myflow_request_approval`：四项前置检查、从 `gate-info` 取数、只在确认后写 `approval.json` |
| 扩展 / 项目根 | `.pi/extensions/myflow/find-project-root.ts` | 向上找 `.myflow/workflow.md`，找不到返回 `null` |
| 扩展 / 块解析 | `.pi/extensions/myflow/parse-workflow-state.ts` | 用回引用的正则解析 `[workflow-state:STATUS]` 块，配对不一致就丢弃 |
| 后台 / 注册入口 | `.pi/extensions/myflow/background/index.ts` | 四个 `myflow_bg_*` 工具的注册与再导出，本身不做逻辑 |
| 后台 / 磁盘层 | `.pi/extensions/myflow/background/registry.ts` | 条目、pid、exit、cursor 的读写；`resolveStatus` 的状态优先级；prune |
| 后台 / 共通 | `.pi/extensions/myflow/background/tools.ts` | 注册管道、子代理拒绝文案、`cwd` 围栏 |
| 后台 / start | `.pi/extensions/myflow/background/start.ts` | 确认对话框 → 写 `starting` → detach `bg_runner.mjs` → 回写 pid |
| 后台 / output | `.pi/extensions/myflow/background/output.ts` | 每会话读光标：`delta` / `tail` / `peek`、`wait_ms`、旋转后重置 |
| 后台 / list | `.pi/extensions/myflow/background/list.ts` | 列出全部条目；唯一会把自愈后状态写回的工具 |
| 后台 / stop | `.pi/extensions/myflow/background/stop.ts` | `taskkill /F /T` 杀整棵树，并复查 pid 真的消失 |
| 面板 / 命令 | `.pi/extensions/myflow/board/index.ts` | `/mysubagents` 命令与面板组件；唯一在运行时动态 import `pi-tui` 的文件 |
| 面板 / 数据 | `.pi/extensions/myflow/board/state.ts` | 两个注册表 → 一个 `BoardState`，`now` 作参数传入 |
| 面板 / 渲染 | `.pi/extensions/myflow/board/render.ts` | 纯渲染：`(state, ctx) => string[]`，不碰时钟与文件 |
| 面板 / 按键 | `.pi/extensions/myflow/board/keys.ts` | 键 → `Action` 的 reducer，从不执行动作 |
| 面板 / 动作 | `.pi/extensions/myflow/board/actions.ts` | 执行 `Action`：写控制行或注册表，不持内存句柄 |
| 面板 / 转录 | `.pi/extensions/myflow/board/transcript.ts` | 日志 JSONL → 可读行（thinking 折成一行，工具结果截断） |
| 脚本 / 任务 | `.myflow/scripts/task.py` | 12 个子命令；计划哈希与批准门的唯一执行方 |
| 脚本 / 并行会话 | `.myflow/scripts/worktree.py` | 7 个子命令；git worktree 注册表与 `verify:` 命令执行 |
| 脚本 / 通道 | `.myflow/scripts/channel.py` | 10 个子命令；项目级事件日志、worker 生成与等待 |
| 脚本 / 会话上下文 | `.myflow/scripts/get_context.py` | 4 个状态块 + 活动任务 + git 状态，只输出不写入 |
| 脚本 / 后台包装器 | `.myflow/scripts/bg_runner.mjs` | 被 detach 的就是它：解析 shell、跑命令、自己写 `.exit` 与 `.pid` |
| 角色 / 子代理 | `.pi/agents/myflow-{implement,check,research}.md` | 3 份定义：工具白名单、可选模型、可选 `writesUnder`、系统提示正文 |
| 角色 / 通道 peer | `.myflow/agents/{architect,reviewer}.md` | 2 个通道 runtime worker 的角色；`reviewer` 的启动器会设 `MYFLOW_VERIFY_GATE` |
| 入口提示 | `.pi/prompts/myflow-{continue,finish-work,parallel}.md` | 3 个模板：续做当前任务、收尾归档、另开 worktree 会话 |
| skills | `.pi/skills/*/SKILL.md` | 8 个：`before-dev`、`brainstorm`、`break-loop`、`channel`、`check`、`meta`、`spec-bootstrap`、`update-spec` |
| 工作流文本 | `.myflow/workflow.md` | 三阶段索引、路由表、Dispatch Protocol、4 个 `workflow-state` 块 |
| 规格树 | `.myflow/spec/index.md`、`harness/index.md`、`guides/index.md`、`guides/doc-drift-thinking-guide.md` | 路由 / 区域契约 / 思考清单 / 文档漂移专项清单 |
| harness 参考 | `.pi/skills/myflow-meta/references/harness-conventions.md` | 载荷边界、承重契约、扩展规则、配置键 |
| 发布 / 脚本 | `tools/release.py` | 读清单建包；`--check` / `--out` / `--verify` / `--release` |
| 发布 / 清单 | `tools/release-payload.json` | 载荷的唯一来源：`dirs` / `trees` / `files` / `exclude` |
| 发布 / 安装说明 | `tools/INSTALL.md` | 随包发布但不属于载荷的安装步骤 |
| 测试 / 扩展与契约 | `tests/*.test.ts` 的 7 个：`extension`、`agents-commands`、`project-root`、`scaffold`、`skills-hygiene`、`doc-numbers`、`leak-audit` | 注册面、项目根、载荷自洽、文档数字与死引用 |
| 测试 / 任务与批准门 | 6 个：`task-bridge`、`task-gate`、`plan-approval-gate`、`plan-approval-tool`、`plan-approval-e2e`、`ask-user` | 跨语言会话指针、空清单门、哈希门、提问审计 |
| 测试 / 注入与每轮状态 | 6 个：`session-context`、`context-injection`、`turn-cache`、`workflow-invariant`、`escape-hatch`、`status` | 预算与省略、块解析、面包屑重注入、状态报告 |
| 测试 / 派发与面板 | 8 个：`subagent`、`subagent-rpc`、`ctl`、`runs-registry`、`board-actions`、`board-keys`、`board-render`、`transcript` | 协议解析、控制帧、注册表、视图与按键 |
| 测试 / 后台任务 | 7 个：`bg-lifecycle`、`bg-start`、`bg-output`、`bg-list`、`bg-stop`、`bg-registry`、`bg-runner` | 启动/读/停的闭环、包装器契约、状态优先级 |
| 测试 / 脚本与发布 | 4 个：`channel`、`worktree`、`release`、`mvp` | 通道与 worktree 脚本、发布校验 |
| 本书 | `book/` | 这本书的源与 VitePress 配置，在载荷之外 |

## 哪些随包发布

载荷只选两棵树：`.pi/` 与 `.myflow/`（`tools/release-payload.json` 的 `dirs`），再减去机器状态、任务历史、归档和本仓库自己的 `worktree.yaml`。所以 `.pi/agents`、`.pi/prompts`、`.pi/skills`、`.myflow/scripts`、`.myflow/spec`、`.myflow/workflow.md`、`.myflow/worktree.template.yaml` 随包走；`tests/`、`tools/`、`package.json`、`tsconfig.json`、`book/` 留在本仓库，`release.py` 的 `FORBIDDEN` 会拒绝它们。

`.myflow/tasks/` 与 `.myflow/archive/` 是交付物、进版本控制但不进载荷；`.myflow/.runtime/` 是机器状态、两者都不进。

运行时要 Node 内置模块、Pi、`python3`、Git Bash、`git` 与 `taskkill`——这条清单比"有什么文件"更能说明它能不能在你这台机器上跑起来（见[只支持 Windows + Git Bash](../design/windows-only.md)）。
