# handoff.md — 真后台长任务：交接书（2026-10-15）

> 本文件**不是计划文件**（`PLAN_FILES = prd.md / design.md / implement.md`），改它**不影响** `plan_hash`，
> 因此不会让 `approval.json` 失效。它也**不在注入列表**（注入 = prd → design → implement → info + jsonl），
> 所以不会占用子代理的 131072 字节上下文预算。
>
> 写这份文件的直接原因：用户选择「先停下，把结论与剩余问题写成交接文档」。
> 结论一句话：**F1–F6 已落地且全绿，但四个工具还没有任何入口（F7 未做），所以"真后台能力"现在等于不可用。**

---

## 0. 一眼看懂的状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 任务 | `background-tasks`，in_progress，指针已恢复 | `task.py current` → `.myflow/tasks/background-tasks	in_progress` |
| 批准门 | **有效**（无需重过） | `plan-hash` = `sha256:87684f5…` = `approval.json.plan_hash`；`questions_answered: 13` |
| 代码 | F1–F6 全部提交（15 个 bg 相关提交） | `git log --oneline -- .myflow/scripts/bg_runner.mjs .pi/extensions/myflow/background.ts tests/bg-*.test.ts` |
| 全量测试 | **316 / 316 绿**（25.8s，清空 `MYFLOW_*` 跑） | 本次会话实跑 |
| F7 接线 | **未做** | `index.ts` 只 import 了 subagent / ask / approval；`background.ts` 全仓无人 import |
| F8 契约同步 | **未做** | `.myflow/spec/harness/index.md`（750B）里 `background` / `bg_` 出现 **0 次** |
| 用户的 P1 决定 | **未落地** | 见 §2.1；cmd 兜底仍在代码与工具描述里 |

规模参考：`background.ts` 2040 行；`bg_runner.mjs` 722 行；bg 测试 3118 行（6 个文件）。

---

## 1. 已交付的东西（按提交，含它解决了什么）

| 提交 | 内容 | 关键点 |
| --- | --- | --- |
| `a882e72` | **F1** `bg_runner.mjs`：wrapper 跑命令、自记退出记录 | ADR-1 的落地；没有它跨会话拿不到退出码 |
| `2dfc20d` | **F2** 注册表：taskId 形状、条目读写、`resolveStatus` 四分支、`prune`、游标 | `.exit` 优先于 pid 存活（防 pid 重用） |
| `36ebf91` | **F3** `myflow_bg_start`：确认门 + 非 UI 留痕 + 立刻返回 | `confirmed_by: ui-confirm \| no-ui-explicit` |
| `f125bb0` | spawn 失败要大声报 | `spawn_error` 字段 |
| `de8afd0` | **F4** `myflow_bg_output`：delta / tail / peek / `wait_ms` / 截断标注 | `next_offset` 必须指向**已返回部分的末尾** |
| `2c6f243` | **F5** `myflow_bg_list` + 自愈 + prune | 自愈要**回写磁盘** |
| `8da59f5` | **F6** `myflow_bg_stop`：`taskkill /F /T`、幂等、失败不谎报 | 杀完必须复检 `isAlive` |
| `12475dc` | `tail` 按行边界截断 | 原来会返回半个首行（check 报告 §4-13 已因此**过时**） |
| `0ff33f9` / `6dbaed4` / `174597c` / `a193b10` / `f15f4d5` / `85101ee` / `4373b99` | 拒绝理由留痕、测试探针改 PowerShell sleep、**自己解析外壳**而非 `shell:true`、**不向子进程传 fd**、被拒后退避重试 + 不建控制台、测试不再泄漏临时目录、加泄漏审计 | 这几条**推翻了 design.md / implement.md 里的执行机制描述** → F8 必改 |
| `f499083` / `712822e` | `channel.test.ts` 负载敏感 flake、`wait_for_exit` 只等 worker pid 没等后代 | 与本任务正交，已单独提交 |

**独立复核**：`.myflow/.runtime/check-bg/report.md`（F1–F5 契约验收 + 变异非空性证明，7 个变异各命中一条断言）。
⚠️ 它在 **gitignored 的 `.runtime/`** 下 —— clean checkout 后**不会存在**。
它的耐久结论已摘入本文件 §2.3 / §3，不要假设下个会话能读到原报告。

