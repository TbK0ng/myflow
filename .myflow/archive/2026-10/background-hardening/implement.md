# implement: 顺序、测试与提交

> 契约定在 `design.md`；本文件只定「按什么顺序改哪些文件，拿什么证明改对了」。
> 用户要求沿上一任务：**每个工作项自带测试，并单独一次提交**（提交由主会话做）。

## 0. 硬约束

| 约束 | 依据 | 含义 |
| --- | --- | --- |
| implement/check 一次只能一个 | 无 `writesUnder` | 七批**全部串行** |
| 每次 dispatch 有 `timeoutMs`（默认 15 分钟） | `.myflow/workflow.md` | 每批只做一个工作项；超时就拆小重派，不重做 |
| 测试必须清空 `MYFLOW_*` | spec Pre-Development Checklist | 固定命令见 §3 |
| `taskkill` 只能从 Node 用参数数组调 | 已实测（Git Bash 改写 `/F`） | 测试不得经 Git Bash 转发 |
| 基线 | 上一任务归档时 | **332 / 332** 绿；任何一批不得让它变红；本任务终态 **354 / 354** |
| 每批完成后由**主会话**跑全量并提交 | 保证"提交 = 已验证" | 子代理不提交 |

## 1. 批次总览

| 批 | 项 | 产出 | 提交（实际，`git log --oneline`） |
| --- | --- | --- | --- |
| `H1` | R1 `syswow64` | `bg_runner.mjs`、`tests/bg-runner.test.ts` | `e467c15` Skip the SysWOW64 view of the WSL launcher |
| `H2` | R2 `ERR_*` 不重试 | `bg_runner.mjs`、`tests/bg-runner.test.ts` | `04f6682` Do not retry Node's deterministic ERR_* failures |
| `H3` | R3 `ExitRecord` 说真话 | `background.ts`、`tests/bg-output.test.ts` | `b3d8213` Return the shell that ran, and the retries it took |
| `H4` | R4 shutdown 判据 | `index.ts`、`tests/bg-lifecycle.test.ts` | `d22def9` Respect hasUI when the shutdown notice is decided |
| `H5` | R5 `cwd` | `bg_runner.mjs`（`--cwd`）、`background.ts`、`tests/bg-start.test.ts`、`tests/bg-runner.test.ts` | `be293a4` Run a background command in a subdirectory |
| `H6` | R6+R7 `starting` + `.pid` | `bg_runner.mjs`、`background.ts`、四个 bg 测试文件 | `10c977f` Close the orphan window with a pid handshake |
| `H7` | 契约同步 | `.myflow/spec/harness/index.md`、`harness-conventions.md`、`design.md`、`implement.md`、工具描述、`background.ts` 头注释 | Document the starting state and the pid handshake |

**顺序理由**：H1–H4 是互不相干的单点修复（各自可独立单测）；H5 加参数但不动状态机；
H6 唯一动状态机，必须单独成批、单独全量；H7 在代码定稿后写，否则文档描述未落地的东西。

## 2. 各批详细

### H1 — `syswow64`（目的：**拒绝 WSL 启动器**，本机不装 WSL）
- 环境前提（用户明示）：本机**没有** WSL，也不会装；唯一 POSIX 外壳是 Git for Windows bash。
  H1 不是“支持 WSL”，而是把三个 WSL 启动器视图（`system32` / `sysnative` / `syswow64`）全部排除。
- `findOnPath` 的跳过集合：`system32` / `sysnative` / **`syswow64`**。
- 只改这一个集合与它的注释（注释要说明三者都是 WSL 启动器的视图，本机不提供 WSL）。
- 测试：`bg-runner -7` 里补两条——
  ① PATH 只含 `...\SysWOW64\bash.exe` 时解析结果为 `null`；
  ② **本机**解析结果必须是 Git Bash（`settings.json` 的 `shellPath` 或标准安装路径），
  且不得是任何 `system32` / `sysnative` / `syswow64` 下的路径。

### H2 — `ERR_*` 不重试
- `isRetryableSpawnError`：code 以 `ERR_` 开头 ⇒ `false`（确定性）。
- 保持：`EAGAIN/ENOMEM/EMFILE/ENFILE` 可重试；未知 code 可重试；无 code 可重试。
- 测试：`ERR_INVALID_ARG_TYPE` → false；`UNKNOWN` → true；`undefined` → true；`EAGAIN` → true；
  再加一条**行为**用例：注入 `spawn` 同步抛 `ERR_INVALID_ARG_TYPE` 且 `maxRetries` 足够大 → **尝试次数仍为 1**。

### H3 — `ExitRecord` 与 `myflow_bg_output`
- `ExitRecord` 补 `shell?: string | null`、`retries?: number`。
- `myflow_bg_output`：任务已结束（`.exit` 存在）时，返回体额外带 `shell`；`.exit.retries` 存在时带 `retries`。
- 测试：`bg-output` 补一条——手工写一个 `{exit_code:0, shell:".../bash.exe", retries:2}` 的 `.exit`，
  断言返回体里 `shell`/`retries` 与文件一致；没有 `retries` 时不出现该字段。

