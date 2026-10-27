# 04 — Pi 契约风险登记册（`RISK-*`）

> **版本锚点**：myflow@`0a702fa`、Norma@`52f17dd`、Pi **1.2.0**（`E0`/`E1`/`E2`，见 `research/00-baseline.md`）。
> **判定规则**：`design.md` §5.3（风险码）、§4（强制层级/回归轴）、§8.5（条目模板）、§2.2（归属域，含 `A-EXT` 分级规则）、§6（误判防呆三测）。
> **取材**：`research/contract-risks-and-advantages.md`（T3，本册核心输入）、`research/pi-surface-completeness.md`（T1）、`research/myflow-enforcement-tiers.md`（T2）、各域分片；`02-matrix.md` §0/§5；`03-gap-register.md` §0。
> **路径前缀**：Pi 证据省略 `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/`；Norma 证据省略 `../Norma/`；
> myflow 证据省略 `.pi/extensions/myflow/`（`ix`=index、`sb`=subagent、`ci`=context-injection、`tc`=turn-cache、`st`=status、`ag`=agents），测试省略 `tests/`。
> **本文件不引入 12 个分片、`02-matrix.md`、`03-gap-register.md` 之外的新结论或新证据**；所有代码行号已由 B3 逐条**复核对照当前工作树**（复核记录见 §6）。

---

## 0. 复核与计数总览

| 码 | 条数 | 说明 |
| --- | --- | --- |
| `R-HARD` | **1** | `RISK-03`（`.runtime` 机器本地性 → 子代理静默零注入） |
| `R-SOFT` | **4** | `RISK-01`、`RISK-04`、`RISK-05`、`RISK-06` |
| `R-OK` | **1** | `RISK-02`（压缩吃掉注入，有定向自愈） |
| **合计** | **6** | — |

**对 T3 的复核结论**：T3 产出 `RISK-01..05`，本批**逐条复核后全部采纳**（行号与机制均与当前工作树一致，见 §6）。
另新增 `RISK-06`（源自 `research/norma-sub-coord.md §3 补注` 的既有发现，非新证据），因其属「myflow 假设自身的守卫覆盖全部派发路径」而未在 T3 单列。

**与 `03-gap-register.md` 的关系（防重复计数）**：`GAP-CTX-04` 是 `RISK-03` + `RISK-05` 的**补足动作**（含补足标准）；
本册只承载**风险登记**（假设 / 依赖 / 后果 / 钉住手段），**不重复**给出 `GAP-*` 的补足标准。
`GAP-SKILL-04` 声明的「依赖 `A-EXT:pi-mcp-adapter`」由本册 §5 的 `A-EXT` 专节承接。

---

## 1. `R-HARD`（未文档化 / 易变 ∧ 失效后果严重）

### RISK-03 `.myflow/.runtime/` 机器本地性 → 子代理上下文静默丢失

- **myflow 的假设**：任务指针文件（`.myflow/.runtime/sessions/<key>.json`）与被派发的子代理**同树可见**。
- **依赖的 Pi 行为**：无（本条**不依赖** Pi 行为，是 myflow 自身的存储布局假设 + worktree/git 语义）。
  失效链：`.runtime/` 被 gitignore（`.gitignore:5`）→ 换机 / 新 clone / 新 worktree 不带该目录；
  `worktree.py create` 只复制 `config["copy"]` 白名单（`worktree.py:279-289`），本仓库无 `worktree.yaml` ⇒ 不复制。
- **证据与强度**：`E3`（myflow 源码，本仓库当前提交）+ `E0`（本机目录实存）。
  文档化程度：**隐含**（`AGENTS.md` 只记 `.runtime/` 被 gitignore，未声明跨树可见性依赖）。
  关键行：`.gitignore:5`、`worktree.py:279-289`、`turn-cache.ts:38-51`、`get_context.py:118-127`。
- **失效后果**：换机 / 新 clone / 新 worktree 后，扩展判 `no_task`（`turn-cache.ts:45-51`），
  `get_context.py` 记 `context-missing`（`get_context.py:118-127` 分支），**子代理带父键在无该文件的树里运行 → 静默零 spec 注入**。
  可观测性：**半静默**——`/myflow-status` 仍能报 `no_task`，但没有任何「键在而文件缺」的告警，子代理静默失去 spec 语境（与 P0「空上下文门禁」同成因）。
