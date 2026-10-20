# design.md — 真后台长任务：机制、契约与强制层级

> `prd.md` 定「要什么」（Q1/Q2/Q3 已定，Q4 为我的判定）；本文件定「怎么实现、拿什么强制」；
> `implement.md` 定「按什么顺序做」。
>
> **本文件是实现期的计划快照（2026-10）；活契约是 `.myflow/spec/harness/index.md` 的
> `Background tasks: myflow_bg_*` 一节。** 两者冲突时以 spec 为准（spec 描述的是已落地的代码）。

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
| R9 | 状态**自愈**（pid 死了不该仍报 running） | pid 存活检测 | `E-C` | 任一读取方发现 pid 已死且无 `.exit` → 标 `exited`（无退出码）；`list` 负责回写 |
| R10 | 子代理**不可用** | `tool_call` 守卫 + 白名单 | `E-C` | 与 `myflow_ask_user` 同款 |
| R11 | 不削弱既有门 | — | `E-C` | 既有全量套件必须全绿（F8 时为 325/325） |

**R3 是设计的支点**：`detached` 之后**没有任何人 wait 那个子进程**，所以退出码**天然拿不到**。
不解决它，「已退出任务能给出退出码」这条 AC 就永远不成立。→ ADR-1。

---

## 2. 核心机制：wrapper 进程（ADR-1）

```
myflow_bg_start
  └─ 1. ctx.ui.confirm(命令)                     ← 确认门（R7）
  └─ 2. spawn(process.execPath,
              [bg_runner.mjs, --id, --log, --exit, --, <command>],
              { detached: true, stdio: "ignore", cwd: <project root> })
         → child.unref()                          ← wrapper 自己就是脱离的进程
  └─ 3. 写 <id>.json（含 wrapper 的 pid）          ← 工具是注册表的唯一写者
  └─ 4. 立刻返回 { started, id, pid, log, confirmed_by }   ← 不 await（R1）

bg_runner.mjs（`.myflow/scripts/` 里的独立 Node 脚本）
  └─ resolveShellPath() → shellRejectionReason()   ← 解析不到 POSIX 外壳 = 拒绝，什么都不执行
  └─ spawn(<shell>, ["-lc", "exec >> '<log>' 2>&1; <command>"], { stdio: "ignore" })
  └─ 外壳退出时写 <id>.exit：成功 = { exit_code, signal, at, shell, retries? }
     创建失败/拒绝 = { exit_code: null, error, at, shell }
```

**执行机制的三条事实**（照 `bg_runner.mjs` 写，不要照早期草稿写）：

1. **命令恒为单个 argv 元素**，交给外壳（`shellArgsFor`）。**不**把命令串交给 Node 的
   `shell` 选项：那在 Windows 上硬编码 `%ComSpec%` 并把命令重建成
   `cmd.exe /d /s /c "<command>"`，多一轮引号解析 —— 内层引号被转义成 `\"`，`cmd` 不认。
   自己 spawn 外壳则管道、`&&`、重定向照常可用，命令原样穿过（`174597c`）。
2. **外壳自己把输出写进日志**：`bash -lc "exec >> '<log>' 2>&1; <command>"`。
   wrapper **不向子进程传任何描述符**（`stdio: "ignore"`）。把 fd 当标准句柄传进去会让
   libuv 限制子进程的继承句柄，Windows 上那条 `CreateProcess` 路径可能以
   `ERROR_NO_SYSTEM_RESOURCES`（232）失败。`>>` 同时带来追加语义，且内核直接写文件 ——
   跨进程读取立即可见（`a193b10`，已实测）。
   日志路径按外壳语法单引号转义（`quoteForBash`），含空格/引号的路径无法逃出重定向。
3. **外壳在 Windows 上 detached 启动**（§2.2）；POSIX 上**不** detached，因为
   `myflow_bg_stop` 正是对这个进程组发信号（§4.4）。

