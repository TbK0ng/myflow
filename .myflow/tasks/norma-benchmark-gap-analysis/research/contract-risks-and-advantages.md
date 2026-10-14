# T3 — 宿主契约风险（`RISK-*`）与相对优势（`ADV-*`）

覆盖 `CAP-CTX-01..03`。证据码同 design §3.1（`E0` 自证/`E1` Pi 1.2.0 docs/`E2` 安装类型快照/`E3` myflow/`E4` Norma）。
Pi 侧一律 `[v1.2.0]`；本片未使用 `E5`。

## 1 `CAP-CTX-01..03`

| 能力项 | Norma `E4` | Pi 1.2.0 `E1`/`E2` | 域 / `O-*` | myflow `E3` | 码 |
| --- | --- | --- | --- | --- | --- |
| `CTX-01` 状态注入的持久与恢复 | 每会话 `state.json`（版本守卫 + 原子写），缺 sidecar 时 `RebuildStateFromLog` 冷启动重建：`noaadapter/state_store.go:74-90,131-152`、`materialize.go:9-30,73-84`；重启存活 `enable_test.go:193-204` | `custom_message` 参与 LLM context（`session-format.md:178`）**但是合法压缩切点**（`compaction.md:134`）；压缩可由扩展拦截（`compaction.md:293-320`） | `A-PI`(原语)/`A-MF`(语义) `O-3` | 每回合重注入 + 压缩后重挂 + 缺失扫描：`index.ts:319-338,384-406,455-457`；`R-T` `tests/extension.test.ts:224-255` | `V-OWNED`（无独立账本 → RISK-02） |
| `CTX-02` 会话身份 ↔ 任务指针绑定 | 账本带 sessionId；子会话 `DeriveChildState` 换自己 id 继承 blocks，父链 `InheritState` 回溯：`noaadapter/state_store.go:16-27`、`inherit.go:29-36,63-84` | id 来自 `sessionManager.getSessionId()`（`E2` `.pi/extensions/myflow/pi-coding-agent.d.ts:16-18`），bash 侧 `PI_SESSION_ID`（`environment-variables.md:20-31`）；`/fork`、`/clone` = 新会话文件新 id（`session-format.md:72-75`），`/tree` 同文件（`sessions.md:20-26`） | `A-PI` `O-3`/`O-4` | 两侧各派生 `pi_<sanitize(id)>`：`index.ts:161-192` ↔ `task.py:96-117`、`get_context.py:101-111`；`R-T` `tests/task-bridge.test.ts:27-56` | `V-QUAL`（无父链继承、无 fork 交接） |
| `CTX-03` 注入预算与降级 | 分层压缩 + 溢出学习窗 + `OnWarn`：`noa/tier.go`、`noaadapter/overflow.go:9-57` | 无「注入预算」，只有压缩阈值（`compaction.md:43-49`） | `A-MF` `O-5` | 三级字节上限 + 截断标记 + 汇总提示：`context-injection.ts:20-24,162,250`；`R-T` `tests/context-injection.test.ts` | `V-OWNED` |

## 2 RISK

### RISK-01 上下文键两侧派生等价
- **假设**：`PI_SESSION_ID` ≡ `getSessionId()`。
- **依赖行为**：bash 工具收「当前 session id」（`environment-variables.md:20-31`，未言与扩展 API 的关系）；fork/clone 换新会话即换 id（`session-format.md:72-75`）；**同进程内是否即时切换 = `推断`**。
- **证据**：`E1`+`E2`，无跨进程一致性文档；两侧规范化等价（`[^A-Za-z0-9._-]+→_`、去首尾 `._-`、截 160）：`index.ts:161-163` ↔ `task.py:96-99`；id 字符集本为字母数字与 `._-`（`cli.md:93,105`），故规范化近似恒等。
- **失效后果**：找不到 `<key>.json` → `no_task`；状态与 `/myflow-status` 可见，但 `task-context` 注入消失（子代理空 spec 语境）→ 半静默。
- **补偿**：`MYFLOW_CONTEXT_ID` 优先且子代理继承父键（`task.py:109-111`、`subagent.ts:446`）；无键时单会话回退（`turn-cache.ts:52-60`）。
- **码 / 钉住**：`R-SOFT`；加端到端断言「真会话内 `task.py current --source` == `context:pi_<getSessionId>`」。