- **现有补偿**：
  - `worktree.py start` 以提示词携带 `Active task:` + `MYFLOW_SKIP_BREADCRUMB=1`（`worktree.py:411-424`）；
  - `task.py create` 即写指针（`tests/task-bridge.test.ts:206-216`）。
  - **对「键在而文件缺」这一情形：无告警**（补偿不完整）。
- **风险码**：`R-HARD`。
- **钉住手段**（≥1）：
  1. **断言测试**：`tests/task-bridge.test.ts` 增「键在而 `<key>.json` 缺失 → 显式告警而非静默 `no_task`」（`GAP-CTX-04` 的护栏，本册不复制其补足标准）；
  2. **启动期校验**：`worktree.py create` 复制 `.runtime/sessions/`，或 `worktree.py start` 在派发前断言指针存在；
  3. **运行时登记**：无（纯 myflow 侧，不需运行时）。

---

## 2. `R-SOFT`（有文档背书，或失效可观测 / 可恢复）

### RISK-01 上下文键两侧派生等价（`PI_SESSION_ID` ↔ `getSessionId()`）

- **myflow 的假设**：`PI_SESSION_ID`（bash 侧）≡ `sessionManager.getSessionId()`（扩展侧），
  且**fork/clone 后两侧同步换新 id**。
- **依赖的 Pi 行为**：
  - bash 工具收到「当前 session id」（`docs/environment-variables.md:20-31`，**未言**与扩展 API 的关系）；
  - 扩展侧 id 来自 `sessionManager.getSessionId()`（`pi-coding-agent.d.ts:16-18`，属仓库内 Pi 类型快照 = 弱化 `E2`）；
  - `/fork`·`/clone` 生成新会话新 id（`docs/session-format.md:72-75`），`/tree` 同文件（`docs/sessions.md:20-26`）。
- **证据与强度**：`E1` + `E2`；**无跨进程一致性文档**。文档化程度：**未文档化**（两侧等价为推断）。
  两侧规范化逐字符等价已核对：`[^A-Za-z0-9._-]+→_`、去首尾 `._-`、截 160
  ——`ix:158-163`（`sanitizeKey`）↔ `task.py:96-99`（`_sanitize_key`）↔ `get_context.py:95-98`。
  因 Pi session id 字符集本为字母数字与 `._-`（`docs/cli.md:93,105`），规范化近似恒等。
- **失效后果**：两侧键不一致 → 找不到 `<key>.json` → `no_task`；状态与 `/myflow-status` **可见**，
  但 `task-context` 注入消失（子代理空 spec 语境）→ **半静默**。
- **现有补偿**：`MYFLOW_CONTEXT_ID` 优先且子代理继承父键（`task.py:109-111`、`sb:440-446` 的 `env[MYFLOW_CONTEXT_ENV]`）；
  无键时单会话回退（`tc:52-60`）。
- **风险码**：`R-SOFT`。
- **钉住手段**：
  1. **断言测试**：端到端断言「真会话内 `task.py current --source` == `context:pi_<getSessionId>`」（`QGAP-CTX-02` 的 `P0-R` 护栏）；
  2. **启动期校验**：扩展在 `session_start` 打印派生键的**形状**（不含全文），与 `get_context.py --json` 的 `source` 字段比对。

### RISK-04 `A-EXT` `pi-rounded-tools` 重注册核心工具且依赖本机 `shellPath` 补丁

- **myflow 的假设**：`pi-rounded-tools` 保持本机补丁（转发 `shellPath`），使 `bash` 命中 Git for Windows 而非 WSL 启动器。
- **依赖的 Pi 行为**：该包重注册 `read/write/edit/bash/grep/find/ls`，须转发 `shellPath`
  （`~/.pi/agent/npm/node_modules/pi-rounded-tools/extensions/rounded-tools.ts:38-47,286-294`，B3 已复核）；
 Pi 内建 `createBashTool(cwd,{shellPath})` 本可正确解析（`docs/cli.md:111-120`）。
  ⇒ 这是 **`A-EXT` 覆盖了 `A-PI` 原语**，而非 Pi 契约本身。
