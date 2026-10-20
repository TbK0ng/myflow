# implement.md — 执行顺序、逐功能点提交与验证

> 契约见 `design.md`；本文件只定「按什么顺序改哪些文件，拿什么证明改对了」。
> **用户的硬要求**：每个小功能点**写完测试后单独提交**（一次提交 = 一个功能点）。
>
> **本文件是实现期的执行记录（2026-10）；活契约是 `.myflow/spec/harness/index.md` 的
> `Background tasks: myflow_bg_*` 一节。** 两者冲突时以 spec 为准。

---

## 0. 执行前提（硬约束）

| 约束 | 依据 | 对计划的含义 |
| --- | --- | --- |
| `myflow-implement` / `myflow-check` 可写但**一次只能一个** | `.pi/agents/*.md` 无 `writesUnder`；`subagent.ts` 拒绝写者并行 | 各批**全部串行**，不得并行 |
| 每次 dispatch 有 `timeoutMs`（默认 15 分钟） | `.myflow/workflow.md` Dispatch Protocol | 每批只做**一个功能点**；超时就拆小重派，不重做 |
| dispatch prompt 必须以 `Active task: <task.py current>` 开头 | 同上 | 模板见 §5 |
| `prd.md` / `design.md` / `implement.md` **自动注入** | `context-injection.ts` | jsonl 只需放**代码基线**，不要再列这三份 |
| 注入总预算 131072 字节，**必须含 wrapper/header 开销实算** | 横评 `DV-1`/`DV-7` 的教训 | 定稿前用真 builder 实算，不能只加文件字节 |
| 本仓库**无** `.myflow/worktree.yaml` | 用户裁定 `R-1`（上一任务） | check 的 verify 门空跑 → 真验证靠测试与 §3 清单 |
| **提交由主会话做，不由子代理做** | 保证「提交 = 已验证」 | 每批：子代理实现+测试 → 主会话跑全量 → 提交 → 下一批 |
| 测试须清空 `MYFLOW_*` | `.myflow/spec/harness/index.md` Checklist | 固定命令见 §3 |
| `taskkill` **只能从 Node 用参数数组调** | 已实测：Git Bash 会把 `/F` 改写成 `F:/` | 测试不得经 Git Bash 转发 |
| `.myflow/.runtime/` 已被 gitignore | `.gitignore:5` | 测试产生的运行态不会污染工作树 |
| **F8 只改文档** | 本批范围 | 不改任何 `.pi/extensions/**`、`.myflow/scripts/**`、`tests/**` |

---

## 1. 批次总览（实际序列：**一次提交 = 一个功能点**）

| 提交 | 批次 | 内容 |
| --- | --- | --- |
| `a882e72` | `F1` | wrapper 脚本：跑命令、外壳重定向到日志、自记退出记录 |
| `2dfc20d` | `F2` | 注册表：taskId、条目读写、pid 存活检测、自愈、prune、游标 |
| `36ebf91` | `F3` | `myflow_bg_start`：确认门 + 非 UI 留痕 + 立刻返回 |
| `f125bb0` | `F3b` | spawn 失败要大声报（`spawn_error`），不得静默 |
| `de8afd0` | `F4` | `myflow_bg_output`：delta/tail/peek/`wait_ms`/截断标注 |
| `2c6f243` | `F5` | `myflow_bg_list`：三态、自愈、prune |
| `8da59f5` | `F6` | `myflow_bg_stop`：`taskkill /F /T`、幂等、失败不谎报 |
| `174597c` | `S2a` | 自己解析并起外壳，不把命令串交给 Node 的 shell 选项 |
| `a193b10` | `S2b` | 不向子进程传任何描述符（改由外壳 `>>` 写日志） |
| `0ff33f9` | `S2c` | 外壳被拒时把理由留在 `.exit` |
| `12475dc` | `S2d` | `tail` 按行边界截断（原本会返回半个首行） |
| `f15f4d5` | `S3a` | 创建被拒时有界重试 + Windows 上不建控制台 |
| `6dbaed4` | `S3b` | 测试探针改用 PowerShell sleep |
| `85101ee` | `S3c` | 测试不再泄漏临时目录 |
| `4373b99` | `S3d` | 增加临时目录泄漏审计 |
| `efd5106` | `P1` | **删掉 `cmd.exe` 兜底**（用户裁定：宁可拒绝，不要假装） |
| `38cceb8` | `F7` | 接线：注册、子代理守卫、`session_shutdown` 行为 |
| （本批） | `F8` | 契约副本同步（`design.md` / `implement.md` / spec / skills） |

