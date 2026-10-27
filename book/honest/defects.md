---
title: 已知缺陷登记表
---

# 已知缺陷登记表

这份表按**类型**分组，而不是按严重程度排序，因为分类本身就是这张表的论点。一个写在 `spec` 里、带着测量值的权衡，和一个没人想到的洞，不是同一种东西；把两者混在一列「已知问题」里，是项目对自己撒谎的最常见方式。所以每条只说一件事：它是**文档漂移**（文档说的事情代码没做）、**主动权衡**（做了、知道代价、写下来了）、还是**真缺**（没有机制，也没人承认）。

「证据」列永远给 `路径` 加符号名，不给行号。行号会随着下一次重构腐烂，符号名会在重构里被迫一起改。

## 文档漂移

文档与代码不一致，而且不一致的方向都是「文档比代码乐观」。这类问题最贵的地方在于：读者按文档行事，会得到一个空结果。

| 缺陷 | 类型 | 证据 |
| --- | --- | --- |
| `completed` 被写成可达阶段：`.pi/prompts/myflow-continue.md` 的阶段表写着「`completed` / 仍在 `tasks/` / 执行 3.3」，而 `task.py` 只在 `archive` 里写这个状态，写完立刻把目录移进 `.myflow/archive/<YYYY-MM>/` 并清空会话指针。`status.ts` 的 `phaseForStatus` 至今仍把历史状态 `done` 与 `completed` 都映射到 `completed` 块 | `文档漂移` | `.pi/prompts/myflow-continue.md` 阶段表；`.pi/extensions/myflow/status.ts` 的 `phaseForStatus`；`.myflow/scripts/task.py` 的 `archive` |
| `board/render.ts` 里有两处中文 UI 文案，而 spec 的检查项写着「shipped tree 里不许有非英文」 | `文档漂移` | `.pi/extensions/myflow/board/render.ts` 的 `sectionTitle` 调用点；`.myflow/spec/harness/index.md` § Quality Check 与 § Gotchas |
| `.myflow/spec/` 在同一份文档里既被描述成「随包发布」又被描述成「项目自有、不进 payload」，而实际是随 `.myflow/` 整棵发布 | `文档漂移` | `.pi/skills/myflow-meta/SKILL.md` 的 Layout 图与 Spec 一节；`tools/release-payload.json` 的 `dirs`；`CHANGELOG.md` 0.3.0 |
| 发布验证器只认一条斜杠命令：`EXPECTED_COMMANDS` 只有 `myflow-status`，而扩展注册了两条；冒烟脚本只检查「缺了没有」，所以 `/mysubagents` 消失不会有任何测试报红 | `文档漂移` | `tools/release.py` 的 `EXPECTED_COMMANDS` 与冒烟脚本的 `missingCommands`；`.pi/extensions/myflow/index.ts` 的 `registerCommand("myflow-status")`；`board/index.ts` 的 `registerMyflowSubagentsCommand` |
| English-only 规则的射程写窄了：它只管「shipped file」，而仓库里最像分析成品的归档交付物是中文散文 | `文档漂移` | `.myflow/archive/2026-10/norma-benchmark-gap-analysis/deliverables/` 下的 `01-verdict.md` / `03-gap-register.md`；规则文本在 `.myflow/spec/harness/index.md` § Quality Check |

## 主动权衡

每一条都能在仓库里找到一句「我知道，先这样」——多数还带测量值。把它们列出来不是为了免责，而是为了让读者分清「设计」和「意外」：下面这些是设计，代价算过了。

