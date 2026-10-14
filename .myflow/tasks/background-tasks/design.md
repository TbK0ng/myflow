# design.md — 真后台长任务：机制、契约与强制层级

> `prd.md` 定「要什么」（Q1/Q2/Q3 已定，Q4 为我的判定）；本文件定「怎么实现、拿什么强制」；
> `implement.md` 定「按什么顺序做」。

---

## 1. 需求 → 机制映射（强制层级表）

| # | 需求 | 落点 | 强制层级 | 靠什么拦/保证 |
| --- | --- | --- | --- | --- |
| R1 | 起后台**立刻返回** | `myflow_bg_start` | `E-C` | 工具**不 await 子进程**；只用可测时间上界断言 |
| R2 | 任务**活过会话** | 项目级注册表 + `detached` + wrapper | `E-C` | 注册表在 `.myflow/.runtime/`；`session_shutdown` **不杀**（已实测 detached 存活） |
| R3 | **能拿到退出码**（跨会话） | **wrapper 进程**写 `.exit` 记录 | `E-C` | 见 ADR-1：脱离后父进程收不到 exit 事件，必须由 wrapper 自己记 |
| R4 | 读**增量**输出 | 按会话游标 + 文件偏移 | `E-C` | 游标文件按 `deriveContextKey` 命名；已实测追加写对后续读取可见 |
| R5 | 读**尾部**输出 | 无状态尾读 | `E-C` | 同一原语的另一分支 |
| R6 | **列表 / 停止** | `myflow_bg_list` / `myflow_bg_stop` | `E-C` | stop 在 Windows 用 `taskkill /F /T /PID`（已实测杀树） |
| R7 | 起后台**前必须确认** | `ctx.ui.confirm` | `E-C` | 无 UI → 需显式 `unattended: true`，且**留痕** |
| R8 | 无 UI 放行**必须留痕** | 注册表 `confirmed_by` + 结果回显 | `E-C` | 结果里显式写「未经用户确认」；`list` 也标出来 |
| R9 | 状态**自愈**（pid 死了不该仍报 running） | pid 存活检测 | `E-C` | 任一读取方发现 pid 已死且无 `.exit` → 标 `exited`（无退出码） |
| R10 | 子代理**不可用** | `tool_call` 守卫 + 白名单 | `E-C` | 与 `myflow_ask_user` 同款 |
| R11 | 不削弱既有门 | — | `E-C` | 既有 254 条测试必须全绿 |

**R3 是设计的支点**：`detached` 之后**没有任何人 wait 那个子进程**，所以退出码**天然拿不到**。
不解决它，「已退出任务能给出退出码」这条 AC 就永远不成立。→ ADR-1。

---

## 2. 核心机制：wrapper 进程（ADR-1）

```
myflow_bg_start
  └─ 1. ctx.ui.confirm(命令)            ← 确认门（R7）
  └─ 2. spawn(node, [bg_runner.mjs, --id, --log, --exit, --, <command...>],
              { detached: true, stdio: "ignore" })   ← wrapper 自己就是脱离的进程
  └─ 3. 写 <id>.json（含 wrapper 的 pid）  ← 工具是注册表的唯一写者
  └─ 4. 立刻返回 { id, pid, log }         ← 不 await（R1）

bg_runner.mjs（随 payload 发布的独立 Node 脚本）
  └─ 打开 <log> 的 fd，spawn(<command>, { stdio: ["ignore", fd, fd] })
  └─ 子进程 exit 时写 <id>.exit = {"exit_code":N,"signal":null,"at":"…"}
```

> ⚠️ 上面这张图里的 `stdio: ["ignore", fd, fd]` 与「为什么用 wrapper」第 3 条**已被取代**：外壳现在自己做输出重定向，wrapper **不再把任何描述符交给子进程**。该处连同 `implement.md` 里的「外壳用 `shell: true`」一并待 **F8 统一修订**；本节只**补**本次新增的行为（§2.1），不重写上文。

**为什么用 wrapper 而不是直接 spawn 用户命令**：
1. 直接 spawn 之后脱离，**没人能记下退出码**（R3 不成立）；
2. wrapper 是「脱离的父」→ `taskkill /T` 打在 wrapper 的 pid 上能连命令一起杀（已实测）；
3. 命令输出用 `stdio: [ignore, fd, fd]` 由**内核**直接写文件，不经 Node 缓冲，跨进程读取立即可见（已实测）。

### 2.1 外壳的启动与「瞬时拒绝」的应对（本会话落地，属契约）