**顺序理由**：`F1` 是可独立单测的底座（没有它就没有退出码）；
`F2` 是所有工具的共同依赖；`F3`–`F6` 每个是一个独立可测的功能点；
`S2*`/`S3*` 是复核发现的机制缺陷，各自单独提交；`P1` 是用户裁定；
`F7` 必须在工具齐了之后接线；`F8` 在代码定稿后写（否则文档描述未落地的东西）。

---

## 2. 各批详细

### F1 — `bg_runner.mjs`（实际机制）
- 独立 Node 脚本，**不 import 扩展的其它文件**（要与 `.pi/` 解耦，可单独跑）。
- CLI：`node bg_runner.mjs --id <taskId> --log <logPath> --exit <exitPath> -- <command...>`；
  命令是 `--` 之后的全部 argv，重新拼成**一个字符串**后作为**单个 argv 元素**交给外壳。
- 外壳：`resolveShellPath()` 解析（`MYFLOW_BG_SHELL` → `~/.pi/agent/settings.json` 的 `shellPath`
  → `C:\Program Files\Git\bin\bash.exe` → `PATH` 上的 `bash`），`shellRejectionReason()` 拒绝
  「解析不到」与「解析到 `cmd.exe`」两种情况，**没有 `cmd.exe` / `/bin/sh` 兜底**。
- 启动：`spawn(shell, ["-lc", "exec >> '<log>' 2>&1; <command>"], { cwd, stdio: "ignore", detached: win32 })`
  —— 不向子进程传任何描述符；日志由外壳的 `>>` 写（追加、内核级、跨进程立即可见）。
- 退出：外壳 `exit` 后写 `<exit>`（**原子写**：先写 `.tmp` 再 rename，rename 遇
  `EPERM`/`EACCES`/`EBUSY` 重试 50×20ms）。
  成功记录恒有 `shell`，重试过才有 `retries`；失败记录另带 `error`。
- 创建被拒：`runCommand` 有界退避重试（8 次尝试、250ms×1.5 封顶 2s、硬上界 10s），
  只在 `'error'`/同步抛出时重试（进程从未创建 → 不会执行两次）。
- 失败分类：`EAGAIN/ENOMEM/EMFILE/ENFILE` 与**无法识别的 code** 可重试；
  `ENOENT/EINVAL/EACCES/EPERM` 绝不重试。
- runner 自身**不得**输出到 stdout/stderr（它是 detached + `stdio:"ignore"`）。
- **陷阱**：不要 `detached` 命令本身（runner 才是脱离的那个）；不要用 `pipe` 再手动转发
  （会引入缓冲，破坏「边跑边读」）。

### F2 — 注册表（`background.ts` 的注册表部分）
- `taskId`：`bg-<base36(ms)>-<4hex>`，形状必须被测试正则锁定。
- `backgroundDir(projectRoot)` = `<root>/.myflow/.runtime/background`；`cursors/` 子目录。
- `writeEntry` / `readEntry` / `listEntries`：
  - `listEntries` 必须**容忍坏文件**（写一半/非法 JSON）→ 计入 `warnings` 明细，**不抛**。
