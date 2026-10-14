# implement.md — 执行顺序、逐功能点提交与验证

> 契约见 `design.md`；本文件只定「按什么顺序改哪些文件，拿什么证明改对了」。
> **用户的硬要求**：每个小功能点**写完测试后单独提交**（一次提交 = 一个功能点）。

---

## 0. 执行前提（硬约束）

| 约束 | 依据 | 对计划的含义 |
| --- | --- | --- |
| `myflow-implement` / `myflow-check` 可写但**一次只能一个** | `.pi/agents/*.md` 无 `writesUnder`；`subagent.ts` 拒绝写者并行 | 八批**全部串行**，不得并行 |
| 每次 dispatch 有 `timeoutMs`（默认 15 分钟） | `.myflow/workflow.md` Dispatch Protocol | 每批只做**一个功能点**；超时就拆小重派，不重做 |
| dispatch prompt 必须以 `Active task: <task.py current>` 开头 | 同上 | 模板见 §5 |
| `prd.md` / `design.md` / `implement.md` **自动注入** | `context-injection.ts` | jsonl 只需放**代码基线**，不要再列这三份 |
| 注入总预算 131072 字节，**必须含 wrapper/header 开销实算** | 横评 `DV-1`/`DV-7` 的教训 | 定稿前用真 builder 实算，不能只加文件字节 |
| 本仓库**无** `.myflow/worktree.yaml` | 用户裁定 `R-1`（上一任务） | check 的 verify 门空跑 → 真验证靠测试与 §3 清单 |
| **提交由主会话做，不由子代理做** | 保证「提交 = 已验证」 | 每批：子代理实现+测试 → 主会话跑全量 → 提交 → 下一批 |
| 测试须清空 `MYFLOW_*` | `.myflow/spec/harness/index.md` Checklist | 固定命令见 §3 |
| `taskkill` **只能从 Node 用参数数组调** | 已实测：Git Bash 会把 `/F` 改写成 `F:/` | 测试不得经 Git Bash 转发 |
| `.myflow/.runtime/` 已被 gitignore | `.gitignore:5` | 测试产生的运行态不会污染工作树 |

---

## 1. 批次总览（**8 批 = 8 个功能点 = 8 次提交**）

| 批 | 功能点 | 产出 | 提交信息要点 |
| --- | --- | --- | --- |
| `F1` | wrapper 脚本：跑命令、内核级 tee 日志、自记退出记录 | `.myflow/scripts/bg_runner.mjs`、`tests/bg-runner.test.ts` | `Add the background runner that records its own exit` |
| `F2` | 注册表：taskId、条目读写、pid 存活检测、自愈、prune | `.pi/extensions/myflow/background.ts`（注册表部分）、`tests/bg-registry.test.ts` | `Add the background task registry` |
| `F3` | `myflow_bg_start`：确认门 + 非 UI 留痕 + 立刻返回 | `background.ts`（start 工具）、`tests/bg-start.test.ts` | `Start background tasks behind a confirmation` |
| `F4` | `myflow_bg_output`：delta/tail/peek/`wait_ms`/截断标注 | `background.ts`、`tests/bg-output.test.ts` | `Read background output, delta or tail` |
| `F5` | `myflow_bg_list`：状态区分、自愈、prune | `background.ts`、`tests/bg-list.test.ts` | `List background tasks, and reap the finished ones` |
| `F6` | `myflow_bg_stop`：`taskkill /F /T`、幂等、失败不谎报 | `background.ts`、`tests/bg-stop.test.ts` | `Stop a background task, tree and all` |
| `F7` | 接线：注册、子代理守卫、`session_shutdown` 行为 | `index.ts`、`tests/bg-lifecycle.test.ts` | `Wire background tasks in, main session only` |
| `F8` | 契约副本同步 | `.myflow/spec/harness/index.md`、`.myflow/workflow.md`、`myflow-meta` 与 conventions | `Document the background-task contracts` |

