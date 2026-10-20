# design: hardening — 机制、契约与批次边界

> 契约的最终落点仍是 `.myflow/spec/harness/index.md`；本文件解释**为什么这样改**，`implement.md` 定**顺序与验收**。

## 1. 需求 → 机制

| # | 需求 | 落点 | 强制 |
| --- | --- | --- | --- |
| R1 | `syswow64` 跳过（**拒绝 WSL 启动器**，本机无 WSL） | `bg_runner.findOnPath` 的跳过集合 | 断言解析结果为 `null`，且本机解析结果必须是 Git Bash |
| R2 | `ERR_*` 不重试 | `isRetryableSpawnError` 的确定性列表 | 断言尝试次数 = 1 |
| R3 | `ExitRecord` 说真话 | `ExitRecord` 类型 + `myflow_bg_output` 返回 `shell`/`retries` | 消费点有断言 |
| R4 | 无 UI 判据 | `index.ts` shutdown 的 `hasUI !== false` | mock `hasUI:false` 断言不 notify |
| R5 | `cwd` | `BG_START_PARAMETERS.cwd` + `--cwd` + 确认门 | 真进程断言 `pwd`；越界零副作用 |
| R6 | 孤儿窗口 | 先写 `starting` 条目 + wrapper 写 `<id>.pid` | 真子进程断言"跑命令时 `.pid` 已在" |
| R7 | stop 竞态 | `stop` 对 `starting` 明确拒绝 | 断言不杀、不写 `stopped` |

## 2. 状态机（本任务的核心改动）

### 2.1 四个可达状态

```
starting ──(wrapper 写 .pid)──▶ running ──(exit)──▶ exited
   │                              │
   │(60s 内无 .pid 且无存活 pid)     └──(stop)──────▶ stopped
   └──────────────────────────▶ exited (exit_code:null, 从未启动)
```

- **`starting`**：条目已存在、pid 未确认。只可能出现在"工具已写条目、wrapper 还没握手"的毫秒级窗口。
- `unknown` 仍不可达（类型保留，`resolveStatus` 不返回）。

### 2.2 `resolveStatus` 判据顺序（六档）

1. `.exit` 存在 ⇒ `exited`（读 `exit_code`，带出 `failure`/`signal`）
2. `entry.status === "stopped"` ⇒ `stopped`
3. `entry.status === "exited"` ⇒ `exited`（**粘滞**，上一任务已加）
4. **pid 存活**（pid 来源见 §2.3）⇒ `running`
5. `entry.status === "starting"` 且 `now - started_at <= STARTING_TIMEOUT_MS` ⇒ `starting`
6. 否则 ⇒ `exited`（`exit_code: null`，自愈）

`STARTING_TIMEOUT_MS = 60_000`。第 5 档必须在第 6 档之前，且第 4 档必须压过第 5 档
（`.pid` 或条目 pid 存活 = 已确认，不能因为仍写着 `starting` 就报 `starting`）。

### 2.3 pid 来源（`readPid`）

```
readPid(dir, entry) = <id>.pid 里的 pid（若存在且为正整数）
                    ?? entry.pid（若为正整数）
                    ?? 0
```

- `<id>.pid` 是**权威**：它由 wrapper 自己写，写在自己执行命令之前。
- 条目里的 `pid` 只是工具 spawn 后回填的缓存，wrapper 崩溃时可能仍是 0。
- 两个来源都在 `isAlive` 之前解析，`resolveStatus` / `stop` / `shutdown` 共用**同一个** `readPid`。

## 3. 文件契约（`.myflow/.runtime/background/`）

| 文件 | 写者 | 内容 |
| --- | --- | --- |
| `<id>.json` | 只有工具 | 注册表条目（§3.1） |
| `<id>.log` | 外壳 | 命令输出（`exec >>`） |
| `<id>.exit` | wrapper | 结束记录（§3.2） |
| **`<id>.pid`** | **wrapper** | **`{"pid":N,"at":"ISO"}`，原子写，早于命令执行** |
| `cursors/<key>__<id>.json` | 工具 | 读游标 |

### 3.1 条目字段（新增/变更）

- `status`：`starting | running | exited | stopped`（`unknown` 仅存在于类型与两个拒绝返回体）。
- `pid`：spawn 前的条目写 `0`；spawn 后回填。**读者一律走 `readPid`，不要直接信任它**。
- `cwd`：解析后的**绝对路径**，恒在项目根之内（R5）。

### 3.2 `<id>.exit`
不变（`{exit_code, signal, at, shell, retries?, error?}`）；`shell:null` 仍表示"拒绝"。

### 3.3 `<id>.pid`（新增）
- 由 wrapper 在 `parseArgs` 成功后、`shell/日志/命令` 之前写入。
- **显式参数**：工具把它作为 `--pid <path>` 传给 wrapper，缺值是硬错误；路径不由任何一侧推导。
- 原子写（`.tmp` → rename + 与 `.exit` 同一套 50×20ms 重试）。
- **写失败即 fail-closed**：wrapper 写一个指出写入失败的 `.exit`（`exit_code:null`）并**不执行命令** ——
  否则握手形同虚设，孤儿窗口会重新打开。