### H4 — shutdown 的 `hasUI`
- `index.ts` 的 `session_shutdown`：`ctx.hasUI === false` ⇒ 不 notify（即使 `ctx.ui.notify` 存在）。
- 测试：`bg-lifecycle -7`——`hasUI:false` 且给出 `notify` 桩、起一个真任务 → shutdown 后**通知数 0**、任务仍活。

### H5 — `cwd`
- `bg_runner.mjs`：新增 `--cwd <path>`；`runWrapper` 用它（缺省 `process.cwd()`）；`runCommand` 已经接受 `cwd`。
- `background.ts`：
  - `BG_START_PARAMETERS.cwd`（string，可选）；
  - 校验：`resolve(root, cwd)`（相对按根）；必须**按路径段**落在根内（大小写不敏感、折叠 `..`），
    复用 `agents.ts` 里同一套判定思路（**不要**复制一份不同的实现——若无法复用，就写一个共享 helper 并让两处都调它）；
  - 必须是存在的目录（`statSync().isDirectory()`）；
  - 校验失败 ⇒ `{started:false, via:"error"}`，**不弹窗、不写条目、不 spawn**；
  - 确认门文本：`command` + `cwd`（解析后的绝对路径）；
  - 条目写解析后的 `cwd`；spawn 时把 `--cwd <path>` 传给 wrapper。
- 测试（`bg-start`）：
  - 起 `pwd > marker` 于 `cwd:"app"` → marker 里的路径是 `<root>/app`（真进程）；
  - `cwd:"../outside"`、根外绝对路径、不存在目录 → 全部拒绝，且 `confirm`/`spawn` 计数为 0、注册表为空；
  - 确认门文本包含 `app`（用 confirm 桩捕获参数）。

### H6 — `starting` + `.pid` 握手（**唯一动状态机的批次**）
- `bg_runner.mjs`：解析参数成功后、**任何命令执行之前**写 `<id>.pid` = `{pid, at}`（原子写 + 与 `.exit` 同一套重试）。
- `background.ts`：
  - `STATUS` 类型补 `"starting"`；`STARTING_TIMEOUT_MS = 60_000`；
  - `pidPath(dir,id)` + `readPid(dir,entry)`（`.pid` → 条目 pid → 0），并让 `resolveStatus` / `stop` / shutdown 都用它；
  - `resolveStatus` 六档（见 design §2.2）；
  - `createBgStartTool`：**先写条目**（`status:"starting"`, `pid:0`）→ spawn → 回填 pid + `status:"running"`；
    spawn 失败路径沿用 `spawn_error` + `exited`；
  - `createBgStopTool`：`starting`（即无 `.pid`、无存活 pid）⇒ 明确错误，不写盘不杀；
  - `createBgListTool`：显示 `starting`；超时自愈为 `exited`；`prune` 连带删 `.pid`；
  - `createBgOutputTool`：`starting` 不报错。
- 测试（分散到四个文件）：
  - `bg-start -11`：注入 spawn 桩，在桩里**读条目**并断言此时 `status === "starting"`（证明先后顺序）；
  - `bg-runner -11`：真子进程跑 `cat <id>.pid`（或命令里 `test -f`），断言命令执行时 `.pid` 已存在且 pid 与 wrapper 一致；
  - `bg-registry -9`：`.pid` 存在 ⇒ `resolveStatus` 用它的 pid；`.pid` 与条目 pid 冲突时 `.pid` 胜；`starting` 未超时 ⇒ `starting`；超时 ⇒ `exited`（注入时钟）；
  - `bg-stop -8`：`starting` + 无 pid ⇒ 错误、`terminateCalls === 0`、磁盘未改；写入 `.pid` 后同一任务可正常 stop；
  - `bg-list -10`：`starting` 行可见；超时自愈并回写；`prune` 删掉 24h 前的 `starting` 残留（含 `.pid`）。

### H7 — 契约同步
| 文件 | 要加/改什么 |
| --- | --- |
| `.myflow/spec/harness/index.md` | `starting` 状态与六档判据；`.pid` 文件契约（写者、时机、原子写、`readPid` 优先级）；`cwd` 的允许范围与确认门要求；`ExitRecord` 的 `shell`/`retries`；shutdown 的 `hasUI` 判据；Known limits 删掉已修的 4 条（syswow64、ERR_*、孤儿窗口、stop 竞态），只留「pid 身份」「日志轮转」「无沙箱/资源限制」并各写一句为什么 |
| `design.md` | §2.2 六档、§3.3 `.pid`、§4.1 `cwd`、§7 保留项——与本批实现一致 |
| `implement.md` | §1 批次表补实际提交、§3 测试清单按真实用例名对齐 |
| `background.ts` 工具描述 | `myflow_bg_start`：`cwd` 的范围；`myflow_bg_list`：`starting` 的含义 |

**验收**：spec 里不再有任何已修项；`grep -rn "orphan\|syswow64\|ERR_\*" .myflow/spec/` 只剩"已修/为何不修"的说明。

## 3. 测试清单（每批的"回退即红"）