### RISK-02 注入 vs 压缩
- **假设**：压缩吃掉状态块后一定被察觉并重注入。
- **依赖行为**：`custom_message` 既是合法切点（`compaction.md:134`）又参与 context（`session-format.md:178`）；`session_before_compact` 同回合先于 `context`（`extensions.md:62-64` 的 run 起点顺序 + `compaction.md:37`，**间接旁证 = `推断`**）；`context` 改写为请求级、事后还原（`extensions.md:116`）。
- **失效后果**：单回合丢状态块（`index.ts:384` 早退），模型失去阶段约束而行为静默偏移；`/myflow-status` 仍正确 → 不易察觉。
- **补偿**：`lastCompactionTs`（`index.ts:455-457`）+ `lastInjectionTs`（`:327`）+ 缺失即重挂（`:395-406`）；`R-T` `tests/extension.test.ts:224-255`。
- **码 / 钉住**：`R-OK`（定向自愈，失败窗口 1 回合）；把 `:395` 的缺失判定提到 `:384` 早退之前以去掉时序依赖。

### RISK-03 `.runtime` 机器本地性 → 子代理上下文静默丢失
- **假设**：任务指针文件与被派发子代理同树可见。
- **依赖行为**：无宿主依赖；`.runtime` 被 gitignore（`.gitignore:5`），worktree 只复制 `copy:` 白名单（`worktree.py:279-289`），本仓无 `worktree.yaml` → 不复制。
- **失效后果**：换机 / 新 clone / 新 worktree → 扩展判 `no_task`（`turn-cache.ts:45-51`；`get_context.py:118-127` 记 `context-missing`），子代理带父键在无该文件的树里运行 → **静默零 spec 注入**（同 P0「空上下文门禁」成因）。
- **补偿**：`worktree.py start` 以提示词携带 `Active task:` + `MYFLOW_SKIP_BREADCRUMB=1`（`worktree.py:411-424`）；`task.py create` 即写指针（`tests/task-bridge.test.ts:206-216`）。对「键在而文件缺」**无**告警 → 补偿不完整。
- **码 / 钉住**：`R-HARD`；`get_context.py` 对 `context-missing` 输出显式告警；派发前断言指针存在；`worktree create` 复制 `.runtime/sessions/`。

### RISK-04 A-EXT 落在核心流程上（shell 工具）
- **假设**：`pi-rounded-tools` 保持本机补丁。
- **依赖行为**：该包重注册 `read/write/edit/bash/grep/find/ls`，须转发 `shellPath`（`~/.pi/agent/npm/node_modules/pi-rounded-tools/extensions/rounded-tools.ts:38-47,286-294`）；Pi 内建 `createBashTool(cwd,{shellPath})` 本可用（`cli.md:111-120`）。
- **失效后果**：更新该包即丢补丁 → bash 命中 `System32\bash.exe` → 每条命令报 WSL 错误；**响亮失败**但易误判为宿主故障。
- **补偿**：AGENTS.md 记录还原步骤；补丁副本 `~/.pi/agent/patches/rounded-tools.shellPath-patched.ts`；Pi 自身回退与补丁指向同一 Git 安装。
- **码 / 钉住**：`R-SOFT`（可见、可恢复，且该扩展可被 Pi 内建工具替代）；启动自检 `uname -a` 须为 `MINGW64_NT`，并把补丁与还原写入 `.myflow/spec/`。

### RISK-05 两侧「无键」回退口径不一致
- **假设**：扩展与 `get_context.py` 对同一会话报同一活动任务。
- **依赖行为**：无（纯 myflow 内部不一致）。
- **证据**：`E3` — 无键时扩展仅「恰好一个会话文件」才采用（`turn-cache.ts:52-60`），脚本取 mtime 最新（`get_context.py:129-130`）。
- **失效后果**：同回合 `session-context` 注入「CURRENT TASK: X」而状态块写 `no_task`；不报错。
- **补偿**：有键路径两侧一致；无键路径无。
- **码 / 钉住**：`R-SOFT`；统一为「有键→精确，无键→单文件否则 `no_task`」并加对照测试。

## 3 ADV（★ = 不可回退）

### ★ ADV-01 有界写者才可并行 + 路径级 fail-closed
- 机制：`parallel` + 可写 + 无 `writesUnder` → **抛错**（`subagent.ts:636-647`）；子进程按声明对 `..`/绝对/空白 fail-closed（`agents.ts:42-56`、`subagent.ts:452-453`、`index.ts:437-452`）。
- 层级 / 回归：`E-C[myflow]`；`R-T` `tests/subagent.test.ts:310-332,456-579`。
- Norma 对照：`(NEG)` 语料 `../Norma/**/*.go` 全仓，检索式 `writesUnder|WriteScope|allowedPath|AllowedPath`，命中 0；`RunParallel` 仅信号量限流（`coordinator/coordinator.go:112-116`）。
- 不可回退：回退即两 agent 共写同一工作树，而工作树是唯一交付边界。护栏：上述测试 + `workflow.md` 并行条款。

