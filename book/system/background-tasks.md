---
title: 后台任务
---

# 后台任务

## 职责

开发服务器、`watch`、跑二十分钟的测试——这类命令必须比会话活得久。`session_shutdown` 因此**不杀任何进程**，这是全套设计里最反直觉的一条：会话是短命的，任务是项目级的。代价是"谁还活着"必须写在盘上，且能跨进程回答。

## 触发点

四个工具都是 Pi 的普通工具，都受 `tool_call` 守卫管辖：

| 工具 | 做什么 | 参数要点 |
| --- | --- | --- |
| `myflow_bg_start` | 起一条命令，立刻返回 `taskId` | `command`、`description`、`cwd`（必须在项目根内且已存在）、`unattended` |
| `myflow_bg_output` | 读输出 | `mode: "delta"`（默认，推进本会话的游标）或 `"tail"`；`peek`；`max_bytes` 默认 32 768、上限 65 536；`lines` 默认 200、上限 2 000；`wait_ms` 上限 30 000 |
| `myflow_bg_list` | 列出所有任务 | `include_finished`、`prune` |
| `myflow_bg_stop` | 杀整棵进程树 | `task_id` |

`cwd` 的校验发生在**确认对话框之前**，用的是 `agents.ts` 里那套 `isWithinWriteScope` / `normalizeWriterPath`——同一个包含判定，不是第二份路径规则。子代理调这四个工具会被拒，理由写在拒绝文本里：后台任务活得比进程久，那是主会话的决定。

`myflow_bg_start` 的确认对话框显示**完整命令**和**解析后的 `cwd`**。没有交互 UI 时它拒绝启动，除非调用方显式传 `unattended: true`，那会在注册表里记成 `confirmed_by: "no-ui-explicit"`——一个可事后审计的"没人看过"。

## 读写哪些文件

全部在 `.myflow/.runtime/background/` 下：

| 路径 | 写者 | 内容 |
| --- | --- | --- |
| `<taskId>.json` | 只有本工具集 | 注册表条目，原子写 |
| `<taskId>.log` | 命令自己（`exec >> … 2>&1`） | 输出；工具从不写它 |
| `<taskId>.exit` | 只有 `bg_runner.mjs` | `{exit_code, signal, at, shell, retries?, error?}` |
| `<taskId>.pid` | 只有 `bg_runner.mjs` | 握手记录 `{pid, at}` |
| `cursors/<contextKey>__<taskId>.json` | `myflow_bg_output` | `{"offset": <字节>}` |

`taskId` 形如 `bg-<base36 毫秒>-<4 hex>`，**从不是 pid**：pid 会被操作系统复用，id 必须活得比进程久。

`start` 的执行顺序是刻意的：先确认（或记录无人确认）→ 写条目 `starting` / `pid: 0` → detached 起 `node bg_runner.mjs --id --log --exit --pid --cwd -- <command>` 并 `unref()` → 把 pid 写回 → 返回。它**从不等待子进程事件**。

`bg_runner.mjs` 拿到控制权后第一件正事是写 `.pid`：在 `parseArgs` 之后，在解析 shell、建日志目录、执行命令**之前**；写失败就是命令失败。注册表里 `pid: 0` 的那段时间是"还没有 pid"，不是"已经死了"。

## 不变量

**终态是粘性的，`.exit` 优先于 pid。** `resolveStatus` 是一条纯读取的优先级链：`.exit` 记录 → 已记录的 `stopped` → 已记录的 `exited` → `isAlive(readPid(...))` → 60 秒内算 `starting` → 自愈成 `exited` 且 `exit_code: null`。所以复用的 pid 既不能复活已结束的任务，也不能让 `stop` 去杀无关进程。

**没人信任条目里的 pid。** `readPid` 先读 `.pid` 文件，再退到条目缓存，最后是 0。

**停止的判据是进程消失，不是 `taskkill` 的返回码。** `taskkill` 对已消失的进程返回非零，也可能在还有后代活着时返回 0。所以 `myflow_bg_stop` 用 argv 直接调 `taskkill /F /T /PID`，然后在 1 秒内每 25 毫秒复查一次 `isAlive`；活下来的按错误报告，不写成 `stopped`。`starting` 状态直接被拒（"还不能寻址"），不会退化成 `terminate(0)`——那等于对进程组动手。

**读输出不把日志读进内存。** `wait_ms` 先 `statSync` 看大小，变大了才读。游标越过文件末尾说明日志轮转过，于是从头开始并标 `reset: true`。

**只有 `list` 回写自愈结果。** `resolveStatus` 是纯函数；`myflow_bg_list` 反正要读所有条目，所以由它把"已经死了"落盘。

## 已知限制

| 限制 | 具体行为 |
| --- | --- |
| 没有日志轮转 | `.log` 无限增长；`prune` 只删已结束且超过 24 小时的任务文件。保留策略至今没定：截断丢历史，滚动要新增命名契约 |
| 没有资源与超时限制 | 命令以当前用户权限运行，CPU / 内存 / 子进程数不限，也没有超时会杀掉长任务 |
| pid 复用是残余风险 | 若 pid 在**任何读者观测到它之前**被复用，盘上没有记录说明它已死，第一次读仍会说 `running` |
| 确认对话框不是边界 | `unattended: true` 直接绕过，只留下 `confirmed_by: "no-ui-explicit"` |

还有一处值得知道：这个仓库对"这个 pid 还活着吗"有**两套实现**。后台任务用 `process.kill(pid, 0)`；`worktree.py` 用 `ctypes` 调 `OpenProcess` / `GetExitCodeProcess`。各有理由（后台任务在 `list` 热路径上不能付这个开销；worktree 一次只查一条），但一致性没人维护。

## 一个最小走查

1. 模型调 `myflow_bg_start`，`command: "npm run dev"`。`cwd` 校验通过，确认对话框弹出，用户点确认。
2. 注册表出现 `starting` / `pid: 0`。`bg_runner.mjs` detached 起来，写 `<taskId>.pid`，解析 Git Bash，再执行 `bash -lc "exec >> <log> 2>&1; npm run dev"`。
3. `start` 写回 pid 与 `running`，返回 `taskId`。工具调用结束，模型回到自己的循环。
4. 用户下一轮问"服务器起来了吗"：`myflow_bg_output` 的 `delta` 模式从本地游标 0 读到末尾。
5. 会话结束。`session_shutdown` 只列出"本会话启动且仍在跑"的任务，然后什么都不做。
6. 第二天命令退出，`bg_runner.mjs` 写 `.exit`；之后任何 `myflow_bg_list` 都直接报终态与退出码，不探 pid。

## 常见误解

- **"会话退出会带走子进程。"** 不会，而且这是要求。要停就显式 `myflow_bg_stop`。
- **"`.exit` 只是个提示。"** 它是终态的最高优先级，比 pid 存活更权威。
- **"输出游标是全局的。"** 每个（会话 context key, taskId）一个游标，所以两个会话各自读各自的增量。
- **"`BG_TOOL_NAMES` 只是给守卫用的名字列表。"** 四个工具在子代理里照样注册，就是为了让守卫能给出**带理由的拒绝**，而不是"未知工具"。