- **证据与强度**：`E0`（本机包实存）+ `E3`/工作区 `AGENTS.md`。文档化程度：**明示**（`AGENTS.md` 记录了补丁与还原步骤）。
- **失效后果**：更新该包即丢补丁 → `bash` 命中 `System32\bash.exe`（WSL 启动器）→ **每条命令报 WSL 错误**；
  **响亮失败**但易被误判为 Pi 故障（`AGENTS.md` 已列出该误判）。
- **现有补偿**：补丁副本 `~/.pi/agent/patches/rounded-tools.shellPath-patched.ts`；
 Pi 自身回退与补丁指向**同一** Git 安装（`C:\Program Files\Git\bin\bash.exe`）；
  `AGENTS.md` 记录「更新后还原补丁」步骤。
- **风险码**：`R-SOFT`（可见、可恢复，且该扩展可被 Pi 内建工具替代）。
- **钉住手段**：
  1. **启动期校验**：`uname -a` 须报 `MINGW64_NT`，否则停止使用 bash 工具；
  2. **防御性自愈**：把补丁文件与还原步骤沉淀为可重放的脚手架（`.myflow/spec/` 候选，见 `08-coverage.md`）；
  3. **运行时登记**：在 `AGENTS.md` 保留「更新即还原补丁」条款（已存在）。

### RISK-05 两侧「无键」回退口径不一致

- **myflow 的假设**：扩展与 `get_context.py` 对**同一会话**报同一活动任务。
- **依赖的 Pi 行为**：无（纯 myflow 内部不一致，`A-MF` 内部）。
- **证据与强度**：`E3`（已复核）。文档化程度：**隐含**（两侧 docstring 都声称「mirror the extension」，但无键分支不一致）。
  扩展：无键时**仅「恰好一个会话文件」**才采用，否则 `no_task`（`tc:52-60`，B3 已复核）；
  脚本：无键时取 mtime 最新（`get_context.py:129-130`，B3 已复核）。
- **失效后果**：同回合 `session-context` 注入「CURRENT TASK: X」而状态块写 `no_task`；**不报错**（静默不一致）。
- **现有补偿**：有键路径两侧一致（`RISK-01`）；**无键路径无补偿**。
- **风险码**：`R-SOFT`。
- **钉住手段**：
  1. **断言测试**：新增「无键 + 多会话文件」用例，断言扩展与脚本返回**同一**活动任务或同一 `no_task`（`GAP-CTX-04` 的护栏）；
  2. **防御性自愈**：统一为「有键→精确，无键→单文件否则 `no_task`」并加对照测试。

### RISK-06 递归守卫与 `writesUnder` 路径守卫对 channel peer worker 不生效

- **myflow 的假设**：`tool_call` 递归守卫（`ix:420-432`）与 `writesUnder` 路径守卫（`ix:434-451`）覆盖**所有**被派发的代理。
- **依赖的 Pi 行为**：无（纯 myflow 内部：守卫以 `MYFLOW_AGENT_TYPE` → `isSubAgent` 为开关，`ix:239-241`）。
- **证据与强度**：`E3`（已复核）。文档化程度：**隐含**（`channel.py:566-569` 只对 reviewer 设 `MYFLOW_VERIFY_GATE`，**不设** `MYFLOW_AGENT_TYPE`；
  `ix:241` `const isSubAgent = agentType !== null;` ⇒ peer worker 判为 `isSubAgent=false`）。
  出处：`research/norma-sub-coord.md §3 补注`（既有发现，本批未新增证据）。
- **失效后果**：channel peer worker（`.pi/skills/myflow-channel/SKILL.md:33-46`）**可间接递归派发** `myflow_subagent`，
  且其写入不受 `writesUnder` 路径级约束；**不报错**（守卫静默旁路）。
- **现有补偿**：channel 侧 `max_live_workers=3`（`channel.py:77,506`）+「one reviewer per tree」（`channel.py:512-523`）
  部分限制放大；`MYFLOW_SKIP_BREADCRUMB=1` 降低误触任务生命周期。