- `isAlive(pid)`：`process.kill(pid, 0)`；`pid<=0` 或非整数 → false；`EPERM` 视为存活。
- `resolveStatus(entry)`：**判据顺序固定** → ① `.exit` 存在 ⇒ `exited`（读其 `exit_code`，
  并带出 `failure`/`signal`）；② `status === "stopped"` ⇒ `stopped`；
  ③ `isAlive(pid)` ⇒ `running`；④ 否则 ⇒ `exited` 且 `exit_code: null`（自愈）。
- `prune(dir, now)`：删**已结束**且 `ended_at`（回退 `.exit.at`）早于 24h 的条目
  + 其 `.log`/`.exit`/`.tmp` + 相关游标；无法定日期的不删。
- 游标：`cursorPath(projectRoot, contextKey, taskId)`、`readCursor`（缺失/坏 → 0）、`writeCursor`。

### F3 — `myflow_bg_start`
- 参数与行为严格按 `design.md` §4.1。
- 确认：`await ctx.ui.confirm("以后台运行这个命令？", command)`。
- 非 UI：`unattended !== true` → 拒绝 + 指令；为真 → 放行且 `confirmed_by = "no-ui-explicit"`。
- spawn：`spawn(process.execPath, [runnerPath, "--id", id, "--log", log, "--exit", exit, "--", command],
  { detached: true, stdio: "ignore", cwd: root })` → `child.unref()`。
- **状态机顺序**：校验 → 确认 → spawn → 写 `<id>.json` → `onStarted(id)` → 返回。
  **不得** await 任何子进程事件。
- 必须挂 `'error'` 监听器（无监听器时 `'error'` 会被 EventEmitter 重新抛出 → 打崩 Pi）。
- 返回体必须**回显** `confirmed_by`（R8）。

### F4 — `myflow_bg_output`
- 参数与行为按 `design.md` §4.2。
- `delta`：读 `[offset, size)` 且上限 `max_bytes`；超限 → 截断且 `truncated: true`，
  `next_offset` 指向**已返回部分的末尾**（未返回的字节留在下次读，**不推进到文件末尾**——
  这是最容易写错的一处）。
- `peek` 与 `tail` **不动游标**（测试要显式断言游标前后不变）。
- `wait_ms`：轮询（间隔 ≤ 200ms）直到「有新字节」或「任务结束」或超时；**必须有界**。
- 末尾用 `fs.statSync().size` 而不是读整个文件来判断「有没有新字节」（大日志不能整读）。

### F5 — `myflow_bg_list`
- 参数与行为按 `design.md` §4.3；每条先 `resolveStatus`（自愈并**回写磁盘**），再决定是否显示。
- `prune: true` → 调 `prune` 并返回删除计数（默认关）。
- 返回里要能看出**哪条是本会话起的**（`started_by_context_key === 当前 key` → `current_session`）。

### F6 — `myflow_bg_stop`
- Windows：`spawnSync("taskkill", ["/F","/T","/PID", String(pid)])`（`windowsHide: true`）；
  非 Windows：`process.kill(-pid)`，回退 `process.kill(pid)`。
- 幂等：任务已结束 → 不改已有 `exit_code`，返回「本来就没在跑」。
- 成功：`status = "stopped"`、写 `ended_at`；`exit_code` 优先取已存在的 `.exit`。
- **失败不得谎报**：`isAlive(pid)` 仍为真 → 返回错误 + 原始 stderr，**不写磁盘**。
- 杀完必须**复检** `isAlive(pid)`（有界 1000ms，每 25ms 一次）。

### F7 — 接线与生命周期（已落地，见 `38cceb8`）
- `index.ts`：`registerMyflowBackground(pi, { deriveContextKey, isSubAgent, onStarted })`
  （**注入，不 import 循环**）。`onStarted` 只做本会话记账（`startedBackgroundIds`）。
- `BG_TOOL_NAMES` 常量 + `tool_call` 子代理守卫，紧邻既有递归守卫 / ASK 守卫（同形态）。
- `session_shutdown`：**不杀任何任务**；先抢 `shutdownDone` 再执行（幂等）；
  只遍历本会话起过的 id，列出仍 `running` 的并 `ctx.ui.notify`（无 UI 静默跳过）；绝不外抛。
