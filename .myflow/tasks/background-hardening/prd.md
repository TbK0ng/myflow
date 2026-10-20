# prd: background-tasks hardening — 7 条"已知限制"其实是待办

## Goal

修掉 `background-tasks` 归档时记在 spec 里的 7 条"已知限制"中**属于缺陷或功能缺口**的那部分。
判据：一条"限制"只有在**无法修**或**属于别的任务边界**时才配留在表里；其余必须变成代码。

用户原话（授权来源，逐字保留）：

> known limits这些不大对吧，这些问题绝对是要解决的吧

以及范围选择 **1**："开任务：1–7 全做（先 1–5 便宜项，再 6–7 状态机；8 仅当…）"——
即 **不做** pid 身份校验（第 8 条），**不做**日志轮转（第 10 条），**不做**沙箱/资源限制（第 9 条，属权限系统）。

## 上一任务留下的分类（本任务的分界线）

| # | 上一任务的说法 | 本任务判定 |
| --- | --- | --- |
| 1 | `syswow64` 未跳过 | **缺陷**，一行 |
| 2 | `ERR_*` 被当可重试（白等 ~7.2s） | **缺陷**，一行 |
| 3 | `ExitRecord` 类型缺 `shell`/`retries` | **契约不实**，类型 + 一个真实消费点 |
| 4 | shutdown 判"无 UI"用 `ui.notify` 存在性 | **缺陷**，判据写错 |
| 5 | 没有 `cwd` 参数 | **功能缺口**（上一任务归错类，它不是限制） |
| 6 | 孤儿窗口（spawn 后、写条目前崩溃） | **缺陷**，改状态机可真正关闭 |
| 7 | stop 与 start 的窗口竞态 | **缺陷**，与 6 同一机制 |

## 已定决策（问答记录见 `questions.jsonl`）

- **Q1（用户选 A）**：孤儿窗口用 **`.pid` 握手**关闭 —— wrapper 在**执行命令之前**先写 `<id>.pid`；
  工具改为 **spawn 之前**就写 `starting` 条目。命令只在"我们已记下 pid"之后才可能被执行。
- **Q2（用户选 A）**：`cwd` 必须解析到**项目根之内**（相对/绝对皆可，越界或 `..` 逃逸一律拒绝），
  与 `writesUnder` 同一种安全姿态。

## 环境前提（用户明示）

**本机不装 WSL，也不依赖 WSL。** 唯一的 POSIX 外壳是 **Git for Windows bash**
（Pi 的 `settings.json` 里 `shellPath` 指向 `C:/Program Files/Git/bin/bash.exe`）。

所以 R1 的语义是**拒绝** WSL 启动器，而不是“支持 WSL”：`%SystemRoot%\System32\bash.exe` 是
WSL 入口，`Sysnative` 是它在 32 位进程下的别名，`SysWOW64` 是 32 位视图 —— 三者都不能被采用。
外壳解析的终点永远是 Git Bash（显式 override 除外），解析不到就是拒绝（上一任务 P1 已定）。

## Requirements

### R1 `syswow64`
`findOnPath` 跳过 `system32` / `sysnative` / **`syswow64`**（三者都是 WSL 启动器的 32/64 位视图）。

### R2 `ERR_*` 不重试
`isRetryableSpawnError`：Node 自身的 `ERR_*`（如 `ERR_INVALID_ARG_TYPE`、`ERR_INVALID_CALLBACK`）是**确定性**错误，
必须立刻失败。仍然可重试的是：资源类（`EAGAIN/ENOMEM/EMFILE/ENFILE`）、无法识别的 code、以及**没有 code**（232 → UNKNOWN）。

### R3 `ExitRecord` 类型说真话
`ExitRecord` 补 `shell?: string | null` 与 `retries?: number`；并让一个**真实消费点**用上它：
`myflow_bg_output` 对已结束任务返回 `shell`（实际执行的外壳）与 `retries`（仅重试过时）。
类型不是为了好看——有读者，才值得写进契约。

### R4 shutdown 的"无 UI"判据
`session_shutdown` 只在 `ctx.hasUI !== false` 且 `ctx.ui.notify` 存在时提示。
`hasUI === false` 时**静默**，即使宿主仍提供了 `notify`。