---

## 2. 未完成的工作（按建议顺序，每步都写了验收与陷阱）

### 2.1 `P1` — 删掉 cmd.exe 兜底（用户已决定，**代码未改**）

**用户裁定原文（2026-10-15 20:36 的选择）**：
> 删掉 cmd 兜底：解析不出 POSIX 外壳就明确拒绝并写 error（符合「宁可拒绝，不要假装」），同步契约与工具描述

**为什么**：复核实证——`cmd.exe /d /s /c "<command> >> ..."` 这条路上，Node 会把命令里的内层引号转义成 `\"`，
而 `cmd` **不认**这种转义，于是**任何带引号的命令在兜底路径上都是坏的**；而契约把它宣传成"可用"。

**改动清单**（符号已核对，行号为本次会话所读）：

| 位置 | 现状 | 要改成 |
| --- | --- | --- |
| `bg_runner.mjs` `resolveShellPath` **第 5 步** | `%ComSpec%` → 否则 `cmd.exe` | 不再兜底；返回 `null` 或抛一条**可读的解析失败** |
| `bg_runner.mjs` `isCmdShell` / `quoteForCmd` / `shellArgsFor` 的 cmd 分支 | 存在且在测试里被单测 | 一并删除（只留 POSIX 分支） |
| `bg_runner.mjs` 启动失败路径 | `spawnFailureRecord` 写 `error` | 解析失败时 `error` 必须**列出试过的顺序**（`MYFLOW_BG_SHELL` → settings `shellPath` → Git Bash → PATH bash），让用户知道怎么修 |
| `background.ts` 工具描述（`command` 字段，**约 :648-658**） | 明写 "…then an explicit cmd.exe /d /s /c fallback" | 删掉那半句，改成"解析不到 POSIX 外壳（Git Bash / bash）时**明确拒绝**" |
| `background.ts` 另有一处描述（**约 :721**） | 同样宣传 cmd 兜底 | 同上 |
| `tests/bg-runner.test.ts` `-4c`（约 :554-577）、`shellArgsFor` 断言（约 :591-604）、`isCmdShell` 断言（:597-599） | 断言"退回 `%ComSpec%`"与 cmd argv | 改成断言**拒绝**（错误信息包含试过的路径）；删掉 cmd argv 与 `quoteForCmd` 用例 |

**验收**：一条**新的**行为测试——解析不到外壳时，wrapper 退出码非零、`.exit` 有 `error`、且**没有**任何进程被执行；
外加 `grep -rn "cmd.exe\|quoteForCmd\|isCmdShell\|ComSpec" .pi/ .myflow/scripts/ tests/` 只剩解释性注释（推荐保留一句"为什么不用 cmd"）。

**陷阱**：`implement.md` §6 `R-1` 与 `design.md` §2.1 也描述了外壳策略。
**先改代码，契约修订统一放 F8**（见 §2.4 的"为什么"）。

### 2.2 `F7` — 接线（把 2040 行代码接上一个入口）

**这是最高优先级**：现在四个工具**没有任何注册路径**，所以它们不是"没测好"，而是**在真实会话里不存在**。
所有 bg 测试都只驱动导出的 builder（`createBgStartTool` 等），没有一条经过 Pi 的注册面。

范围（与 `implement.md` §2 F7 一致，但补上本次复核的产物）：

1. `index.ts`：`registerMyflowBackground(pi, { deriveContextKey, isSubAgent, projectRoot })`（**注入，不 import `index.ts`**，照 `subagent.ts` 范式）。
2. `BG_TOOL_NAMES` + `tool_call` 子代理守卫，紧邻既有递归守卫 / ASK 守卫（同形态）。
3. `session_shutdown`：**不杀任何任务**；幂等释放本会话句柄/定时器；列出"本会话起的、仍 `running`"的任务，`ctx.ui.notify`（无 UI 静默跳过）。
4. 新建 `tests/bg-lifecycle.test.ts`（`implement.md` §3 F7 六条）。
5. **顺手拆文件**（建议，见 §3.4）：`background.ts` → `background/registry.ts` + `background/tools.ts`（+ 渲染文本）。
6. **子代理白名单**：`.pi/agents/*.md` 的 `tools:` 不含这四个（现在不含，因为它还没注册；接线后要**显式**断言，F7-3）。