统一命令：
```bash
env -u MYFLOW_AGENT_TYPE -u MYFLOW_CONTEXT_ID -u MYFLOW_SKIP_BREADCRUMB -u MYFLOW_WRITES_UNDER node --test tests/
```

| 批 | 必有的断言（删掉被测判断就变红） | 真实用例（`tests/bg-*.test.ts`） |
| --- | --- | --- |
| H1 | SysWOW64 视图下的 bash 不被采用；**本机解析结果必须是 Git Bash**（不得是任何 WSL 启动器视图） | `bg runner -7`（跳过集合）、`bg runner -7b`（本机真实解析） |
| H2 | `ERR_INVALID_ARG_TYPE` 尝试次数 = 1；`UNKNOWN`/无 code 仍 >1 | `H2 -1`（谓词层）、`H2 -2`（行为层） |
| H3 | output 返回体的 `shell`/`retries` 与 `.exit` 一致；缺 `retries` 时字段不出现 | `H3 -1`、`H3 -2`、`H3 -3`（拒绝记录 `shell:null`）、`H3 -4`（未结束不带这两个字段） |
| H4 | `hasUI:false` ⇒ 通知数 0，任务仍活 | `F7 -7` |
| H5 | 真进程 `pwd` 落在 `app`；三类越界零副作用；确认门含 cwd | `H5 -1`（真进程）、`H5 -2`（`../`）、`H5 -3`（根外绝对）、`H5 -4`（不存在）、`H5 -5`（确认门文本）、`bg runner H5 -6`（`--cwd` 生效 + 缺值硬错误） |
| H6 | spawn 时条目已是 `starting`；命令执行时 `.pid` 已在；六档各一条；超时自愈；stop 对 `starting` 不杀；**握手写失败 fail-closed** | `H6 -11`（spawn 前条目已存在）、`H6 -12`（`.pid` 早于命令）、`H6 -13`（拒绝外壳也写 `.pid`）、`H6 -14`（`.pid` 写失败即不执行命令）、`H6 registry -9`（七项：读序、冲突、六档、超时）、`H6 -8`（stop 拒绝 → `.pid` 后正常）、`H6 -10`（list 显示/自愈/prune、活 pid 不得被 prune）、`H6 -5`（output 对 `starting` 不报错） |
| H7 | 文档契约测试（`skills-hygiene` / `workflow-invariant` / `scaffold`）全绿 + §4 的 grep | 全量套件 |

## 4. 完成判据

| PRD AC | 落在 |
| --- | --- |
| R1 | `bg runner -7` / `bg runner -7b` |
| R2 | `H2 -1` + `H2 -2` |
| R3 | `H3 -1` / `-2` / `-3` / `-4` |
| R4 | `F7 -7` |
| R5 | `H5 -1` … `H5 -5` + `bg runner H5 -6` |
| R6 | `H6 -11` + `H6 -12` + `H6 -13` + `H6 registry -9` + `H6 -5` + `H6 -10` |
| R7 | `H6 -8` |
| 既有 332 不回归 | 每批全量（终态 **354 / 354**） |
| 每项单独提交 | §1 的七批 |

## 5. Dispatch 模板

```
Active task: .myflow/tasks/background-hardening

本次批次：<H1..H7>（一个工作项）
目标：<一句话>

必读：
- .myflow/tasks/background-hardening/design.md   （本批对应的 §）
- .myflow/tasks/background-hardening/implement.md（§2 的本批小节、§3 的断言）
- 相关代码：<按批给>

禁止：改 prd.md；改本批之外的工具；削弱既有断言；经 Git Bash 调 taskkill。
做完报告：改了哪些文件、逐条测试结果与"删哪个判断会变红"、全量测试数、未做/需决策清单。
```

## 6. 评审项

| # | 事项 | 结论 |
| --- | --- | --- |
| `S-1` | `starting` 超时 60s 是否合适 | **采纳 60s**：`STARTING_TIMEOUT_MS = 60_000`；`resolveStatus` 的 `nowMs` 可注入，边界由 `H6 registry -9` / `H6 -10` 验证，无需 sleep |
| `S-2` | `cwd` 确认门是否在"等于项目根"时也显示 | **采纳总是显示**：`H5 -5` 断言非根与等于根两种情况下对话框文本都含目录 |
| `S-3` | `myflow_bg_output` 对 `starting` 是否要给提示 | **采纳只给状态**：`H6 -5` 断言 `status:"starting"`、不报错、不带 `.exit` 字段 |

## 7. 回退与失败处理

| 情形 | 处理 |
| --- | --- |
| 某批超时被截断 | 读 `.myflow/.runtime/subagent-logs/` → 拆小重派；不重做已完成部分 |
| 既有用例变红 | 停下报告；**不得**为让新用例通过而改既有断言 |
| 发现 `.pid` 与 `.exit` 的时序在某平台不可靠 | 停止实现，回 Phase 1 修 `design.md`（ADR-8）并记录实测 |
| 运行态污染工作树 | `.myflow/.runtime/` 已 gitignore；别处被写立即报告 |