### ★ ADV-02 派发上限 + 逐 run 可回溯日志
- 机制：`MAX_PARALLEL_PROMPTS=6`（`subagent.ts:57,633`）+ 墙钟上限（`:64,655`）+ 原始流日志（`:439-442`），停跑回报 cap/日志/`exitCode 124`。
- 层级 / 回归：`E-C[myflow]`；`R-T` `tests/subagent.test.ts:208-252`。
- Norma 对照：有 run 内预算与收尾（`harness/query.go:110,531-543`），无父侧取消与逐 run 日志命名；myflow **无收尾阶段**（见 §4）。
- 不可回退：日志是超时后唯一复核证据。护栏：超时/日志测试。

### ★ ADV-03 注入预算显式降级（拒绝静默丢弃）
- 机制：三级字节上限 + 截断标记 + 汇总提示（`context-injection.ts:20-24,162,250`）。
- 层级 / 回归：`E-C[myflow]`；`tests/context-injection.test.ts`。
- Norma 对照：以压缩分层（`noa`）处理同一压力，无对应「omitted 提示」。
- 不可回退：静默截断会让子代理误以为已读全。护栏：预算测试 + `implement.md` §6 算术。

### ★ ADV-04 递归守卫是代码 + research 工具白名单
- 机制：`myflow-research` 白名单无 `bash`（`.pi/agents/myflow-research.md:5`）+ `tool_call` 对子代理调用 `myflow_subagent` 直接 block（`index.ts` 的 tool_call 守卫，与 S3 `SUB-02` 一致）。
- 层级 / 回归：`E-G[myflow→Pi]` + `E-C[myflow]`；`R-T` `tests/subagent.test.ts:427-454`。
- Norma 对照：`MaxDepth` 代码守卫同强度（`Norma/subagent/subagent.go:84`；测试 `subagent_test.go:61-71`）。
- 不可回退：递归派发指数放大 token 与写冲突。护栏：上述测试。

**ADV-05（简记，未展开模板）**：`/myflow-status` 无模型调用（`index.ts:253-271`）+ `get_context.py --json` + 跳过关键字 / `MYFLOW_SKIP_BREADCRUMB`（`index.ts:310-315`、`escape-hatch.ts`）；Norma 无工作流状态概念可观测；护栏 `tests/escape-hatch.test.ts`。

## 4 其他发现与取证边界

- **DOC-DRIFT-01**（**建议登记，但不是 `RISK-*`**）：`.pi/skills/myflow-meta/references/harness-conventions.md:101-102` 写「All six hooks」并漏 `agent_before_settle`，实际注册 7 个（`index.ts`；`tests/scaffold.test.ts:148-156`）。它不是宿主契约风险（不依赖 Pi 行为），属文档漂移 → 建议在 `tests/scaffold.test.ts` 增断言「文档 hook 名集合 == handlers 键集合」，而非列为风险项。
- **修正 PRD Q3 的示例**：递归守卫实为 `E-C`（代码）+ `E-G`（白名单），**非**仅提示词（与本片、S3 一致）；该「名义有、实际靠约定」反例应改指仍属 `E-P` 的条目（如 research 的「一文件一主题」纪律）。
- **全量读**：`.pi/extensions/myflow/{index,turn-cache,subagent,agents,context-injection}.ts`、`.myflow/scripts/{task,get_context}.py` 相关函数、`tests/{extension,task-bridge,session-context,subagent,scaffold}.test.ts` 相关用例、`.gitignore`。
- **抽样读（非逐行）**：`noaadapter/{state_store,materialize,overflow,inherit}.go`、`noa/state.go`、`subagent/subagent.go`、`coordinator/coordinator.go`、`harness/query.go`。
- **未读（他片承担）**：`noa` 其余文件（S4/S6）、`transcript/`（S5）、与 CTX 无关的 Pi 文档（T1）。
- **`E5`/推断清单**：①「压缩先于 `context`」的同回合先后；②`/fork` 是否**同进程内**即时更换 `getSessionId()`（「新会话即新 id」本身为 `E1`）；③`before_agent_start` 返回的 message 被持久化为 `custom_message` 条目（`session-format.md:176-178` 定义了该条目类型，未逐字说明该来源）。
- **负向断言**：全片 1 条（`ADV-01` 的 Norma 检索），已给语料、检索式与命中 = 0。