- **风险码**：`R-SOFT`（可观测：worker 日志；放大受限；但守卫确实旁路）。
- **钉住手段**：
  1. **防御性自愈**：`channel.py` 启动 worker 时也注入 `MYFLOW_AGENT_TYPE`（或独立 `MYFLOW_WORKER=1`），使 `ix:241` 判为受守卫进程；
  2. **断言测试**：`tests/channel.test.ts` 增「peer worker 派发 `myflow_subagent` 被拒」用例；
  3. **代码前置校验**：`channel.py` 在 `spawn` 时校验 `MYFLOW_AGENT_TYPE` 存在，缺失即拒绝启动。

---

## 3. `R-OK`（myflow 已有自身补偿路径）

### RISK-02 注入 vs 压缩：状态块被吃掉后的重挂

- **myflow 的假设**：压缩吃掉 `workflow-state` 块后，一定被**察觉并重注入**。
- **依赖的 Pi 行为**：
  - `custom_message` **既是合法压缩切割点**（`docs/compaction.md:130,134`）**又参与 LLM context**（`docs/session-format.md:178`，B3 已复核）；
  - `session_before_compact` 事件在同回合先于 `context` 钩子（`docs/extensions.md:62-64` 的 run 起点顺序 + `docs/compaction.md:37`，**间接旁证 = 推断**）；
  - `context` 改写为**请求级**、事后还原（`docs/extensions.md:116`）。
- **证据与强度**：`E1` + `E3`。文档化程度：**明示**（切点规则与事件表均有一手原文）；
  「同回合先后」为**隐含/推断**（`RISK` 的残余风险点）。
- **失效后果**：单回合丢状态块（`ix:384` 早退判定依赖 `lastInjectionTs > lastCompactionTs`），
  模型失去阶段约束而**行为静默偏移**；`/myflow-status` 仍正确 ⇒ **不易察觉**。
- **现有补偿**（B3 逐行复核，均与当前工作树一致）：
  - 每回合 `before_agent_start` 重注入（`ix:319-338`）并置 `lastInjectionTs`（`ix:327`）；
  - `session_before_compact` 置 `lastCompactionTs`（`ix:455-457`）；
  - `context` 钩子中 `lastInjectionTs > lastCompactionTs` 早退（`ix:384`），否则扫描现有 `workflow-state` 块，
    未找到即追加（`ix:386-417`）——即**压缩标记先置时，本回合必然重挂**；
  - 回归护栏：`tests/extension.test.ts:224-255`（`R-T`）。
- **风险码**：`R-OK`（定向自愈，最坏 1 回合失败窗口）。
- **钉住手段**：
  1. **断言测试**：扩展 `tests/extension.test.ts:224-255`，增「压缩标记先置、无后续事件仍能重挂」（`QGAP-CMPT-05` 的 `P1` 护栏，本册不复制其补足标准）；
  2. **运行时登记**：在本册登记「Pi 若改切点规则或事件时序，本补偿**静默**失效」——监控点，触发即转 `R-HARD`；
  3. **代码前置**：把缺失判定提前到 `ix:384` 早退之前，去掉对事件到达顺序的依赖。

---

## 4. 文档漂移（**明确不计入** `RISK-*`）

### DOC-DRIFT-01 `harness-conventions.md` 的 hook 计数过期

- **现象**：`.pi/skills/myflow-meta/references/harness-conventions.md:101-102` 写
  「All six hooks stay registered: `session_start`, `input`, `before_agent_start`, `context`, `tool_call`, `session_before_compact`」，
  但实际注册 **7** 个事件（`ix:273,302,319,340,420,455,464`，`agent_before_settle` 注册于 `ix:464`）；
  同文件 `:110` 另段单列了 `agent_before_settle`（`myflow-meta/SKILL.md:60-68` 同样漂移）。
  出处：`research/norma-ext-integrate.md §2`、`research/contract-risks-and-advantages.md §4`、`02-matrix.md §5.2 C-4`。