**为什么用 wrapper 而不是直接 spawn 用户命令**：
1. 直接 spawn 之后脱离，**没人能记下退出码**（R3 不成立）；
2. wrapper 是「脱离的父」→ `taskkill /T` 打在 wrapper 的 pid 上能连命令一起杀（已实测）；
3. wrapper 是唯一观察者：它等外壳退出、写 `.exit`，而工具本身立刻返回。

### 2.1 外壳解析与拒绝（P1，用户裁定）

**解析顺序**（`resolveShellPath`，只此一份实现）：

1. `MYFLOW_BG_SHELL` —— 显式覆盖，**原样采用、不检查存在性**。这样「指错路径」是可观测的：
   `spawn` 会以 `ENOENT` 失败，`.exit` 把请求过的路径记进 `shell`。
2. `~/.pi/agent/settings.json` 的 `shellPath` —— 用户自己选的 shell；**必须存在**才采用。
3. Git for Windows 的标准安装位置（`C:\Program Files\Git\bin\bash.exe`）。
4. `PATH` 上的 `bash`（`findOnPath`）。

**没有 `cmd.exe` / `/bin/sh` 兜底**，且解析到的路径若是 `cmd.exe` 同样拒绝
（`shellRejectionReason` 有且只有两条拒绝理由）。理由：兜底路径上任何带引号的命令都是坏的
（见 §2 第 1 条），把它宣传成「可用」才是说谎。

**拒绝的后果**（`shellUnavailableRecord`，在 `runWrapper` 里**先于**日志目录创建）：

- `.exit` = `{ exit_code: null, error: <含完整搜索顺序 + "No command was executed">, at, shell: <被拒路径或 null> }`；
- wrapper 退出码非零（`EXIT_SPAWN_FAILED`）；
- **不创建日志文件、不执行任何命令** —— 「什么都没跑」是可观测的事实，不是声明。

**`findOnPath` 跳过 `system32` / `sysnative`**：Windows 上 `System32\bash.exe` 是 WSL 启动器，
本项目禁止调用；`Sysnative` 是 32 位进程看到的同一东西。**`syswow64` 未跳过**（§8 已知缺口）。

### 2.2 Windows detached 外壳与有界重试

- **Windows 上外壳以 `detached` 启动**（libuv → `DETACHED_PROCESS`，**不建控制台**）。
  wrapper 自身没有控制台，若不这样，每个后台任务都会让 Windows 新建一个控制台窗口 ——
  既是可见的闪烁，也要从交互式桌面堆里分配对象（该堆耗尽会表现为
  `ERROR_NO_SYSTEM_RESOURCES` / 232）。**仅限 Windows**：POSIX 的 `detached` 会把外壳移出
  wrapper 的进程组，而 `myflow_bg_stop` 正是对这个组发信号（§4.4），那样就会杀不到。
  ⚠️ 该 flag 是否真的减少了 232 的发生**未经测量**，因此**不作为因果声明**；它的确定性收益是
  「后台任务不再建控制台窗口」。
- **创建进程被拒时有界退避重试**（`runCommand` + `spawnRetryDelayMs`）：最多 **8 次尝试**
  （`MAX_SPAWN_RETRIES = 7` 次重试）；间隔 **250ms 起、×1.5 递增、封顶 2s**
  （250 + 375 + 562.5 + 843.75 + 1265.625 + 1898.4375 + 2000 ≈ **7.2s**），
  硬上界 `SPAWN_RETRY_TOTAL_BUDGET_MS = 10s`。
- **分类**（`isRetryableSpawnError`）：可重试 = `EAGAIN` / `ENOMEM` / `EMFILE` / `ENFILE`
  **以及无法识别的 code（含根本没有 `code` 的；232 以 `UNKNOWN` 落在这里）**；
  **绝不重试** `ENOENT` / `EINVAL` / `EACCES` / `EPERM`。
  ⚠️ 已知缺口：`ERR_*` 这类确定性错误目前也会被当作可重试（白等约 7.2s，§8）。