**验收**：`bg-lifecycle.test.ts -1..-6` 全绿 + 全量 316+N 绿；`grep -rn "myflow_bg_" .pi/extensions/myflow/index.ts` 能命中注册与守卫两处。

**陷阱**：不要用 `bg-start.test.ts` 里的 `quiet sleep` 探针写法去做 `session_shutdown` 用例——
那会真的留一个后台进程；`-4` 要造一个**能确认存活**的真进程，并在用例末尾自己收尸（照 `bg-stop.test.ts -1` 的做法）。

### 2.3 `F8` — 契约副本同步（同时**修掉已漂移的 14 处**）

`design.md` / `implement.md` 现在有**主动描述错误机制**的段落。照它们写代码会**重新引入已修的 bug**：

| 漂移 | 位置 | 事实 |
| --- | --- | --- |
| 外壳用 `shell: true` | `implement.md` F1 小节（§2 F1 的 1、2 步）、§3 F1 `-5`、§6 `R-1` | 实际是**自己解析外壳 + 单个 argv**（`174597c`） |
| `stdio: [ignore, fd, fd]` | `design.md` §2 的图与"为什么用 wrapper"第 3 条、`implement.md` F1 | 实际**不传任何描述符**，外壳自己做 `exec >> log 2>&1`（`a193b10`） |
| `.exit` 形状只有三个字段 | `design.md` §3.2 上方示例 | 实际成功记录**恒有** `shell`，重试过才有 `retries`，失败才有 `error`（`ExitRecord` 接口也只列了一半） |
| `unknown` 状态 | `design.md` §3.1、`implement.md` F2 `-4`、ADR-4 | **代码里不可达**；坏文件只进 `warnings` |
| 重试预算 / Windows `detached` 外壳 | 完全未进契约 | 8 次 / 250ms×1.5 / 封顶 2s / 硬上界 10s；Windows 上外壳 `detached` 以不建控制台 |
| F1 `-4` 用例表述 | `implement.md` §3 F1 `-4` | **命令**不存在 → `exit_code: 127` 且**无** `error`；`null + error` 只属于**外壳创建失败** |
| 返回体字段 | `design.md` §4.1/§4.2/§4.3 | 实际多出：start 的 `started`/`via`；output 的 `task_id`/`mode`/`reset`/`failure`/`signal`；list 的 `count`/`warnings`/`prune`d/`healed`、行的 `current_session`/`unconfirmed`/`spawn_error` |
| `spawn_error` | `design.md` §3.1 schema | 未登记，但 `list`/`output` 都会展示 |
| 测试清单落后 | `implement.md` §3 的 F1/F3/F4/F5 | 缺 `-4(c)/-6/-7/H1b-*/S2-*/S3-*`、F3 `-7..-9`、F4 `-8..-12`、F5 `-5..-7` |
| 用户 P1 决定 | 见 §2.1 | 删兜底之后，§6 `R-1` 的建议（`shell: true`）**两处都错**，要整段重写 |

**F8 的处理原则（建议，需用户确认）**：把 `design.md` / `implement.md` **定性为历史记录**，
**唯一活契约**写进 `.myflow/spec/harness/index.md`，并在两份计划文件顶部加一行"本文件为 2026-10 的实现期快照，
契约以 spec 为准"。否则下次还会再漂 14 处。

F8 还要补进 spec + `§8 已知限制` 的**四条**（都是"可观察但无契约"的）：

1. 外壳创建被拒后的重试预算（最长约 7.2s 才落 `.exit`，工具本身仍立刻返回）。
2. `tail` 的单行超 `max_bytes` 退化例外（返回该行的 UTF-8 对齐片段 + `truncated: true`）。
3. **孤儿窗口**（见 §3.1，若不修就记为限制）。
4. **`stop` 与 `start` 的窗口竞态**（pid 尚未写入注册表时 stop 找不到目标）——与 §3.1 同一个根因。