- **为什么**不进 `RISK-*`**：`RISK-*` 的定义是「myflow 对**Pi 行为**的假设 + 假设不成立的后果」
  （`design.md` §5.3）。本条是 myflow **自身文档与自身代码**不一致，**不依赖任何 Pi 行为**，
  且已由测试兜住实际行为（`tests/extension.test.ts:166` 的「all hooks registered」断言含 `agent_before_settle`；
  `tests/scaffold.test.ts:148-156` 更以 `deepEqual` 锁定全部 7 个 handler 键）。**C2 注意**：`tests/subagent.test.ts:415`
  的用例标题为「all 6 hooks」且只断言 6 个 handler（**不含** `agent_before_settle`），是一条陈旧的弱护栏，**不足以**支撑「7 个」判定；
  本条据以钉住的是 `tests/extension.test.ts:166` 与 `tests/scaffold.test.ts:148-156`。它属文档卫生，不属 Pi 契约风险（`T3 §4` 同判）。
- **建议的钉住测试**：在 `tests/scaffold.test.ts` 增断言「文档 hook 名集合 == `extension()` 内 `pi.on()` 的 handlers 键集合」
  （或反向：扫描 `harness-conventions.md` 的 hook 列表并与 `Object.keys(handlers)` 比对），
  把**文档契约钉成测试**——与 `tests/workflow-invariant.test.ts:71` 的既有先例同法。

---

## 5. `A-EXT` 依赖风险专节（核心流程耦合度核查）

> `design.md` §2.2：`A-EXT` 能力**不得**记为 `V-PI`；若某项**仅**由 `A-EXT` 提供且处于 myflow 核心流程上，须在 `RISK-*` 登记。
> 本节的核查结论是**逆向**的：myflow 自身派发路径对 `A-EXT` **低耦合**，唯一落在核心流程上的 `A-EXT` 是 `pi-rounded-tools`。

| 能力 / 工具 | 归属域（注册者证据） | 是否在 myflow 核心流程 | 卸载 / 失效后果 |
| --- | --- | --- | --- |
| `Agent`/`StopAgent`/`MessageAgent`/`AgentStatus` | `A-EXT:pi-subagents-lite` v1.17.0（`registration.ts:66,121,132,143` + `:112,129,140,149`） | **否**——myflow 用自有的 `myflow_subagent`（`sb:573`）与 channel peer worker，**不调用**这四个工具 | 四工具消失；myflow 派发不受影响。**用户级编排能力丢失**（`RISK` 仅在用户依赖时成立，不在 myflow 核心流程） |
| MCP 工具（`mcp__*`、代理） | `A-EXT:pi-mcp-adapter`（`settings.json` 的 `extensions:["-builtin:mcp"]` + `pi-builtin-mcp.ts:10-25`、`index.ts:1725`） | **否**——myflow 无任何 MCP 集成（`sb:69` 仅进程清理注释） | MCP 工具消失；**且内建 MCP 仍处停用**（`-builtin:mcp` 未被改回）⇒ MCP 全无。**未来 `GAP-SKILL-04` 补足后将新增此依赖**，届时须重新评估 |
| `codebase-memory` 15 个裸名工具（`search_graph` 等） | `A-EXT`（`cbmem.ts:1-60`，`spawn` 一个 exe，**非 MCP、非 core**） | **否**——myflow 不使用 | 图检索工具消失；myflow 流程不受影响。工作区 `AGENTS.md` 仅将其作为**建议**，非强制路径 |
| `bash`（本环境） | `A-PI` 原语，被 `A-EXT:pi-rounded-tools` 重注册 | **是**（`bash` 是核心工具；子代理与 verify 均用） | **见 `RISK-04`**：丢补丁即命中 WSL 启动器，命令全失败 |
| `@upstash/context7-pi`（skills）、`@firstpick/pi-themes-bundle`、`pi-agent-loop`、`pi-ask-side`、`pi-open-tui`、`pi-tui-commands`、`rtk.ts`、`cbmem.ts` | `A-EXT`（`~/.pi/agent/npm/node_modules/`、`~/.pi/agent/extensions/`；清单见 `00-baseline.md §3.2/§3.3`） | **否**——不在 myflow 派发 / 状态 / 门禁路径 | 各自功能消失；myflow 不受影响 |