- 存在即表示"wrapper 曾经活着"；**不**表示命令正在跑（拒绝外壳时也会写）。
- 删除：`prune` 随条目一起删（含 `.tmp` 兄弟文件）。

## 4. 四个工具的变更

### 4.1 `myflow_bg_start`
| 项 | 规格 |
| --- | --- |
| 入参 | 新增 `cwd?`（string）：相对项目根解析；绝对也必须落在根内；必须存在且是目录 |
| 校验顺序 | 空命令 → **cwd 校验**（失败即拒绝，不弹窗、不写条目、不 spawn）→ 确认门 → 写 `starting` 条目 → spawn → 回填 pid/`running` |
| 确认门 | 文本包含 `command` 与**解析后的 cwd**（当 cwd ≠ 项目根时；根内默认也显示，避免歧义） |
| 拒绝 | cwd 越界/不存在：`{started:false, via:"error", error}`；不产生任何文件 |
| 竞态 | 条目先写、再 spawn：`stop` 在窗口内看到 `starting` → 明确拒绝（§4.4） |

### 4.2 `myflow_bg_output`
- 已结束任务：额外返回 `shell`（`.exit.shell`）与 `retries`（仅当存在）。
- `starting` 任务：正常返回（日志可能为空），`status:"starting"`，不报错。

### 4.3 `myflow_bg_list`
- 显示 `starting` 行（`status` 字段直接给 `starting`）。
- 自愈：`starting` 超时 → `exited`（`exit_code:null`）并回写；回写失败不影响本次结果（沿用 D3）。
- `prune`：删除 `starting` 且 `started_at` 早于 24h 的条目（从未启动的残留），连同 `.pid`。

### 4.4 `myflow_bg_stop`
- `readPid` 取 pid（`.pid` 优先）。
- 解析结果为 `starting` 即拒绝："任务尚未可寻址（starting），稍后重试"；**不写 `stopped`、不杀任何东西**。
  实现里 `resolveStatus` 的第 4 档压过第 5 档，所以"`starting` 且 pid 活着"不可能出现 ——
  拒绝集就是全部 `starting`（即无 `.pid`、无存活 pid）。
- 否则按现有逻辑（幂等、`taskkill /F /T`、失败不谎报）。

## 5. 生命周期
`session_shutdown`：只把 `hasUI === false` 当"无 UI"（R4）；其余行为不变（不杀、幂等、不外抛）。

## 6. ADR

### ADR-8 `.pid` 握手而不是"先写条目 + 超时自愈"
- Context：spawn 与写条目之间崩溃 = 不可见进程。只把条目提前，仍留一个窗口。
- Decision：wrapper 在自己**执行命令之前**写下 `<id>.pid`。
- Consequences：命令的执行以"pid 已落盘"为前提 ⇒ 孤儿窗口**关闭**而非缩小；
  代价是多一个文件契约、`readPid` 成为唯一取 pid 入口、6 档判据。
- Rejected：事务补偿 / 事后扫进程表（Windows 上无法可靠归属，且与 pid 重用同病）。

### ADR-9 `cwd` 限定在项目根内
- Context：子目录/monorepo 需要 cwd；确认门必须显示真正会执行的目录。
- Decision：相对按根解析，绝对也必须落在根内，越界拒绝。
- Consequences：无法在项目外跑后台任务（有意的：注册表/日志/游标都是项目级）；
  与 `writesUnder` 的包含判定复用同一套"按段比较、大小写不敏感、折叠 `..`"。
- Rejected：任意目录（确认门会变成"用户看不懂的路径"）、只允许直接子目录（任意但僵化）。

### ADR-10 `starting` 是状态，不是"running 加个标志"
- Context：需要一个"条目在、pid 未确认"的表示。
- Decision：第四态 `starting`，60s 后自愈为 `exited`。
- Consequences：`list`/`output`/契约/测试都要认识它；换来"半启动任务可见"。

## 7. 本次**不**解决的（并说明为什么配留下）

| 项 | 为什么仍留在表里 |
| --- | --- |
| pid 身份（pid 在首次观察前被复用） | 需要 OS 级进程创建时间比对（Windows WMI / POSIX `/proc`），收益只在"wrapper 被外力杀掉 + pid 立即复用"这一窄条件；仅值得在 `stop` 前查，不应进 `list` 热路径。另案评估 |
| 日志轮转 | 策略未定：截断丢历史、滚动新增命名契约；需产品决策 |
| 无沙箱/无资源限制/确认门非安全边界 | 属权限系统（横评 `GAP-PERM-*`），后台任务无法独立解决 |

> 本文件是 2026-10 实现期的快照；**活契约以 `.myflow/spec/harness/index.md` 为准**，两者不一致时以 spec 为准并同步修正本文件。