- 工厂函数里**不得**起进程或定时器。

### F8 — 契约副本同步（本批，纯文档）
| 文件 | 要加什么 |
| --- | --- |
| `.myflow/spec/harness/index.md` | 新 Contract `Background tasks: myflow_bg_*`：目录与四个文件契约、`taskId` 形状、三个可达状态、`confirmed_by`、wrapper 与退出记录、pid 自愈、**§8 的已知限制表原文**；Pre-Development Checklist 与 Quality Check 各加一条 |
| `.myflow/workflow.md` | Routing 表加一行指向后台工具（若会破坏 `workflow-invariant` 测试则不加，并在 spec 里记录理由） |
| `.pi/skills/myflow-meta/SKILL.md` 与 `references/harness-conventions.md` | 工具清单加 4 个新工具与 `background.ts`；`tool_call` 守卫描述加 BG 守卫；Load-Bearing Contracts 加背景任务契约；hook 表加 `session_shutdown` 一行（**计数漂移按 `R-3` 留给独立任务**） |

**验收**：grep 确认没有第二处描述与本设计冲突；文档契约测试（`skills-hygiene` / `workflow-invariant` /
`scaffold`）全绿。

---

## 3. 测试清单（每条都要「回退即红」）

统一命令：
```bash
env -u MYFLOW_AGENT_TYPE -u MYFLOW_CONTEXT_ID -u MYFLOW_SKIP_BREADCRUMB -u MYFLOW_WRITES_UNDER node --test tests/
```

### F1（`tests/bg-runner.test.ts`，18 条）
| ID | 用例（与文件里的 test 名一致） |
| --- | --- |
| `-1` | 命令输出真的进日志；退出后 `.exit` 存在且 `exit_code` 正确（0） |
| `-2` | 非零退出码被如实记录并传播 |
| `-3` | `.exit` 是**原子写**：并发/反复读取不会读到非法 JSON |
| `-4` | 外壳起不来时的两条不同事实：**(a)** 没有命令 → `exit_code:null` + `error`；**(b)** 外壳本身创建失败（`MYFLOW_BG_SHELL` 指向不存在的路径）→ `exit_code:null` + `error` + `shell` 记被请求路径；**(c)** **命令**不存在 → 外壳退出码 **127**、`.exit` **无 `error`** |
| `-5` | 命令经解析出的外壳执行：`&&`、管道、重定向都生效（命令是单个 argv） |
| `-6` | `MYFLOW_BG_SHELL` 覆盖被原样采用，并原样记进 `.exit.shell` |
| `-7` | `resolveShellPath` 顺序固定（override → settings → Git → PATH → null），跳过 System32 的 WSL `bash.exe`，且**没有 `cmd.exe` 兜底** |
| `-8` | 解析不到 POSIX 外壳 → 拒绝、写 `error`（含搜索顺序）、且一个字都不执行 |
| `-9` | `MYFLOW_BG_SHELL` 指到 `cmd.exe` → 拒绝，并指出不支持 `cmd.exe` |
| `-10` | `runCommand` 自己也会拒绝无外壳，且从不起进程 |
| `H1b -1` | 瞬时创建失败会被有界重试，`.exit` 记录 `retries` |
| `H1b -2` | 确定性失败（`ENOENT`）不重试，只尝试一次并如实记录 |
| `S2 -1` | `spawn` 用 `stdio:"ignore"`，**不向子进程传任何描述符** |
| `S2 -2` | 命令仍在运行时，另一个进程能立刻读到已写入的日志字节 |
| `S2 -3` | 日志路径含空格/单引号、命令含引号与空格都能跑通 |
| `S3 -1` | 起外壳时 `stdio:"ignore"` 且**仅在 Windows 上** `detached`，不传任何 fd |
| `S3 -2` | 被拒时按递增退避重试，穷尽 8 次且不超预算，错误可操作 |
| `S3 -3` | 永远失败时有界放弃（真实等待，总耗时小于预算 + 余量） |