| 缺陷 | 类型 | 证据 |
| --- | --- | --- |
| 批准门可以被伪造：`--allow-unapproved`、手写一份 `approval.json`、或者 `bash` 都能绕过它，`approved_by` 按设计不可信 | `主动权衡` | `.myflow/scripts/task.py` 的 `_approval_report` 与 `start`；`.myflow/spec/harness/index.md` § Plan approval gate 的 "Honest strength (measured)" |
| `writesUnder` 只约束 `write` / `edit`，而且路径比较是字符串比较（不做 `realpath`），`bash` 按设计绕过它 | `主动权衡` | `.pi/extensions/myflow/index.ts` 的 `evaluateWriteScope`；`agents.ts` 的 `isWithinWriteScope` 与 `normalizeWriterPath` |
| 上下文预算的优先级是倒的：先塞计划文档，再塞人工挑选的 spec 文件，所以预算压力下先丢的恰好是挑选过的那部分 | `主动权衡` | `.pi/extensions/myflow/context-injection.ts` 的 `buildTaskContext`；`.myflow/spec/harness/index.md` § Task context 的 "Ordering caveat" |
| 后台任务没有日志轮转、没有配额、没有资源限制；进程存活靠 `process.kill(pid, 0)`（`EPERM` 记为存活），pid 复用的残留风险被写进 spec 并推迟 | `主动权衡` | `.myflow/scripts/bg_runner.mjs` 的 `exec >> <log>`；`.pi/extensions/myflow/background/registry.ts` 的 `isAlive` 与 `prune`；spec § Background tasks 的 "Known limits" 与 "Pid identity" |
| 验证门是有上限的：连续两轮不过就让检查代理收尾，所以它是「尽力验证」而不是「验证通过」 | `主动权衡` | `.pi/extensions/myflow/index.ts` 的 `MAX_VERIFY_ATTEMPTS` 与 `agent_before_settle` |
| 在子代理里跑整套测试不隔离：继承来的 `MYFLOW_*` 会改变被测代码的行为，必须先 scrub 环境变量 | `主动权衡` | `.myflow/spec/harness/index.md` § Gotchas；`.pi/skills/myflow-meta/SKILL.md` 的 "Verify A Change" |
| 压缩会让面包屑丢一个回合：`session_before_compact` 只记时间戳，重建发生在下一个 hook | `主动权衡` | `.pi/extensions/myflow/index.ts` 的 `session_before_compact` 与 `lastCompactionTs` |
| 随包发布的 `verify:` 只证明 harness 还活着，不证明任何东西正确 | `主动权衡` | `.myflow/worktree.template.yaml` 的 `verify:` 注释 |
| 三条带 `shortcut:` 标记的债，每条都写了自己的升级触发条件：`.mjs` 只查语法不查 import、日志预览只看末行窗口、每个打开的视图只缓存一条 transcript | `主动权衡` | `tools/release.py` 的 `node --check` 注释；`.pi/extensions/myflow/board/transcript.ts` 的 `LAST_LINE_WINDOW_BYTES`；`board/state.ts` 的 `TRANSCRIPT_CACHE_LIMIT` |
| 没有权限系统：`tool_call` 只有四道守卫（递归、主会话专属工具、后台任务工具、写作用域），没有 allow / deny / ask 三态，也没有逐次批准 | `主动权衡` | `.pi/extensions/myflow/index.ts` 的 `tool_call` 分支；`.pi/skills/myflow-meta/SKILL.md` 的 hook 表 |
| 只支持 Windows + Git Bash：扩展在非 `win32` 上加载即抛错，CI 只有一个 runner | `主动权衡` | `.pi/extensions/myflow/index.ts` 的平台 guard；`.github/workflows/ci.yml` |

## 真缺

没有机制、没有测量、多数也没有一句承认。这一组才是这份文档存在的理由。表的最后两条是写[埋点就是运行留痕](../launch/observability.md)时被量出来的——它们不是新机制，而是「这一格到底能不能算出数」的答案。