- **安全性**：只在 `'error'` 事件或同步抛出时重试，即**进程从未被创建**，
  因此命令**不可能被执行两次**。
- 预算耗尽时，`.exit` 的 `error` 必须说明「是**操作系统拒绝创建进程**（已重试 N 次），
  不是命令写错」，并带上原始 `code` / `errno`（`spawnFailureRecord`）。

**wrapper 的落点**：`.myflow/scripts/bg_runner.mjs`（与 `task.py` 等脚本同处，独立可跑、可单测）。

---

## 3. 目录与文件契约

全部在 `.myflow/.runtime/background/`（`.runtime` 已被 gitignore，符合既有约定）：

```
.myflow/.runtime/background/
├── <taskId>.json          # 注册表条目：一个任务一个文件（ADR-4）
├── <taskId>.log           # 输出（外壳的 >> 直接写）
├── <taskId>.exit          # wrapper 写的退出记录（不存在 = 还没退出）
└── cursors/
    └── <contextKey>__<taskId>.json   # 每会话每任务一条读游标（R4）
```

**`taskId` 形状**：`bg-<base36 毫秒时间戳>-<4 位 hex>`，例 `bg-lq3f8k-9a2c`（`newTaskId`）。
可读、可排序、不依赖 pid（**不得用 pid 当 id**：pid 会被系统重用）。后缀来自进程内计数器
（低 16 位），计数器种子取 2 个随机字节，所以同毫秒内、跨进程都不易撞。形状由测试正则锁定。

### 3.1 `<taskId>.json` 字段（以 `BackgroundEntry` 为准）

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
  "confirmed_by": "ui-confirm",
  "spawn_error": "(仅当 spawn 异步失败时出现)"
}
```

- `status` 取值在类型上有四个，但 **`resolveStatus` 只可能产出三个**：
  `running` | `exited` | `stopped`。`unknown` **不可达** —— 它只出现在两个**拒绝/错误返回体**里
  （`bgOutputError`、`bgStopError`），以及类型定义中作为前向兼容的保留值。
  坏注册表文件不会被伪装成一个状态：它们进 `listEntries().warnings`（ADR-4）。
- **判据顺序是固定的五档**（见 `resolveStatus`）：
  ① `.exit` 存在 ⇒ `exited`（带记录的 `exit_code`/`failure`/`signal`）；
  ② `status === "stopped"` ⇒ `stopped`；
  ③ `status === "exited"` ⇒ `exited`（带条目里的 `exit_code`）；
  ④ `isAlive(pid)` ⇒ `running`；
  ⑤ 否则 ⇒ `exited` 且 `exit_code: null`（自愈）。
  **已判定结束的条目粘住**：`exited` / `stopped` 不会因为 pid 后来被系统重用而复活成
  `running`（派 2 与 3 都高于 4）。这同时保护 `myflow_bg_stop` —— 它不会对一个被重用的
  pid 执行 `taskkill /F /T`（即不会杀掉无关进程）。`.exit` 仍高于粘贴档：记录晚到时
  它的 `exit_code`/`failure`/`signal` 依然覆盖条目里的值。
- `confirmed_by`：`ui-confirm` | `no-ui-explicit`（R8）。
- `pid`：spawn 未给出 pid 时写 `0`（`pid ?? 0`）；`isAlive` 对 `pid <= 0` 恒为 false。
- `log` / `exit_file` 以**项目根为基准的相对路径**存储；`exitPathFor` 既接受相对也接受绝对。
- `spawn_error`：**只由** `myflow_bg_start` 的 `'error'` 监听器写入（进程压根没被创建）。
  与 `.exit` 的 `error` 语义不同：后者是脱离的 wrapper 自己记录的失败。
  带 `spawn_error` 的条目在 `list` 里**永远不会**显示成 `running`（即使 pid 已被重用）。
- 接口带索引签名，因此**容忍未知字段**：新写者不会弄坏旧读者。
- 工具是 `<taskId>.json` 的**唯一写者**；wrapper 只写 `.log` 与 `.exit`（无竞态，见 ADR-4）。
- 写入是原子的（`.tmp` → rename，`writeFileAtomic`）。rename 对 `EPERM`/`EACCES`/`EBUSY`
  有界重试 **50 × 20ms**（与 `bg_runner.mjs` 写 `.exit` 同一套数，只用于 Windows 上读者
  持有文件造成的瞬时拒绝；其它错误立即抛出，且 `.tmp` 一定清理）。
  `list` 的自愈回写失败**不影响本次结果**：本次仍返回 `resolveStatus` 的结论，只是不落盘、
  不计入 `healed`（不得声称写过一个没写成的状态）。

### 3.2 `<taskId>.exit`（`writeExitRecord` / `spawnFailureRecord` / `shellUnavailableRecord`）

成功（命令跑完，无论退出码多少）：

```json
{"exit_code": 0, "signal": null, "at": "2026-10-14T15:00:12.345Z",
 "shell": "C:/Program Files/Git/bin/bash.exe"}