- **Windows 上外壳以 `detached` 启动**（libuv → `DETACHED_PROCESS`，**不建控制台**）。
  wrapper 自身没有控制台，若不这样，每个后台任务都会让 Windows 新建一个控制台窗口 ——
  既是可见的闪烁，也要从交互式桌面堆里分配对象（该堆耗尽会表现为
  `ERROR_NO_SYSTEM_RESOURCES` / 232）。**仅限 Windows**：POSIX 的 `detached` 会把外壳移出
  wrapper 的进程组，而 `myflow_bg_stop` 正是对这个组发信号（§4.4），那样就会杀不到。
  ⚠️ 该 flag 是否真的减少了 232 的发生**未经测量**，因此**不作为因果声明**；它的确定性收益是
  「后台任务不再建控制台窗口」。
- **创建进程被拒时有界退避重试**：最多 **8 次尝试**；间隔 **250ms 起、×1.5 递增、封顶 2s**；
  合计约 **7.2s**，硬上界 **10s**。
  - **依据**：本机观测到 OS **瞬时**以 232 拒绝创建**控制台程序**（`cmd.exe` / `bash.exe`），
    且与命令写法无关 —— 去掉 fd 传递后仍复现；这类瞬时状态会自行恢复。
  - **安全性**：只在 `'error'` 事件或同步抛出时重试，即**进程从未被创建**，
    因此命令**不可能被执行两次**。
  - **绝不重试** `ENOENT` / `EINVAL` / `EACCES` / `EPERM`：写错的命令必须**立刻**失败，
    而不是 7 秒后才失败。
  - 预算耗尽时，`<taskId>.exit` 的 `error` 必须说明「是**操作系统拒绝创建进程**，
    不是命令写错」（字段见 §3.2）。

**wrapper 的落点**：`.myflow/scripts/bg_runner.mjs`（与 `task.py` 等脚本同处，独立可跑、可单测）。

---

## 3. 目录与文件契约

全部在 `.myflow/.runtime/background/`（`.runtime` 已被 gitignore，符合既有约定）：

```
.myflow/.runtime/background/
├── <taskId>.json          # 注册表条目：一个任务一个文件（ADR-4）
├── <taskId>.log           # 输出（内核直接写）
├── <taskId>.exit          # wrapper 写的退出记录（不存在 = 还没退出）
└── cursors/
    └── <contextKey>__<taskId>.json   # 每会话每任务一条读游标（R4）
```

**`taskId` 形状**：`bg-<base36 毫秒时间戳>-<4 位 hex>`，例 `bg-lq3f8k-9a2c`。
可读、可排序、不依赖 pid（**不得用 pid 当 id**：pid 会被系统重用）。
形状由测试锁定（正则）。

### 3.1 `<taskId>.json` 字段

```json
{
  "id": "bg-lq3f8k-9a2c",
  "command": "npm run dev",
  "description": "dev server",
  "cwd": "C:/Users/wocai/Desktop/myflow",
  "pid": 12345,
  "log": ".myflow/.runtime/background/bg-lq3f8k-9a2c.log",
  "exit_file": ".myflow/.runtime/background/bg-lq3f8k-9a2c.exit",
  "status": "running",
  "exit_code": null,
  "started_at": "2026-10-14T15:00:00.000Z",
  "ended_at": null,
  "started_by_context_key": "pi_<sanitized>",
  "confirmed_by": "ui-confirm"
}
```

- `status` 取值**只有四个**：`running` | `exited` | `stopped` | `unknown`（`unknown` = 注册表坏或 pid 不可判）。
- `confirmed_by`：`ui-confirm` | `no-ui-explicit`（R8）。
- 工具是 `<taskId>.json` 的**唯一写者**；wrapper 只写 `.log` 与 `.exit`（无竞态，见 ADR-4）。

### 3.2 `<taskId>.exit`
```json
{"exit_code": 0, "signal": null, "at": "2026-10-14T15:00:12.345Z",
 "shell": "C:/Program Files/Git/bin/bash.exe"}
```
存在即视为「命令已结束」；**优先级高于 pid 存活检测**（避免 pid 重用误判）。

字段：
- `shell`：**实际用来跑这条命令的外壳路径**，成功与失败两条路径都记。
  「到底哪个外壳跑的」不该靠猜 —— 本机就存在「`PATH` 上的 `bash` 其实是 WSL 启动器」这种情况。
- `retries`：**仅在被拒后重试过**时出现，值为重试次数（尝试次数 − 1）；一次成功则该字段**不出现**。
  重试预算与分类见 §2.1。
- `error`：**只在 wrapper 无法启动外壳**（`MYFLOW_BG_SHELL` 或自动解析出的外壳路径不存在）时出现；**命令本身不存在不属于此列** —— 外壳正常启动、只是命令找不到，`.exit` 记录的是外壳的退出码 **127** 且**无 `error`**（「命令写错」≠「进程创建失败」）。
  若 `error` 的文案是「操作系统拒绝创建进程（232）」，那是**环境**问题、且**已经过重试**（见 §2.1），不是命令问题。