**核查结论**：
1. myflow 的核心派发路径（`myflow_subagent` + `channel.py`）**不依赖任何 `A-EXT` 注册的工具**——这是重要的**低耦合**正面结论（与 `02-matrix.md` §0 的归属表互证）。
2. 唯一落在核心流程上的 `A-EXT` 是 `pi-rounded-tools`（`RISK-04`）；它是**可替换**的（Pi 内建 `createBashTool` 本可用），故不构成 `R-HARD`。
3. MCP 域存在一个**条件性**未来依赖（`GAP-SKILL-04`），已在 §5 表中显式标注「届时须重新评估」，避免补足时**静默**引入 `A-EXT` 核心依赖。

---

## 6. 复核记录（B3 逐条对照当前工作树）

| 风险 | T3 原文行号 | B3 复核结果 |
| --- | --- | --- |
| `RISK-01` | `index.ts:161-163` ↔ `task.py:96-99` | ✅ 一致（`sanitizeKey` / `_sanitize_key` 正则与截断逐字符等价）；`get_context.py:95-98` 同式 |
| `RISK-02` | `index.ts:384`、`:395-406`、`:455-457`、`:327` | ✅ 一致（早退判定 `:384`、扫描重挂 `:386-417`、压缩记时 `:455-457`、注入记时 `:327`） |
| `RISK-03` | `.gitignore:5`、`turn-cache.ts:45-51`、`get_context.py:118-127`、`worktree.py:279-289,411-424` | ✅ 一致（`.gitignore:5` = `.myflow/.runtime/`；copy 白名单 `:279-289`；work order `Active task:` `:411-424`） |
| `RISK-04` | `rounded-tools.ts:38-47,286-294` | ✅ 一致（shellPath passthrough 注释段与设置读取在同文件） |
| `RISK-05` | `turn-cache.ts:52-60`、`get_context.py:129-130` | ✅ 一致（扩展「恰好一个文件」vs 脚本 `max(..., key=st_mtime)`） |
| `RISK-06`（新增） | `index.ts:241`、`channel.py:566-569` | ✅ 一致（`isSubAgent = agentType !== null`；`channel.py` 只设 `MYFLOW_VERIFY_GATE`） |
| `DOC-DRIFT-01` | `harness-conventions.md:101-102`、`index.ts:464` | ✅ 一致（文档写 6、实际 7；测试 `extension.test.ts:157-169` 已断言 7） |

---

## 7. `P0-R` 建议清单（后续任务优先钉住）

> 依据 `design.md` §9：`P0-R` 与是否缺口无关，独立成列；按「失效后果严重度 × 可否仅靠 myflow 侧钉住」排序。

| 序 | 风险 | 建议任务 slug | 钉住动作 | 预计代价 |
| --- | --- | --- | --- | --- |
| 1 | `RISK-03`（`R-HARD`） | `myflow-context-pointer-integrity`（与 `GAP-CTX-04` 同任务） | 键在而指针缺失 → 显式告警；`worktree` 复制 `.runtime/sessions/` | 小 |
| 2 | `RISK-01` + `RISK-05` | `myflow-session-key-contract-pin`（与 `QGAP-CTX-02` 同任务） | 端到端断言键派生等价；统一无键回退口径 | 小 |
| 3 | `RISK-06` | `myflow-channel-worker-guards` | `channel.py` 注入 worker 标识，使 `ix:241` 判为受守卫进程；加拒绝用例 | 小 |
| 4 | `RISK-02` | `myflow-compaction-injection-timing`（与 `QGAP-CMPT-05` 同任务） | 把缺失判定提前到早退之前，去掉事件时序依赖 | 小 |
| 5 | `RISK-04` | `myflow-shell-path-guard` | 启动自检 `uname -a`；把补丁与还原沉淀为 spec | 小 |
| 6 | `DOC-DRIFT-01`（非风险） | 并入 `TEST-02` 护栏 | 文档 hook 集合 == handlers 键集合的断言 | 小 |

---

## 8. 需新证据 / 未完成

**需新证据：无。** 本册全部条目与复核结论均可回溯到 `research/*.md`、`02-matrix.md` 或 `03-gap-register.md` 的既有证据；
`RISK-06` 源自 `research/norma-sub-coord.md §3` 的既有发现，未引入新证据。

**未完成：无。** `RISK-01..06` + `/DOC-DRIFT-01` + `A-EXT` 专节均已写全（逐字段对照 `design.md` §8.5）。