**顺序理由**：`F1` 是可独立单测的底座（没有它就没有退出码）；
`F2` 是所有工具的共同依赖；`F3`–`F6` 每个是一个独立可测的功能点；
`F7` 必须在工具齐了之后接线；`F8` 在代码定稿后写（否则文档描述未落地的东西）。

---

## 2. 各批详细

### F1 — `bg_runner.mjs`
- 独立 Node 脚本，**不 import 扩展的其它文件**（要与 `.pi/` 解耦，可单独跑）。
- CLI：`node bg_runner.mjs --id <taskId> --log <logPath> --exit <exitPath> -- <command>`；
  命令以**单个字符串**接收（含空格/管道的原样），由 runner 用 `shell: true` 执行。
- 行为：
  1. 以 `append` 打开 `<log>` 拿 fd；
  2. `spawn(command, { shell: true, stdio: ["ignore", fd, fd], cwd })`；
  3. 子进程 `exit` 时写 `<exit>` = `{"exit_code":N,"signal":S,"at":"…"}`（**原子写**：先写 `.tmp` 再 rename，
     避免读者读到半个文件——见 §3 的 `-1` 用例）；
  4. runner 自身**不得**输出到 stdout（它是 detached + `stdio:"ignore"`）。
- 失败：spawn 抛错 → 写 `<exit>` = `{"exit_code":null,"error":"…"}`，退出码非零。
- **陷阱**：不要 `detached` 命令本身（runner 才是脱离的那个）；不要用 `pipe` 再手动转发（会引入缓冲）。

### F2 — 注册表（`background.ts` 的注册表部分）
- `taskId`：`bg-<base36(ms)>-<4hex>`，形状必须被测试正则锁定。
- `backgroundDir(projectRoot)` = `<root>/.myflow/.runtime/background`；`cursors/` 子目录。
- `writeEntry` / `readEntry` / `listEntries`：
  - `listEntries` 必须**容忍坏文件**（写一半/非法 JSON）→ 计入 `unknown` 与告警计数，**不抛**。
- `isAlive(pid)`：`process.kill(pid, 0)`；`pid<=0` → false。
- `resolveStatus(entry)`：**判据顺序固定** → ① `.exit` 存在 ⇒ `exited`（读其 `exit_code`）；
  ② `status === "stopped"` ⇒ `stopped`；③ `isAlive(pid)` ⇒ `running`；④ 否则 ⇒ `exited` 且 `exit_code: null`（自愈）。
- `prune(dir, now)`: 删**已结束**且 `ended_at` 早于 24h 的条目 + 其 `.log`/`.exit` + 相关游标。
- 游标：`cursorPath(projectRoot, contextKey, taskId)`、`readCursor`、`writeCursor`。

### F3 — `myflow_bg_start`
- 参数与行为严格按 `design.md` §4.1。
- 确认：`await ctx.ui.confirm("以后台运行这个命令？", command)`。
- 非 UI：`unattended !== true` → 拒绝 + 指令；为真 → 放行且 `confirmed_by = "no-ui-explicit"`。
- spawn：`spawn(process.execPath, [runnerPath, "--id", id, "--log", log, "--exit", exit, "--", command],
  { detached: true, stdio: "ignore", cwd })` → `child.unref()`。
- **状态机顺序**：spawn → 写 `<id>.json` → 返回。**不得** await 任何子进程事件。
- 返回体必须**回显** `confirmed_by`（R8）。

### F4 — `myflow_bg_output`
- 参数与行为按 `design.md` §4.2。
- `delta`：读 `[offset, size)`；超 `max_bytes` → 截断且 `truncated: true`，`next_offset` 指向**已返回部分的末尾**
  （未返回的字节留在下次读，**不推进到文件末尾**——这是最容易写错的一处）。
- `peek` 与 `tail` **不动游标**（测试要显式断言游标前后不变）。
- `wait_ms`：轮询（间隔 ≤ 200ms）直到「有新字节」或「任务结束」或超时；**必须有界**，不得无限等。
- 末尾用 `fs.statSync().size` 而不是读整个文件来判断「有没有新字节」（大日志不能整读）。