### F2（`tests/bg-registry.test.ts`，6 条）
| ID | 用例 |
| --- | --- |
| `-1` | `taskId` 形状符合正则，且大量生成不重复 |
| `-2` | `resolveStatus` 四分支：`.exit` 存在 / `stopped` / pid 活 / pid 死无 `.exit` → 自愈成 `exited`（并断言 `isAlive(0/-1/"123")` 为 false） |
| `-3` | `.exit` **优先于** pid 存活（构造「pid 仍活但 `.exit` 说已退出」→ 必须 `exited`） |
| `-4` | `listEntries` 对坏 JSON 不抛，坏文件进 `warnings`，好条目仍在 |
| `-5` | `prune` 只删「已结束且 >24h」及其 log/exit/游标，不动运行中的与新的 |
| `-6` | 游标读写往返；不存在/坏 → offset 0 |

### F3（`tests/bg-start.test.ts`，9 条）
| ID | 用例 |
| --- | --- |
| `-1` | **立刻返回**：起一个长跑命令，断言工具在 **< 2000ms** 内返回（可测上界） |
| `-2` | `confirm` 返回 true → 进程真的起来，且注册表条目已写 |
| `-3` | `confirm` 返回 **false** → **不 spawn**、不写注册表 |
| `-4` | 无 UI 且 `unattended` 缺失 → 拒绝，返回指令，**不 spawn** |
| `-5` | 无 UI 且 `unattended: true` → 放行，条目 `confirmed_by === "no-ui-explicit"`、**结果里回显** |
| `-6` | `command` 为空 → 拒绝，不弹窗、不 spawn |
| `-7` | 注入 `isSubAgent: true` → 工具内部守卫拒绝（无弹窗/无 spawn/无条目） |
| `-8` | spawn 异步 `'error'` → 不崩，写入 `spawn_error` 并自愈为 `exited` |
| `-9` | spawn 同步抛错 → 返回错误，且不写任何注册表条目 |

### F4（`tests/bg-output.test.ts`，15 条）
| ID | 用例 |
| --- | --- |
| `-1` | `delta` 第一次读到全部；第二次读为空；再写入后第三次读到新增部分 |
| `-2` | `peek` 读得到内容但游标**前后不变**（显式断言 offset 与游标文件） |
| `-3` | `tail` 返回最后 N 行且不动游标 |
| `-4` | 超 `max_bytes` → `truncated: true`，且 `next_offset` 指向**已返回部分的末尾**（不是文件末尾），剩余字节不丢 |
| `-5` | 任务已退出 → 返回 `exit_code` 与状态（来自 `.exit`） |
| `-6` | `wait_ms` 在有新输出时**提前**返回；在无输出且任务已结束时也提前返回；超时有界 |
| `-7` | 游标**按会话分开**：两个不同 `deriveContextKey` 各读一次 delta，两边都拿到内容 |
| `-8` | 游标比文件长（日志被轮转/重建）→ 从 0 重读并带 `reset` |
| `-9` | 校验：`task_id` 缺失或不存在 → 明确错误 |
| `-10` | 多字节字符不被切坏：小 `max_bytes` 分批 delta 逐步拼回原文 |
| `-11` | 退化：`max_bytes` 小于单字符字节数时仍取一个完整字符并最终读完 |
| `-12` | `tail` 起点对齐：`max_bytes` 落在字符中间时首字符不被损坏 |
| `-13` | `tail` 按行边界截断：`max_bytes` 切在行中间时不返回半行 |
| `-14` | `tail` 单行超限：唯一例外是返回 UTF-8 对齐片段并标 `truncated` |
| `H1a` | 展示启动失败/异常退出原因：`.exit.error` 与 `.exit.signal` |