### R5 `cwd` 参数
`myflow_bg_start` 新增可选 `cwd`：
- 相对路径按**项目根**解析；绝对路径也必须在根内；
- 必须存在且是目录；
- 越界（`..` 逃逸、绝对路径指向根外、大小写差异绕过）一律**拒绝**，不 spawn、不写条目；
- 确认门**同时显示** `cwd` 与 `command`（否则用户确认的不是真正会执行的东西）；
- 注册表条目记录解析后的绝对 `cwd`；wrapper 用 `--cwd` 拿到它并在此目录执行命令。

### R6 孤儿窗口（`.pid` 握手 + `starting`）
- 工具在 spawn **之前**写条目：`status: "starting"`、`pid: 0`（语义 = "尚未确认"）。
- wrapper 在解析参数成功后、**执行命令之前**写 `<id>.pid` = `{pid, at}`（原子写）。
- 读者取 pid 的顺序：`.exit` 存在 → 结束；否则 `<id>.pid` 的 pid；否则条目的 pid。
- 结束状态仍为三档，新增 `starting` 作为**未确认**态；`starting` + 无 `.pid` + 无存活 pid + 超过 `STARTING_TIMEOUT_MS`（60s）→ 自愈为 `exited`（`exit_code: null`，从未启动）。
- 命令的执行以"wrapper 已写下 `.pid`"为前提 ⇒ **孤儿窗口被真正关闭**，不是缩小。

### R7 stop vs start 竞态
`myflow_bg_stop` 对 `starting` 且无 `.pid`/无存活 pid 的条目：返回明确错误（"尚未可寻址，稍后重试"），
**不得**把它标成 `stopped`，也不得杀任何进程。一旦 `.pid` 出现，stop 按其 pid 正常执行。

## Acceptance Criteria

- [ ] `syswow64` 里的 bash 不被采用（解析结果为 `null` 或被拒），有断言。
- [ ] `ERR_INVALID_ARG_TYPE` 不重试：只尝试 1 次；`UNKNOWN`/无 code 仍重试。
- [ ] `ExitRecord` 读取后 `shell`/`retries` 不再丢失；`myflow_bg_output` 对已结束任务返回 `shell`。
- [ ] `hasUI:false` 且提供了 `notify` 时，shutdown **不**提示。
- [ ] `cwd:"app"` 能在 `app/` 里执行（用真进程断言工作目录）；`cwd:"../x"`、根外绝对路径、不存在目录**全部拒绝且零副作用**。
- [ ] 确认门文本包含 cwd（非根时），且拒绝路径不弹窗。
- [ ] 条目在 spawn 之前就存在（用注入的 spawn 桩断言：spawn 被调用时条目已 `starting`）。
- [ ] wrapper 在跑命令前写下 `.pid`（用真子进程断言：命令执行时 `.pid` 已存在且 pid 等于 wrapper 的 pid）。
- [ ] `starting` 超时自愈为 `exited`（时钟注入）。
- [ ] stop 对 `starting` 返回明确错误且不杀进程；`.pid` 出现后能正常 stop。
- [ ] 全量套件绿；每个工作项单独一次提交；既有 332 条不回归。

## 不做（明确出界）

- pid 身份校验（第 8 条）：需要平台特定进程创建时间查询，收益窄，另案评估。
- 日志轮转（第 10 条）：策略未定（截断会丢历史 / 滚动要命名契约），另案。
- 沙箱、资源限制、确认门作为安全边界（第 9 条）：属权限系统任务。

## 风险

| 风险 | 缓解 |
| --- | --- |
| `starting` 引入第 4 个可达状态 → 契约、工具返回体、测试全要同步 | 单列一个批次（H6），并在同一批里改 spec 与工具描述 |
| `.pid` 握手与 `.exit` 的写入顺序在崩溃时可能留下"有 `.pid` 无 `.exit` 且 pid 已死" | 已有规则覆盖：pid 死且无 `.exit` → 自愈 `exited` |
| 既有 332 条里有断言假定 `.exit`/`status` 的旧时序 | 每批全量；出现红先判断是不是契约该更新，不得改断言迎合 |