### F5 — `myflow_bg_list`
- 参数与行为按 `design.md` §4.3；每条先 `resolveStatus`（自愈），再决定是否显示。
- `prune: true` → 调 `prune` 并返回删除计数。
- 返回里要能看出**哪条是本会话起的**（`started_by_context_key === 当前 key`）。

### F6 — `myflow_bg_stop`
- Windows：`spawnSync("taskkill", ["/F","/T","/PID", String(pid)])`；非 Windows：`process.kill(-pid)`，回退 `process.kill(pid)`。
- 幂等：任务已结束 → 不改已有 `exit_code`，返回「本来就没在跑」。
- 成功：`status = "stopped"`、写 `ended_at`。
- **失败不得谎报**：`taskkill` 非零退出且 `isAlive(pid)` 仍为真 → 返回错误 + 原始 stderr。
- 杀完必须**复检** `isAlive(pid)`（Windows 上 taskkill 返回 0 也可能有残余）。

### F7 — 接线与生命周期
- `index.ts`：`registerMyflowBackground(pi, { deriveContextKey, isSubAgent })`（**注入，不 import 循环**）。
- `BG_TOOL_NAMES` 常量 + `tool_call` 子代理守卫（紧邻既有递归守卫/ASK 守卫，同形态）。
- `session_shutdown`：**不杀任何任务**；幂等释放本会话的定时器/句柄；
  列出「本会话起的、仍 `running`」的任务并 `ctx.ui.notify`（无 UI 静默跳过）。
- 工厂函数里**不得**起进程或定时器。

### F8 — 契约副本同步
| 文件 | 要加什么 |
| --- | --- |
| `.myflow/spec/harness/index.md` | 新 Contract 条目：目录与四个文件契约、`taskId` 形状、四状态、`confirmed_by`、wrapper 与退出记录、pid 自愈、**§8 的已知限制表原文**（含孤儿窗口、退出码可能为 null、无沙箱、门非安全边界）；Checklist 各加一条 |
| `.myflow/workflow.md` | 若 Routing 表需要指向后台工具则加；否则明确记录「无需修改」及理由 |
| `.pi/skills/myflow-meta/SKILL.md` 与 `references/harness-conventions.md` | 工具清单加 4 个新工具；`tool_call` 守卫描述加 BG 守卫；**只加本次新增项**（hook 计数漂移仍按 `R-3` 留给独立任务） |

**验收**：grep 确认没有第二处描述与本设计冲突；文档契约测试（`skills-hygiene` / `workflow-invariant`）全绿。

---

## 3. 测试清单（每条都要「回退即红」）

统一命令：
```bash
env -u MYFLOW_AGENT_TYPE -u MYFLOW_CONTEXT_ID -u MYFLOW_SKIP_BREADCRUMB -u MYFLOW_WRITES_UNDER node --test tests/
```

### F1（`bg-runner.test.ts`）
| ID | 用例 |
| --- | --- |
| `-1` | 命令输出**真的**进了日志文件；退出后 `.exit` 存在且 `exit_code` 正确 |
| `-2` | 非零退出码被如实记录（`exit 3` → `exit_code: 3`） |
| `-3` | `.exit` 是**原子写**：并发/反复读取不会读到非法 JSON |
| `-4` | 外壳起不来（`MYFLOW_BG_SHELL` 指向不存在的路径）→ `.exit` 写 `exit_code: null` + `error`，wrapper 退出码非零；命令不存在（外壳起来了，只是命令找不到）→ 外壳退出码 **127**、`.exit` **无 `error`**。两者是不同的事（`bg-runner.test.ts` 的 `-4(b)` / `-4(c)` 各锁一条） |
| `-5` | `shell: true` 生效：含管道或重定向的命令能跑通（按 §6 `R-1` 的裁定） |