### 3.3 游标 `<contextKey>__<taskId>.json`
```json
{"offset": 4096}
```
- `offset` = 已消费到的字节位置（绝对）。
- 只在 `mode:"delta"` 且 `peek` 非真时推进；`tail` 与 `peek` **绝不**动游标。
- 文件不存在 = offset 0（等价于从头读，**不会漏**，最多重读）。
- 游标读写在**同一会话**内串行；跨会话互不影响（R4/Q3）。

---

## 4. 四个工具

命名沿用 `myflow_` 前缀。**全部主会话专用**（R10）。

### 4.1 `myflow_bg_start`
| 项 | 规格 |
| --- | --- |
| 入参 | `command`（必填，非空）、`description?`、`unattended?`（布尔，默认 false） |
| 前置 | ① 有活动任务**不要求**（后台任务属项目级，不绑定任务）；② 命令非空 |
| 确认 | `ctx.ui.confirm("以后台运行这个命令？", "<command>")` |
| 非 UI | `unattended !== true` → **拒绝**并返回指令（说明可用 `unattended: true`，且会被记录为未经确认）；`unattended === true` → 放行，`confirmed_by: "no-ui-explicit"` |
| 返回 | `{ id, pid, log, confirmed_by }`，**且结果里回显 `confirmed_by`**（R8） |

### 4.2 `myflow_bg_output`
| 项 | 规格 |
| --- | --- |
| 入参 | `task_id`（必填）、`mode?`: `"delta"`(默认) \| `"tail"`、`peek?`(bool)、`max_bytes?`(默认 32768，上限 65536)、`lines?`(仅 tail，默认 200，上限 2000)、`wait_ms?`(0–30000，默认 0) |
| 行为 | `tail` → 返回最后 `lines` 行（按行边界截断，**不返回半行**：`max_bytes` 若切到某行中间就丢掉该不完整首行，从下一完整行开始；唯一例外是单行本身超过 `max_bytes`，此时返回其 UTF-8 对齐片段并标 `truncated: true`）；`delta` → 从游标读到文件末尾；`peek` → 读但不推进游标 |
| 截断 | 超出 `max_bytes` 时**截断并明确标注** `truncated: true` 与下一游标位置（**不得静默丢**） |
| `wait_ms` | 在返回前最多等这么久，条件满足即提前返回：有新字节 **或** 任务已结束。**替代独立的 `sleep` 工具**（ADR-3） |
| 返回 | `{ status, exit_code, bytes, next_offset, truncated, text }` |
| 状态自愈 | 读之前先跑一次存活检测（R9） |

### 4.3 `myflow_bg_list`
| 项 | 规格 |
| --- | --- |
| 入参 | `include_finished?`(默认 true)、`prune?`(bool，默认 false) |
| 返回 | 每条：`id, command(截断), status, exit_code, pid, started_at, ended_at, started_by_context_key(是否为当前会话), confirmed_by` |
| `prune` | 删除**已结束且 ended_at 早于 24 小时**的条目与其 `.log`/`.exit`/游标；返回删除计数 |
| 自愈 | 对每条跑存活检测，把 pid 已死且无 `.exit` 的标为 `exited`（`exit_code: null`） |

### 4.4 `myflow_bg_stop`
| 项 | 规格 |
| --- | --- |
| 入参 | `task_id`（必填） |
| 行为 | Windows：`spawnSync("taskkill", ["/F","/T","/PID", String(pid)])`；其它平台：`process.kill(-pid)` 或 `process.kill(pid)` |
| 幂等 | 已结束的任务 → 返回「本来就没在跑」，**不改**已有 `exit_code` |
| 结果 | 把 `status` 置 `stopped`、写 `ended_at`；**保留**已有 `.exit` 里的 `exit_code`（若 wrapper 抢先在写） |
| 失败 | `taskkill` 非零退出且 pid 仍活 → 返回错误与原始 stderr（**不得**谎报已停） |

> **平台陷阱（已实测）**：`taskkill /F` 在 Git Bash 里会被 MSYS 改写成 `F:/`。
> **必须从 Node 用参数数组调**，测试也不得经 Git Bash 转发。

---

## 5. 会话生命周期（Q1 已定）

| 时点 | 行为 |
| --- | --- |
| 扩展工厂 | **不起**任何进程/定时器（`docs/extensions.md:58`） |
| `session_shutdown` | ① **幂等**释放本会话自己的句柄/定时器；② **不杀任何任务**；③ 列出「本会话起的、仍 `running`」的任务并提示（`ctx.ui.notify`，无 UI 则静默跳过通知） |
| 新会话启动 | 不自动读注册表；`list` / `output` 时按需读（避免每次会话启动都付代价） |