> ⚠️ **改 `design.md` / `implement.md` 会让 `plan_hash` 变化 → `approval.json` 失效。**
> 所以顺序是：**代码（P1 + F7）→ F8 改计划文件 → `task.py approve`（重新过门）**。
> 任务已在 in_progress，门不会**阻止**干活，但按本仓库惯例（见 `2f974fd`）应当重新批准，不能默默绕过。

---

## 3. 设计评审结论（回答"是不是最佳设计"）

### 3.1 核心机制：**是最佳的**（不要动）

- **ADR-1 wrapper 自记退出码**：`detached` 之后没有任何人 `wait` 那个子进程，退出码天然丢失。
  不这么设计，"已退出能给出退出码"这条 AC 永远不成立。这是设计的支点。
- **ADR-4 一任务一文件**：无锁、无丢更新；`list` 的代价只是 readdir + 小文件解析。
- **ADR-5 游标按会话**：跨会话互不吞字节，几乎零成本（复用 `deriveContextKey`）。
- **R10 三层子代理守卫**（白名单 + `tool_call` block + `execute` 自检）：与 ask/approval 同款，形态一致。
- **§8 诚实限制表 + "宁可拒绝，不要假装"**（P1 决定正是这个基调的延伸）。

### 3.2 该改的（设计层，不是实现层）

| # | 问题 | 现状 | 建议 | 代价 |
| --- | --- | --- | --- | --- |
| 1 | **孤儿窗口** | `spawn` → 写 `<id>.json`。中途崩溃 = 一个**不可见**的后台进程，`list` 永远找不到它（§8 自己承认） | **先写条目**（`pid: null`，状态 `starting`）→ spawn → 回填 pid | 状态机多一态（四态 → 五态）、`resolveStatus` 多一分支、`stop` 要处理"无 pid，等还是拒"；换来**顺带消掉 stop 的起进程窗口竞态** |
| 2 | **没有 `cwd` 参数** | `BG_START_PARAMETERS` 只有 `command` / `description` / `unattended`，命令只能在项目根跑 | 加 `cwd?`（相对项目根，超过根拒绝），并在确认门里**连 cwd 一起显示** | 小；但确认门显示与实际执行不一致本来是它要防的那类问题 |
| 3 | **轮询而非事件驱动** | 模型只能 `wait_ms` 盲等（≤30s/次） | 本会话起的任务 `.exit` 出现时 steer/notify 一条消息（定时器在 `execute` 里建、`session_shutdown` 释放） | 中～大：多一个会话级监视器 + 生命周期风险。**建议记 ADR、不在本任务做**（否则 8 批 → 10 批） |

### 3.3 已经**不是问题**的（避免下个会话重复排查）

- `tail` 返回半个首行 → **`12475dc` 已修**（按行边界；唯一例外单行超限）。复核报告 §4-13 因此**过时**。
- 全量测试泄漏临时目录 → `85101ee` + `4373b99`（`leak-audit`）。
- `channel.test.ts` 的负载敏感 flake → `f499083`。
- `wait_for_exit` 只等 worker pid → `712822e`（等后代）。

### 3.4 结构问题（建议在 F7 顺手做）

`background.ts` **2040 行一个文件**：注册表 + 4 个工具 + 一堆文本渲染 + 参数 schema。
它的"接口"是一堆 `export function`，任何人可以绕过注册表直接写文件（F7 接线只会增加耦合）。
建议拆 `background/registry.ts`（taskId、条目、游标、prune、`resolveStatus`、`isAlive`）
+ `background/tools.ts`（四个 builder + 文本）+ 一个 `register.ts`。
**F7 是唯一低成本的时机**（此后每次改 stop 都要重新读 2000 行）。

---

## 4. 环境、命令与陷阱（照抄即可）

```bash
# 全量测试（唯一正确形式：必须清空 MYFLOW_*）
cd /c/Users/wocai/Desktop/myflow
env -u MYFLOW_AGENT_TYPE -u MYFLOW_CONTEXT_ID -u MYFLOW_SKIP_BREADCRUMB -u MYFLOW_WRITES_UNDER \
  node --test tests/

# 只跑 bg
env -u MYFLOW_AGENT_TYPE -u MYFLOW_CONTEXT_ID -u MYFLOW_SKIP_BREADCRUMB -u MYFLOW_WRITES_UNDER \
  node --test tests/bg-*.test.ts

# 任务指针 / 批准门
python .myflow/scripts/task.py current
python .myflow/scripts/task.py plan-hash background-tasks
python .myflow/scripts/task.py gate-info background-tasks
```