### F2（`bg-registry.test.ts`）
| ID | 用例 |
| --- | --- |
| `-1` | `taskId` 形状符合正则，且两次生成不重复 |
| `-2` | `resolveStatus` 四分支各一条：`.exit` 存在 / `stopped` / pid 活 / pid 死无 `.exit` → 自愈成 `exited` |
| `-3` | `.exit` **优先于** pid 存活（构造「pid 仍活但 `.exit` 说已退出」→ 必须 `exited`） |
| `-4` | `listEntries` 对坏 JSON 不抛，计为 `unknown` |
| `-5` | `prune` 只删「已结束且 >24h」，不动运行中的与新的 |
| `-6` | 游标读写往返；不存在 → offset 0 |

### F3（`bg-start.test.ts`）
| ID | 用例 |
| --- | --- |
| `-1` | **立刻返回**：起一个睡 10s 的命令，断言工具在 **< 2000ms** 内返回（可测上界，不是「感觉快」） |
| `-2` | 有 UI 且 `confirm` 返回 true → 进程真的起来了（`.log` 增长 / pid 活） |
| `-3` | 有 UI 但 `confirm` 返回 **false** → **不 spawn**、不写注册表（桩 spawn 计数 0） |
| `-4` | 无 UI 且 `unattended` 缺失 → 拒绝，返回指令，**不 spawn** |
| `-5` | 无 UI 且 `unattended: true` → 放行，且条目 `confirmed_by === "no-ui-explicit"`、**结果里回显** |
| `-6` | `command` 为空 → 拒绝，不弹窗（桩 confirm 计数 0） |

### F4（`bg-output.test.ts`）
| ID | 用例 |
| --- | --- |
| `-1` | `delta` 第一次读到全部；**第二次读为空**；再写入后第三次读到新增部分 |
| `-2` | `peek` 读得到内容但游标**前后不变**（显式断言 offset） |
| `-3` | `tail` 返回最后 N 行且不动游标 |
| `-4` | 超 `max_bytes` → `truncated: true`，且 `next_offset` 指向**已返回部分的末尾**（不是文件末尾） |
| `-5` | 任务已退出 → 返回 `exit_code`（来自 `.exit`） |
| `-6` | `wait_ms` 在有新输出时**提前**返回；在无输出且任务已结束时也提前返回；超时有界 |
| `-7` | 游标**按会话分开**：用两个不同 `deriveContextKey` 各读一次 delta，两边都应拿到内容 |

### F5（`bg-list.test.ts`）
| ID | 用例 |
| --- | --- |
| `-1` | 能区分 `running` / `exited` / `stopped`（三种各造一个） |
| `-2` | 自愈：造一个「pid 已死 + 无 `.exit` + 状态写着 running」→ list 后变 `exited` |
| `-3` | 标出哪条是本会话起的 |
| `-4` | `prune: true` 返回删除计数且只删该删的 |

### F6（`bg-stop.test.ts`）
| ID | 用例 |
| --- | --- |
| `-1` | **杀进程树**：起一个会生成孙进程的命令 → stop 后**孙进程也死**（用存活检测断言，不看 taskkill 的输出） |
| `-2` | 幂等：对已结束任务 stop → 不报错、不改已有 `exit_code` |
| `-3` | 成功后 `status === "stopped"` 且 `ended_at` 非空 |
| `-4` | 不存在的 `task_id` → 明确错误，不抛栈 |

### F7（`bg-lifecycle.test.ts`）
| ID | 用例 |
| --- | --- |
| `-1` | 子代理语境调四个工具**全部被 `tool_call` 拦**，且**主会话不被拦** |
| `-2` | 工具内部守卫：注入 `isSubAgent: true` → `execute` 也拒绝 |
| `-3` | `.pi/agents/*.md` 的 `tools:` 白名单**不含**这四个工具 |
| `-4` | `session_shutdown` **不杀**任务：触发后进程仍活 |
| `-5` | `session_shutdown` 可**重复触发**（幂等，不抛） |
| `-6` | 既有守卫未回归：递归守卫、`writesUnder`、plan 门、`ask`/`approval` 守卫对应用例仍绿 |

---

## 4. 完成判据（PRD AC ↔ 落点）