---

## 6. 子代理守卫（R10）

```ts
const BG_TOOL_NAMES = new Set(["myflow_bg_start","myflow_bg_output","myflow_bg_list","myflow_bg_stop"]);
if (BG_TOOL_NAMES.has(toolEvent.toolName) && isSubAgent) return { block: true, reason: "…仅主会话可管理后台任务…" };
```
两手都要：工具自身 `execute` 也拒绝（注入的 `isSubAgent`）+ `tool_call` 钩子 `block` + 白名单不含。
（与 `myflow_ask_user` 同款三层形态。）

---

## 7. 决策记录（ADR-lite）

### ADR-1 wrapper 进程承担退出记录
- **Context**：`detached` 后无人 `wait` 子进程，退出码天然丢失 → R3 不成立。
- **Decision**：起一个 `bg_runner.mjs` 作为脱离的父，由它 spawn 用户命令并在 exit 时写 `.exit`。
- **Consequences**：多一个独立脚本（可单测）；换来「跨会话能给出退出码」。
  代价：wrapper 若被强杀（`stop --force`）则不写 `.exit` → 由 `stop` 自己置 `stopped`。

### ADR-2 不做独立的 `Monitor` 工具
- **Context**：Norma 有 `Monitor` 专门起流式进程，因为它的 `bash` 默认前台。
- **Decision**：myflow 的 `myflow_bg_start` **本身就是后台**，任何命令都可流式跟踪 → `Monitor` 冗余。
- **Consequences**：工具数从 5 降到 4；风险是「流式」与「一次性」不再有语义区分，
  但那只影响文档措辞，不影响能力。

### ADR-3 不做独立的 `sleep` 工具，改成 `myflow_bg_output` 的 `wait_ms`
- **Context**：Norma 的 `sleep` 是「等一会儿再读部分输出」。
- **Decision**：把等待做进 `output`（有界 0–30s，有新输出或任务结束即提前返回）。
- **Consequences**：少一个工具、少一次往返；且**不存在**「模型 sleep 而任务其实已结束」这种空等。
  借鉴 Norma `disallowedAutoBackground=["sleep"]` 的意图：不鼓励盲等。

### ADR-4 一任务一文件，而不是单个 `tasks.json`
- **Context**：多会话并发写同一个 JSON 会丢更新。
- **Decision**：`<taskId>.json` 一任务一文件；工具是唯一写者；wrapper 只写自己的 `.log`/`.exit`。
- **Consequences**：`list` 需要 readdir + 逐文件解析（量小）；换来无锁、无丢更新。
  坏文件（写一半）按 `unknown` 处理并计入 `list` 的告警，不抛。

### ADR-5 游标按会话（`deriveContextKey`）
- 理由见 PRD Q3。**Consequences**：`.runtime/background/cursors/` 会随会话数增长 → 由 `prune` 一并清理。

### ADR-6 Windows 用 `taskkill /F /T`，不用 `process.kill`
- **Context**：实测 `process.kill(pid)` 也杀了孙进程，但那是 **Node/libuv 的 job object** 行为，
  真实任务的 `cmd`/`bash` 后代链未覆盖。
- **Decision**：Windows 一律 `taskkill /F /T /PID`；`process.kill` 只在非 Windows 用。
- **Consequences**：多一次子进程调用（只在 stop 时）。

### ADR-7 子代理不可用
- 理由见 PRD Q4。**Consequences**：子代理若需要长跑工作，应回报主会话。

---

## 8. 已知限制与威胁模型（诚实声明，必须进 spec）

| 限制 | 说明 |
| --- | --- |
| **孤儿窗口** | spawn 成功但工具在写注册表前崩溃 → 有一个**无注册表条目**的后台进程。窗口极小；**不做事务补偿**，但 `list` 无法发现它（它是「不可见的」）。诚实记录，不假装解决 |
| **退出码可能为 `null`** | `stop` 强杀的、或 wrapper 自身崩溃的，只能标 `stopped`/`exited` 而**无退出码** |
| **pid 重用** | 存活检测在极长时间后可能把别人的进程当成本任务的。缓解：`.exit` 优先；仍标为已知残余风险 |
| **无沙箱** | 后台命令以当前用户权限跑，**没有任何权限系统**（横评 `GAP-PERM-*` 是独立任务）。确认门是**唯一**的把关 |
| **确认门不是安全边界** | 与 plan 批准门同款：`unattended: true` 可绕过，只留痕 |
| **不做资源限制** | 不限制 CPU/内存/进程数；不做超时强杀（长任务本来就该长跑） |
| **不做输出轮转** | `.log` 会无限增长；`prune` 只删**已结束**任务的日志。运行中的长任务日志需用户自理（记为已知限制） |