```

- **`shell` 恒存在**：成功与失败两条路径都记「实际用来跑这条命令的外壳路径」。
  「到底哪个外壳跑的」不该靠猜 —— 本机就存在「`PATH` 上的 `bash` 其实是 WSL 启动器」这种情况。
- **`retries`**：仅在被拒后重试过时出现，值为重试次数（尝试次数 − 1）；一次成功则该字段**不出现**。
- **`error`**：只出现在三条路径 ——
  ① **外壳无法创建**（`spawn` 抛错/`'error'`）：`exit_code: null` + `error`，`shell` 是被请求的路径；
  ② **外壳被拒绝**（解析不到 / 解析到 `cmd.exe`）：`exit_code: null` + `error`（含搜索顺序与
  「未执行任何命令」）+ **`shell: null`**（或解析到的那个被拒路径）；
  ③ **参数不全**（没有命令）：`{exit_code: null, error: "no command provided", at, shell}`。
- **命令不存在不属于 `error` 列**：外壳正常启动、只是命令找不到 → 外壳退出码 **127**，
  `.exit` 记 `{"exit_code":127,"signal":null,...}` 且**无 `error`**。
  「命令写错」≠「进程创建失败」。
- 存在即视为「命令已结束」，**优先级高于 pid 存活检测**（避免 pid 重用误判）。
- **原子写**：先写 `<exit>.tmp` 再 `renameSync` 覆盖；rename 遇到 `EPERM`/`EACCES`/`EBUSY`
  （Windows 上读者持有文件即可触发）会重试最多 50 次 × 20ms，然后清掉 `.tmp` 并抛出。

### 3.3 游标 `<contextKey>__<taskId>.json`

```json
{"offset": 4096}
```

- `offset` = 已消费到的字节位置（绝对）。
- 只在 `mode:"delta"` 且 `peek` 非真时推进；`tail` 与 `peek` **绝不**动游标。
- 文件不存在 / 空 / 坏 → offset 0（等价于从头读，**不会漏**，最多重读）（`readCursor`）。
- 游标读写在**同一会话**内串行；跨会话互不影响（R4/Q3）。
- 注入的 `deriveContextKey` 返回 null 时用 `FALLBACK_CONTEXT_KEY = "no-context"`：
  两个无 key 的会话会共用一个游标（可能多消费），这是唯一诚实的降级；真实调用总注入 deriver。

---

## 4. 四个工具

命名沿用 `myflow_` 前缀。**全部主会话专用**（R10）。四者共用 `bgSubAgentRefusal` 的第一道守卫，
并共用注入的 `deriveContextKey`。

### 4.1 `myflow_bg_start`（`createBgStartTool`）

| 项 | 规格 |
| --- | --- |
| 入参 | `command`（必填，非空，trim 后判空）、`description?`、`unattended?`（布尔，默认 false） |
| 前置 | ① 有活动任务**不要求**（后台任务属项目级，不绑定任务）；② 命令非空（**先校验再弹窗**） |
| 确认 | `ctx.ui.confirm("以后台运行这个命令？", "<command>")` |
| 非 UI | 无 `ctx.hasUI === true` 或无 `confirm` 函数：`unattended !== true` → **拒绝** `{started:false, via:"no-ui", instruction}`；`unattended === true` → 放行，`confirmed_by: "no-ui-explicit"` |
| 用户拒绝 | `confirm` 返回非 `true` → `{started:false, via:"cancelled"}`，**不 spawn、不写条目** |
| 成功返回 | `{ started: true, id, pid, log, confirmed_by }`，**文本里回显 `confirmed_by`**；`no-ui-explicit` 时再加一行 WARNING（R8） |
| spawn 同步抛错 | `{started:false, via:"error", error}`，不写条目 |
| spawn 异步 `'error'` | 监听器把条目改成 `status:"exited"` + `ended_at` + `spawn_error`；**绝不**变成未捕获异常（无监听器时会直接打崩 Pi 进程） |
| 条目写失败 | `isError` 结果 `{started:true, id, pid, log, confirmed_by, via:"error"}` + 「进程已不受管理」 |

**状态机顺序**：校验 → 确认 → spawn（`detached`, `stdio:"ignore"`, `cwd: root`）→ `unref()`
→ 写 `<id>.json` → `onStarted(id)` → 返回。**不 await 任何子进程事件**。

### 4.2 `myflow_bg_output`（`createBgOutputTool`）

| 项 | 规格 |
| --- | --- |
| 入参 | `task_id`（必填）、`mode?`: `"delta"`(默认) \| `"tail"`、`peek?`(bool)、`max_bytes?`（默认 32768，钳在 1–65536）、`lines?`（仅 tail，默认 200，钳在 1–2000）、`wait_ms?`（默认 0，钳在 0–30000） |
| `delta` | 读 `[offset, min(size, offset+max_bytes))`；`next_offset` = **已返回部分的末尾**（未返回的字节留在下次读）；`truncated` = `end < size` |
| `tail` | 从文件末尾读至多 `max_bytes` 字节，按**行边界**截断：窗口首行不完整就丢掉它，从下一完整行开始；唯一例外是单行本身超过 `max_bytes`，此时返回该行的 UTF-8 对齐片段并置 `truncated: true`（不返回空串）。`next_offset` = 当前游标（不动）。`truncated` = 窗口没覆盖整个文件（`chunkStart > 0`）；按 `lines` 丢掉更早的整行不算截断 |
| `peek` | 读但不推进游标（`next_offset` 保持当前偏移，也不写游标文件） |
| UTF-8 对齐 | `delta` 的 end 向前对齐到字符边界（退化时向前吞一个整字符）；`tail` 的起点向后对齐到字符边界（否则首字符解码成 U+FFFD） |
| 轮转检测 | `delta` 游标 > 文件长度 → 从 0 重读并带 `reset: true`（日志被轮转/重建） |
| `wait_ms` | 轮询（`WAIT_POLL_MS = 100`，≤200）直到「有新字节」或「任务已结束」或超时；用 `statSync(size)` 判断有无新字节，**不整读日志** |
| 状态自愈 | 读之前先 `resolveStatus`（**只读不写回**；回写是 `list` 的职责） |
| 返回 | `{ task_id, mode, status, exit_code, bytes, next_offset, truncated, text, reset?, failure?, signal? }` |
| 失败原因 | `failure` = `.exit.error` 优先，回退到条目的 `spawn_error`；`signal` 来自 `.exit` |
| 拒绝返回 | `{ status: "unknown", exit_code: null, bytes: 0, next_offset: 0, truncated: false, text: "", error }`（`task_id` 为空或任务不存在） |

### 4.3 `myflow_bg_list`（`createBgListTool`）

| 项 | 规格 |
| --- | --- |
| 入参 | `include_finished?`（默认 **true**）、`prune?`（默认 **false**） |
| 行为 | 先按 `prune: true` 清理（默认不动），再 `listEntries`（坏文件进 warnings），每条 `resolveAndHeal` |
| 自愈 | `resolveStatus` 结果与磁盘不一致 → 原子回写；首次进入结束态时补 `ended_at`（取 `.exit.at`，否则「现在」）。带 `spawn_error` 的条目强制 `exited`（防 pid 重用冒充 running） |
| 返回 | `{ tasks, count, warnings, warning_details, pruned, healed, include_finished }`；`warnings` 是**数量**，`warning_details` 是 `{file, reason}[]` |
| 行字段 | `id, description?, command(截断到 80 字符), command_truncated, status, exit_code, pid, started_at, ended_at, current_session, confirmed_by, unconfirmed, spawn_error?, failure?, signal?` |
| `current_session` | `started_by_context_key === 当前 contextKey` |
| `unconfirmed` | `confirmed_by === "no-ui-explicit"`（R8：显式标出，不埋） |
| `prune` | 删**已结束且 `ended_at` 早于 24 小时**的条目 + 其 `.log`/`.exit`/`.tmp` + 相关游标；无法定日期的不删 |

### 4.4 `myflow_bg_stop`（`createBgStopTool`）

| 项 | 规格 |
| --- | --- |
| 入参 | `task_id`（必填） |
| 行为 | Windows：`spawnSync("taskkill", ["/F","/T","/PID", String(pid)])`（参数数组，`windowsHide`）；其它平台：`process.kill(-pid)`，失败回退 `process.kill(pid)`（`terminateTree`） |
| 幂等 | 已结束（`.exit` 存在或 `status` 为结束态：`stopped` / `exited`）→ `{stopped:false, already_finished:true, ...}`，**不改**已有 `exit_code`、**不写**任何文件、**不调用杀进程**。已自愈为 `exited` 的条目同样视为已结束，`stop` 不会去碰那个 pid（它可能已被系统重用给无关进程） |
| 判定 | **成功与否由 `isAlive` 复检决定，不由 kill 命令的退出码决定**：等最多 1000ms（每 25ms 一次）让进程消失 |
| 成功 | `status: "stopped"`、写 `ended_at`；`exit_code` **优先取已存在的 `.exit`**（wrapper 抢先在写），否则用解析出的值 |
| 失败 | 进程仍活 → `stopped: false, status: "running", ended_at: null` + 原始 `stderr`，**不写磁盘**（不得谎报已停） |
| 返回 | `{ task_id, stopped, already_finished, status, exit_code, pid, ended_at, signal?, stderr?, error? }`；拒绝/错误时 `bgStopError` 给 `status:"unknown", pid:0, ended_at:null` |

> **平台陷阱（已实测）**：`taskkill /F` 在 Git Bash 里会被 MSYS 改写成 `F:/`。
> **必须从 Node 用参数数组调**，测试也不得经 Git Bash 转发。

---

## 5. 会话生命周期（Q1 已定）

| 时点 | 行为 |
| --- | --- |
| 扩展工厂 | `registerMyflowBackground(pi, { deriveContextKey, isSubAgent, onStarted })`：**只注册工具，不起**任何进程/定时器（`docs/extensions.md:58`） |
| `myflow_bg_start` 成功 | `onStarted(id)` 把 id 收进本会话的 `startedBackgroundIds` 集合；**不 readdir 全量注册表** |
| `session_shutdown` | ① 先抢 `shutdownDone` 标志（取消/重载/会话替换/进程退出都会汇聚到这里，正文只跑一次）；② **不杀任何任务**；③ 只遍历**本会话起过的 id**，用 `resolveStatus` 判断是否仍 `running`，→ `ctx.ui.notify` 提示；无 UI 静默跳过；④ 整体 try/catch，**绝不外抛**（抛出的 shutdown 钩子会阻塞或破坏退出） |
| id 集合 | 刻意**不清空**：本扩展不持有定时器、不持有子进程句柄，集合随会话对象一起消亡；保留它才能让幂等标志（而非「清空副作用」）成为唯一保证 |
| 新会话启动 | 不自动读注册表；`list` / `output` 时按需读（避免每次会话启动都付代价） |

**本会话持有的资源**：没有。`myflow_bg_start` 起的 wrapper 是 detached + `unref()`；
`output` 的 `wait_ms` 循环在 `execute` 内结束；`stop` 的复检同理。
所以「幂等释放」在实现上就是「什么都不用释放，且不得杀任务」。

---

## 6. 子代理守卫（R10）

三层，全部在场（与 `myflow_ask_user` 同款）：

1. **agent 白名单**：`.pi/agents/*.md` 的 `tools:` 不含这四个工具（`F7 -3` 显式断言）。
2. **`tool_call` 钩子**（`index.ts`）：

```ts
if (BG_TOOL_NAMES.has(toolEvent.toolName) && isSubAgent) {
  return { block: true, reason: "…仅主会话可管理后台任务…" };
}
```

3. **工具自身 `execute`**：四个 builder 的第一行都是 `bgSubAgentRefusal(registration)`，
   注入的 `isSubAgent === true` 时返回 `{started:false, via:"error", error}`，**在弹窗/写文件之前**。

> 为什么子代理不行：它们无 UI（只能走 `unattended` 绕过确认），且会在**共享的项目级注册表**里
> 留下活过子进程的进程 —— 没人能归因。

---

## 7. 决策记录（ADR-lite）

### ADR-1 wrapper 进程承担退出记录
- **Context**：`detached` 后无人 `wait` 子进程，退出码天然丢失 → R3 不成立。
- **Decision**：起一个 `bg_runner.mjs` 作为脱离的父，由它 spawn 用户命令并在 exit 时写 `.exit`。
- **Consequences**：多一个独立脚本（可单测）；换来「跨会话能给出退出码」。
  代价：wrapper 若被强杀则不写 `.exit` → 由 `stop` 自己置 `stopped`。

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
- **Decision**：`<taskId>.json` 一任务一文件；工具是唯一写者（原子写）；wrapper 只写自己的 `.log`/`.exit`。
- **Consequences**：`list` 需要 readdir + 逐文件解析（量小）；换来无锁、无丢更新。
  坏文件（写一半）不伪装成任何一个状态：它进 `listEntries().warnings`，并在 `list` 里报数量与明细，不抛。

### ADR-5 游标按会话（`deriveContextKey`）
- 理由见 PRD Q3。**Consequences**：`.runtime/background/cursors/` 会随会话数增长 → 由 `prune` 一并清理。

### ADR-6 Windows 用 `taskkill /F /T`，不用 `process.kill`
- **Context**：实测 `process.kill(pid)` 也杀了孙进程，但那是 **Node/libuv 的 job object** 行为，
  真实任务的 `cmd`/`bash` 后代链未覆盖。
- **Decision**：Windows 一律 `taskkill /F /T /PID`；`process.kill` 只在非 Windows 用。
- **Consequences**：多一次子进程调用（只在 stop 时）。

### ADR-7 子代理不可用
- 理由见 PRD Q4。**Consequences**：子代理若需要长跑工作，应回报主会话。

### ADR-8 自解析 POSIX 外壳，不提供 cmd.exe 兜底（P1）
- **Context**：`cmd.exe /d /s /c "<command> >> log"` 这条路上，Node 会把命令里的内层引号转义成
  `\"`，而 `cmd` 不认 —— 任何带引号的命令在兜底路径上都是坏的。
- **Decision**：`resolveShellPath` 只找 POSIX 外壳；解析不到或解析到 `cmd.exe` → 拒绝并写 `.exit.error`
  （含搜索顺序 + 「未执行任何命令」），**不回退到任何别的 shell**。
- **Consequences**：在没有 bash 的机器上后台任务不可用 —— 这是**选择**，不是缺陷（「宁可拒绝，不要假装」）。
  用户裁定记录在 `prd.md` / 交接书 §2.1。

---

## 8. 已知限制与威胁模型（诚实声明，必须进 spec）

| 限制 | 说明 |
| --- | --- |
| **无 cmd.exe 兜底** | 解析不到 POSIX 外壳（或它指向 `cmd.exe`）→ 任务被**拒绝**，`.exit` 写 `exit_code:null` + `error`，`shell:null`（或那个被拒路径），且什么都不执行。**这是选择，不是缺陷** |
| **创建被拒后的重试预算** | 外壳创建被 OS 瞬时拒绝时，wrapper 最多重试 8 次 / 约 7.2s（硬上界 10s）才落 `.exit`；**工具本身仍立刻返回**（R1 不受影响），但「已退出」状态与退出码会晚到这 7.2s 之后 |
| **`stop` 与 `start` 的窗口竞态** | `start` 先 spawn 再写条目：若 `stop` 恰好在这个窗口里跑，条目还不存在，`stop` 会报「没有这个任务」。窗口极小，不做补偿 |
| **孤儿窗口** | spawn 成功但工具在写注册表前崩溃 → 有一个**无注册表条目**的后台进程。窗口极小；**不做事务补偿**，但 `list` 无法发现它（它是「不可见的」）。诚实记录，不假装解决 |
| **`tail` 的单行超限例外** | `tail` 按行边界截断，唯一例外是单行本身超过 `max_bytes`：此时返回该行的 UTF-8 对齐片段并置 `truncated: true`（返回空串更没用）。就是说 `tail` 可能多出一条**片段行** |
| **`syswow64` 未跳过** | `findOnPath` 只跳过 `system32` / `sysnative`。32 位进程视角下的 `SysWOW64\bash.exe`（同一个 WSL 启动器）仍可能被选中 |
| **无法识别的 spawn 错误会被重试** | `isRetryableSpawnError` 对不认识的 `code`（包括 `ERR_*` 这类确定性错误）返回 `true`，所以它们会白等约 7.2s 才落 `.exit` |
| **退出码可能为 `null`** | `stop` 强杀的、或 wrapper 自身崩溃的，只能标 `stopped`/`exited` 而**无退出码** |
| **pid 重用** | 存活检测在极长时间后可能把别人的进程当成本任务的。**已修复的部分**：`.exit` 优先，且已记为 `exited`/`stopped` 的条目**粘住**（不再被报成 `running`，也不会被 `stop` 误杀）；`list` 还会把带 `spawn_error` 的条目强制成 `exited`。**仍存在的残余风险**：任务在**第一次被任何读者观察到之前** pid 就被重用 —— 那种情况下磁盘上没有任何记录能证明它已死，它会被当成 `running` |
| **无沙箱** | 后台命令以当前用户权限跑，**没有任何权限系统**（横评 `GAP-PERM-*` 是独立任务）。确认门是**唯一**的把关 |
| **确认门不是安全边界** | 与 plan 批准门同款：`unattended: true` 可绕过，只留痕 |
| **不做资源限制** | 不限制 CPU/内存/进程数；不做超时强杀（长任务本来就该长跑） |
| **不做输出轮转** | `.log` 会无限增长；`prune` 只删**已结束**任务的日志。运行中的长任务日志需用户自理（`delta` 的 `reset` 只在**读**侧兜住「日志被外部重建」） |