| PRD AC | 落在哪 |
| --- | --- |
| 起后台立刻返回 | `F3 -1` |
| 任务活过会话 + 新会话能读到 | `F7 -4` + `F2 -2`（跨进程读注册表） |
| 增量可见 | `F4 -1` / `F4 -7` |
| 已退出给出退出码 | `F1 -1/-2` + `F4 -5` |
| stop 杀进程树（Windows） | `F6 -1` |
| list 区分三态 | `F5 -1` |
| 每个功能点有回退即红测试 | 每批「删掉哪个判断会变红」自查 + 主会话抽查突变 |
| 不破坏既有 254 条 | 每批全量测试 |
| 不引入第二个 `bash` 工具 | grep：新工具名都是 `myflow_bg_*` |
| 每个功能点单独提交 | §1 的 8 批 = 8 次提交（**主会话执行提交**） |

---

## 5. Dispatch 模板

```
Active task: .myflow/tasks/background-tasks

本次批次：<F1..F8>（一个功能点）
目标：<一句话>

必读：
- .myflow/tasks/background-tasks/design.md    （契约；§2 核心机制、§3 文件契约、§4 工具规格、§5 生命周期、§6 守卫、§8 已知限制）
- .myflow/tasks/background-tasks/implement.md （§2 的 <F> 小节、§3 的 <F> 测试清单）
- .myflow/tasks/background-tasks/prd.md
- 相关现有代码：<按批给>

产出：<按批给具体文件>
禁止：改 ../critic_doc/、改 research/、改本任务三份 artifact（发现问题请报告）
禁止：改 .pi/extensions/myflow/{index,ask,approval,subagent,status,agents,turn-cache,context-injection}.ts（除非本批明确要求）
禁止：削弱既有递归守卫 / writesUnder / plan 门 / ask 守卫
禁止：经 Git Bash 调 taskkill（必须从 Node 用参数数组）

做完报告：改了哪些文件、测试逐条结果与「删哪个判断会变红」、全量测试数、未做/需决策清单。
```

---

## 6. 评审项（`task.py start` 前需用户确认）

| # | 事项 | 我的建议 |
| --- | --- | --- |
| `R-1` | 后台命令用哪个 shell？`shell: true` 在 Windows 上是 **cmd.exe**，而本项目其它 shell 工作走 **Git Bash**（`settings.json` 的 `shellPath`） | **建议 `shell: true`（平台默认）** 并在工具描述里写明「不是 Git Bash」；若你要求一致，我改成显式走 `shellPath` 解析，代价是要读用户级 settings |
| `R-2` | 日志无限增长：是否要**轮转**（例如超过 N MB 截断/改名）？设计里记为已知限制、不做 | 建议**不做轮转**，先记为限制；真需要时单开一个功能点 |
| `R-3` | `prune` 默认关（只在 `prune: true` 时删） | 建议**默认关**，删除动作不应隐式发生 |
| `R-4` | 子代理不可用（PRD Q4 我的判定） | 建议**维持不可用**；若你要让子代理也能起后台，代价是要给它一个无 UI 的确认策略 |
| `R-5` | `wait_ms` 上限 30s | 建议 30s。更长会让工具调用看起来像挂死；模型可以多次调用 |

**未确认前不执行 F1。**

---

## 7. 回退与失败处理

| 情形 | 处理 |
| --- | --- |
| 某批超 15 分钟被截断 | 读 `.myflow/.runtime/subagent-logs/` 日志 → 拆小重派；**不重做**已完成部分 |
| 全量测试出现**既有**用例变红 | 停下报告；**不得**为让新用例通过而改既有断言 |
| 发现设计有误（例如 runner 与 detached 不兼容） | **停止实现**，回 Phase 1 修订 `design.md`，并记录该发现 |
| 实测发现 `.exit` 原子写在实际时序下仍会读到半文件 | 改成「写 `.tmp` → rename」并补一条并发读测试；若仍不稳，改从 wrapper 直接 `writeFileSync`（小文件单次写更稳） |
| 运行态污染工作树 | `.myflow/.runtime/` 已 gitignore；若发现别处被写，立即报告并清理 |
| 注入被截断（`[myflow: context limit reached …]`） | 按横评 `DV-1` 的降级顺序处理，并用**含开销实算**复核 |