| 缺陷 | 类型 | 证据 |
| --- | --- | --- |
| channel worker 绕过所有「仅主会话」守卫：`channel.py` 起 worker 时只设 `MYFLOW_SKIP_BREADCRUMB`（`reviewer` 另加 `MYFLOW_VERIFY_GATE`），从不设 `MYFLOW_AGENT_TYPE`，于是 `detectAgentType()` 返回 `null`，这个 worker 在 `index.ts` 眼里是一个主会话 | `真缺` | `.myflow/scripts/channel.py` 的 `worker_env`；`.pi/extensions/myflow/index.ts` 的 `detectAgentType` 与 `tool_call` 四道守卫 |
| `myflow_subagent` 把 `ctx.cwd` 直接当项目根：`runOptions` 传 `projectRoot: ctx.cwd`，注册表用 `runsDir(ctx.cwd)`，活动任务用 `resolveActiveTaskStatus(ctx.cwd, …)`，而 `index.ts` / `ask.ts` / `approval.ts` 都先走 `findProjectRoot(ctx.cwd)`。从子目录派发时，注册表、控制文件和日志会落到 `<子目录>/.myflow/.runtime/` 下（`writeFileAtomic` 会递归建目录），而 `/mysubagents` 读的是 `findProjectRoot` 找到的真根，因此看不到也管不到这次 run；注册表条目里的 `task` 字段也因为同一处 `ctx.cwd` 而变成 `null`。**这一条由代码确认**（路径是字面量拼接，不需要运行就能判定），没有在子目录里实跑观测落点——实跑只会验证同一段代码 | `真缺` | `.pi/extensions/myflow/subagent.ts` 的 `runOptions` / `runsDir` / `resolveActiveTaskStatus`；`.pi/extensions/myflow/find-project-root.ts`；`.pi/extensions/myflow/runs.ts` 的 `runsDir`；`board/index.ts` 的 `projectRoot` |
| 派发结果没有输出上限：`getResultOutput` 原样返回子代理的最后一条文本，`parallel` 模式把最多六份用分隔线拼起来；每条输入路径都有字节预算，输出路径一个也没有 | `真缺` | `.pi/extensions/myflow/subagent.ts` 的 `getResultOutput` / `getFinalOutput`；对照 `context-injection.ts` 的 `ContextBudget` |
| 用量统计死在工具调用里：`SingleResult.usage` 累加了 token 与 cost，注册表条目里没有任何用量字段，所以没有汇总、没有告警、没有持久化 | `真缺` | `.pi/extensions/myflow/transport.ts` 的 `applyUsage`；`.pi/extensions/myflow/runs.ts` 的 `RunEntry` |
| 「这个 pid 还活着吗」有两套判定，而且互相看不上：后台注册表用 `process.kill(pid, 0)`，`worktree.py` 明确说这条路在本平台不可靠、改用 `ctypes` 调 `OpenProcess` / `GetExitCodeProcess` | `真缺` | `.pi/extensions/myflow/background/registry.ts` 的 `isAlive`；`.myflow/scripts/worktree.py` 的进程探测 |
| 「没有 context key 时指向哪个任务」有两套回退：扩展只在会话文件恰好一个时才用（否则 `no_task`），`get_context.py` 取 mtime 最新的那个；两者冲突时没有任何提示 | `真缺` | `.pi/extensions/myflow/turn-cache.ts` 的 `resolveActiveTaskStatus`；`.myflow/scripts/get_context.py` 的会话回退 |
| 平台守卫只盖住一半入口：扩展、`bg_runner.mjs`、`channel.py`、`worktree.py` 拒绝非 Windows，`task.py` 与 `get_context.py` 什么都不检查，于是别的平台上「能不能用」取决于你调的是哪个脚本 | `真缺` | `.myflow/scripts/task.py`、`.myflow/scripts/get_context.py`（无 guard）；`.pi/skills/myflow-meta/SKILL.md` 开头的平台说明 |
| 克隆下来看到的工作流只有一半，而且根目录没有入口文档：工作副本里的 `AGENTS.md` 被 `.gitignore` 的 `/AGENTS.md` 挡住，仓库根也没有 `README.md` | `真缺` | `.gitignore` 末段；`.myflow/scripts/task.py` 是唯一被提交的那套流程；`book/` 是唯一给外部读者的入口 |
| token 成本只能从日志重算，而且依赖 provider 报数：`transport.ts` 的 `applyUsage` 把用量累进内存里的 `SingleResult.usage` 就结束，`runs.ts` 的 `RunEntry` 里没有任何 usage 字段，所以「一次运行花了多少 token」这个**字段**不存在；唯一的原始值留在 `.myflow/.runtime/subagent-logs/` 的 `.log` 里（`message_end` / `turn_end` 记录），而日志有保留窗口、会被 `pruneRuns` 顺带扫掉。同一个模型在同一棵树里，有日志报真实数字，也有日志全是 0 | `真缺` | `.pi/extensions/myflow/transport.ts` 的 `applyUsage`；`.pi/extensions/myflow/runs.ts` 的 `RunEntry` 与 `pruneRuns` |
| verify gate 拦截次数不落盘：`index.ts` 的 `verifyAttempts` 是会话内存变量，`session_start` 时归零，累加之后只塞进一条 `customType: "verify-gate"`、`display: false` 的 `custom_message`。于是「一次通过」与「被拦两次后通过」在磁盘上完全同形，而且被派发的子代理跑在 `--no-session`，连那条消息都不存在 | `真缺` | `.pi/extensions/myflow/index.ts` 的 `verifyAttempts` / `MAX_VERIFY_ATTEMPTS` / `agent_before_settle`；`.pi/extensions/myflow/transport.ts` 的 `buildArgs` |

## 怎么读这张表

两类行值得分开读：「文档漂移」修起来便宜，但它的存在说明**机制**漏了——一条规则被写在五处，检查只盯其中三处。「主动权衡」不该被当成待办，它是一笔已经付过的账，判断点在「什么情况下会改回去」。「真缺」里最贵的不是任何单条，而是它们共同的形状：**守卫靠环境变量，而环境变量由启动方决定**。只要有一个启动方（`channel.py`）没设那个变量，整类守卫就是空的。

这也是[最锋利的三处](./sharpest.md)为什么会从这张表里挑出三条单独讲：它们不是最严重的，是最能说明这套东西真实状态的。