### F5（`tests/bg-list.test.ts`，8 条）
| ID | 用例 |
| --- | --- |
| `-1` | 能区分 `running` / `exited` / `stopped`，并各自给出正确的 `exit_code` |
| `-2` | 自愈并回写：pid 已死、无 `.exit`、条目写着 running → 磁盘被改成 exited |
| `-3` | 标出哪条是本会话起的（两个不同 context key 交叉断言） |
| `-4` | `prune: true` 返回删除计数且只删该删的 |
| `-5` | `spawn_error` 可见，且不会被误报成 running |
| `-6` | 坏文件如实报告：列表仍能列出其它条目，并报出坏条目数量 |
| `-7` | `include_finished: false` 只列仍在跑的 |
| `H1a` | 展示 `.exit.error` 与 `.exit.signal`，且与 `spawn_error` 能区分 |

### F6（`tests/bg-stop.test.ts`，5 条）
| ID | 用例 |
| --- | --- |
| `-1` | **杀进程树**：起一个会生成孙进程的命令 → stop 后**孙进程也死**（用存活检测断言，不看 taskkill 的输出） |
| `-2` | 幂等：对已结束任务 stop → 不报错、不改已有 `exit_code` |
| `-3` | 成功后 `status === "stopped"` 且 `ended_at` 非空（返回值与注册表都写） |
| `-4` | 不存在的 `task_id` → 明确错误，不抛栈 |
| `-5` | 失败不得谎报：进程仍活时不写 stopped，返回原始 stderr |

### F7（`tests/bg-lifecycle.test.ts`，6 条）
| ID | 用例 |
| --- | --- |
| `-1` | 四个工具真的被注册；子代理被 `tool_call` 全部拦下，主会话放行 |
| `-2` | 工具内部守卫：注入 `isSubAgent: true` → `execute` 也拒绝（不 spawn、不弹窗、不写文件） |
| `-3` | `.pi/agents/*.md` 的 `tools:` 白名单**不含**这四个工具 |
| `-4` | `session_shutdown` **不杀**任务：触发后进程仍活，并提示本会话起的仍在跑的任务 |
| `-5` | `session_shutdown` 可**重复触发**（幂等，不抛、不重复通知） |
| `-6` | 既有守卫未回归：递归守卫与 ASK 守卫照旧 |

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
| 不破坏既有全量套件（F8 时为 **325/325**） | 每批全量测试 |
| 不引入第二个 `bash` 工具 | grep：新工具名都是 `myflow_bg_*` |
| 每个功能点单独提交 | §1 的实际提交序列（**主会话执行提交**） |

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

## 6. 评审项（结局）

| # | 事项 | 结局 |
| --- | --- | --- |
| `R-1` | 后台命令用哪个 shell？原建议是「用平台默认的 `shell` 选项（Windows 上即 `cmd.exe`）」 | **已推翻（用户裁定）**：改为**自解析 POSIX 外壳**（`MYFLOW_BG_SHELL` → settings `shellPath` → Git Bash → `PATH` bash），命令作为**单个 argv** 交给 `bash -lc`；**没有 `cmd.exe` 兜底**，解析不到就拒绝并写 `error`。理由：`cmd.exe` 路径上带引号的命令必然坏，宣传它可用才是说谎。落在 `efd5106` + `design.md` §2.1 / §8 |
| `R-2` | 日志无限增长是否轮转 | **采纳「不做轮转」**，记为 §8 已知限制；`prune` 只删已结束任务的日志 |
| `R-3` | `prune` 默认关 | **采纳**：`createBgListTool` 只在 `params.prune === true` 时清理 |
| `R-4` | 子代理不可用 | **采纳**：三层守卫（白名单 + `tool_call` + `execute` 自检），`F7 -1/-2/-3` 锁定 |
| `R-5` | `wait_ms` 上限 30s | **采纳**：`MAX_WAIT_MS = 30000`，轮询 100ms |

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