陷阱（全部已实测，不要重新发现）：

- **`taskkill` 只能从 Node 用参数数组调**：Git Bash（MSYS）会把 `/F` 改写成 `F:/`。
- **`PATH` 上的 `bash` 可能是 WSL 启动器**（`C:\Windows\System32\bash.exe`）。`findOnPath` 已跳过 `system32` / `sysnative`，但**没有跳过 `syswow64`** —— 这是复核提的 P3，**未修**（32 位进程视角下的同一问题）。
- **重试分类是"未知即可重试"**：`isRetryableSpawnError` 对无法识别的 code 返回 `true`。
  `ERR_*` 这类确定性错误会白等约 7.2s —— 这是复核提的 P5，**未修**（P1 决定没覆盖它）。
- `bash -lc` 是**登录 shell**（会读用户 profile）；本机无影响，别的机器可能有。
- 测试用的长跑探针在 Windows 上用 **PowerShell sleep**（`6dbaed4`），不要改回 `sleep`。

---

## 5. 工作树与提交边界（下个会话最容易踩的）

```
 M .myflow/tasks/background-tasks/questions.jsonl      ← 本任务的问答记录（可随批次一起提交）
?? .agents/                                            ← 与任务无关（skills 安装产物）
?? AGENTS.md
?? docs/
?? skills-lock.json
```

- **不要 `git add -A`**：那四个 untracked 路径与"一次提交 = 一个功能点"无关，会污染提交。
- 每个功能点提交时**显式列文件**（`git add .pi/extensions/myflow/background.ts tests/bg-stop.test.ts`）。
- `.myflow/.runtime/`（含 `check-bg/report.md` 与本会话所有日志）**已 gitignore**：证据不会入库，
  所以结论要落进 spec 或本文件，不能只留在 `.runtime/`。

---

## 6. 给下个会话的检查清单（按顺序打勾）

1. [ ] `python .myflow/scripts/task.py start background-tasks`（指针可能又丢）→ `task.py current` 确认 in_progress
2. [ ] `python .myflow/scripts/task.py gate-info background-tasks` → `approval.status == "approved"`
3. [ ] 基线：全量测试 **316/316**（若不再是 316，先查是不是环境问题，不要当成回归）
4. [ ] `P1`：删 cmd 兜底（§2.1 的 6 个位置）+ 一条"解析不到外壳 → 拒绝且不执行"的行为测试 → 全量 → 提交
5. [ ] `F7`：接线 + `bg-lifecycle.test.ts`（6 条）+ 拆文件（建议）→ 全量 → 提交
6. [ ] `F8`：改 `design.md` / `implement.md`（14 处漂移 + §8 四条）与四份契约副本
7. [ ] `task.py approve`（重新过批准门，plan_hash 已变）
8. [ ] `myflow-check` 独立复核（范围：F6…F8 全部改动）→ 绿
9. [ ] `myflow-update-spec` → 提交 → `/myflow-finish-work`

---

## 7. 仍然没答案的问题（不要假装有）

1. **232 / `ERROR_NO_SYSTEM_RESOURCES` 到底还在不在**：本会话 0 次，复核 0 次；退避重试只在桩里被测过。
   `bg_runner.mjs` 注释自记"unmeasured"。**若它其实是确定性错误**，现在的"未知即可重试"会误归因为环境问题并白等 7.2s。
2. **Windows `detached` 是否真的不建控制台**：只能验证 `options.detached === true`，无测量手段。
3. **孤儿窗口要不要修**（§3.2-1）：这是设计选择，不是 bug 修复，需要用户点头（会改状态机）。
4. **`cwd` 参数要不要加**（§3.2-2）：同上，会改确认门的显示内容。
5. **`background.ts` 要不要在 F7 拆**（§3.4）：会增加 F7 的 diff，但不拆以后更贵。
