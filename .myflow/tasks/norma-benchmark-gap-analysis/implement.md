# implement.md — 审计执行顺序、分片与调度

> 本文件定义「按什么顺序做」；判定方法见 `design.md`。
> 本任务**只产出分析文档**，不修改任何实现代码。

---

## 0. 执行前提（硬约束，来自 harness 实测）

| 约束 | 实测依据 | 对计划的含义 |
| --- | --- | --- |
| `myflow-research` 工具白名单 = `read, find, grep, ls` | `.pi/agents/myflow-research.md` frontmatter | **子代理不能落盘**。结论随响应返回，由**主会话**写 `research/*.md`（design.md ADR-3） |
| `myflow-implement` / `myflow-check` 可写，但**一次只能一个** | `.pi/agents/*.md` tools 含 `write,edit`；`subagent.ts` 拒绝写者并行 | 写文档的 dispatch 必须**串行** |
| 每次 dispatch 有 `timeoutMs` 上限（默认 15 分钟）并落日志 | `subagent.ts`、`workflow.md` §Dispatch Protocol | 分片要小；超时必须拆小重派，不得重做 |
| dispatch prompt 必须以 `Active task: <task.py current 路径>` 开头 | `workflow.md` §Dispatch Protocol | 统一模板见 §7 |
| research 子代理**不读** jsonl | `context-injection.ts: taskContextJsonlNames()` 仅对 implement/check 返回名字 | 分片指令必须写在 **prompt** 里，不能指望清单注入 |
| 注入预算：单文件 32 KiB / 单 artifact 64 KiB / 合计 128 KiB | `context-injection.ts: DEFAULT_CONTEXT_INJECTION_LIMITS` | `research/*.md` 每个 **≤ 8 KiB**，否则清单会撑爆注入预算 |
| jsonl 行格式 `{"file": "<相对项目根的路径>"}` | `context-injection.ts` + `tests/context-injection.test.ts:68` | 见 §6 |

---

## 1. 阶段与门禁总览

| 阶段 | 动作 | 执行者 | 门禁（通过条件） |
| --- | --- | --- | --- |
| P0 | 冻结基线 | 主会话（直接命令） | `research/baseline.md` 存在且含版本自证 |
| P1-W1 | 6 个域分片取证 | 6 × `myflow-research`（**并行**） | 6 个 `research/norma-*.md` 存在 |
| P1-W2 | 交叉面取证 | 3 × `myflow-research`（**并行**） | 3 个 `research/*.md` 存在 |
| P2 | 汇总成矩阵与条目 | `myflow-implement`（**串行**，按 §5 拆 3 批） | 7 个交付文档存在 |
| P3 | 对抗式交叉校验 | `myflow-check`（串行）+ 1 × research | `coverage.md` 含校验结论 |
| P4 | 交付与评审 | 主会话 | 用户确认 §9 评审项 |

**顺序理由**：先评审（§9）再启动 P0/P1，避免分片白做。

---

## 2. P0 — 冻结基线（主会话直接执行，不派子代理）

基线不冻结，后面所有「Pi 现状」都不可信。产出 `research/baseline.md`：

1. **版本自证**（`E0`）
   - `pi --version` → 期望 `1.2.0`
   - `env | grep '^PI_'`（重点 `PI_SESSION_ID`、`PI_PROVIDER`、`PI_MODEL`）
   - `ls C:/Users/wocai/.bun/install/global/node_modules/@earendil-works/`（记下各包版本）
2. **Pi 权威面清点**（`E1`）
   - `ls <pi-coding-agent>/docs/`（起草时快照 = 41 篇正文 + `images/`；须复核）
   - 记录每篇文件名，供 P1-W2 做反向覆盖核对
3. **归属域清点**（`E0` / design.md §2.2）
   - `ls ~/.pi/agent/npm/node_modules/` 与 `@*/*`
   - `ls ~/.pi/agent/extensions/`、`~/.pi/agent/skills/`
   - `python -c "json.load(settings.json)"` 取键名；`cat ~/.pi/agent/mcp.json`
   - **必须确认** `Agent`/`StopAgent`/`MessageAgent`/`AgentStatus` 的注册者 = `pi-subagents-lite`（`A-EXT`），
     且 `myflow_subagent` 的注册者 = `A-MF`
4. **仓库基线**
   - `git rev-parse HEAD`、`git status --short`
   - `Norma` 侧提交：`git -C ../Norma rev-parse HEAD`（若为 git 仓库；否则记时间戳）
5. **Norma 遍历清单**：`Norma` 顶层目录 + `*.go` 文件计数，标注哪些目录**本次不审计**及理由

---

## 3. P1-W1 — 六个域分片（并行，一次 6 个）

每个分片**同时**负责 Norma 侧与该域的 Pi 1.2.0 侧，输出一个 `research/*.md`（≤ 8 KiB）。

| 分片 | 覆盖能力项 | Norma 语料 | Pi 1.2.0 语料（`E1`，须逐篇读） |
| --- | --- | --- | --- |
| `S1-llm` | `CAP-LLM-01..03` | `Norma/llm/` | `providers.md`、`models.md`、`custom-provider.md`、`virtual-models.md`、`llama-cpp.md`、`codemode.md`、`configuration.md` |
| `S2-tool-perm` | `CAP-TOOL-01..05`、`CAP-PERM-01..05` | `Norma/tool/`、`Norma/permission/` | `extensions.md`（§Tools、`tool_call`、`tool_result`）、`security.md`、`settings.md`、`usage.md` |
| `S3-loop-orch` | `CAP-LOOP-01..05`、`CAP-SUB-01..03`、`CAP-COORD-01..02` | `Norma/harness/`、`Norma/subagent/`、`Norma/coordinator/` | `how-pi-works.md`、`extensions.md`（事件表、`ctx.executeTool`、`turn_end`/`agent_before_settle`）、`sdk.md`、`rpc.md`、`rpc-commands.md`、`cli.md`、`message-types.md` |
| `S4-ctx-persist` | `CAP-CMPT-01..05`、`CAP-CORE-01..04`、`CAP-CTX-01..02` | `Norma/compaction/`、`Norma/agentcore/`、`Norma/transcript/` | `compaction.md`、`session-format.md`、`sessions.md`、`json.md` |
| `S5-ext-integrate` | `CAP-HOOK-01..04`、`CAP-MCP-01..03`、`CAP-SKILL-01..04` | `Norma/hook/`、`Norma/mcp/`、`Norma/skill/` | `extensions.md`、`mcp.md`、`skills.md`、`packages.md`、`prompt-templates.md`、`slash-commands.md`、`themes.md` |
| `S6-plan-memory` | `CAP-PLAN-01..03`、`CAP-MEM-01..04`、`CAP-OBS-01`、`CAP-TEST-01` | `Norma/plan/`、`Norma/memory/` | `usage.md`、`codemode.md`、`settings.md`、`skills.md`、`keybindings.md` |

**每个分片必须产出**（写入 `research/<分片>.md`）：

1. 表 A 片段：`CAP-*` × 〔Norma 机制+证据 / Pi 现状+证据 / 归属域 / `O-*` 码〕
2. 对每个「Pi 无」的断言，按 design.md §3.3 写 `NEG` 块（检索式 + 残余风险）
3. 明确标注「全量读了哪些文件」vs「只做了检索」
4. 未读清单与理由
5. **单独一节**：本域内发现的可疑「Pi 刻意外包」原文引用（供 `O-2` 判定）

**完成判据**：6 个文件均存在；每条 Pi 判定带 `[v1.2.0]` 与路径；无 `E5` 单独支撑的结论。

---

## 4. P1-W2 — 交叉面三分片（并行）

W1 是「按域正查」；W2 是**反向覆盖与横向验证**。前一次假阴性就是靠这一层才可能被发现。

| 分片 | 目的 | 输出 |
| --- | --- | --- |
| `T1-pi-surface` | **反向覆盖**：逐篇读 Pi `docs/`（41 篇），列出「W1 六片均未归入任何 `CAP-*` 的 Pi 能力」。这是「Pi 已给但我方没想到要比较」的漏网口，也是 `O-1` 清单的补全 | `research/pi-surface-completeness.md` |
| `T2-myflow-tiers` | L3 自审：对 design.md §7.2 的**每一个** `CAP-*` 定 `E-*`（带施加强制者）与 `R-*`，给 `证据:行`。重点识别 `E-P` 条目 | `research/myflow-enforcement-tiers.md` |
| `T3-risk-adv` | 契约风险与优势：产出 `RISK-*`（重点：`PI_SESSION_ID` 会话键派生、注入与压缩/分支的交互、`.myflow/.runtime/` 机器本地性）与 `ADV-*`（重点：唯一写者机制、dispatch 上限与日志、research/check 分离） | `research/contract-risks-and-advantages.md` |

`T1` 的判据独立于 W1：**不得**复用 W1 的结论，必须自底向上从 `docs/` 目录重扫一遍。
`T3` 必须验证 design.md 里那条已取证链条：
`index.ts:237-253`（`before_agent_start` 返回 `custom_message`）+ `compaction.md:134`
+ `session-format.md:178` + `index.ts` 的 `context` 钩子 `lastInjectionTs > lastCompactionTs`
→ `RISK` 应判 `R-OK`（已有自身补偿）还是 `R-HARD`，需给出论证。

---

## 5. P2 — 汇总成文档（`myflow-implement`，串行 3 批）

写者唯一，故拆成 3 次**串行** dispatch，每次一批文件：

| 批次 | 产出文件 | 输入 |
| --- | --- | --- |
| B1 | `matrix.md` | 全部 `research/*.md` + design.md §8.2/8.3/8.7 |
| B2 | `gaps.md`（核心）、`non-gaps.md` | `research/*.md` + design.md §8.4/§9 |
| B3 | `risks-and-advantages.md`、`coverage.md`、`index.md` | `research/*.md` + design.md §8.5/8.6/§10 |

**为什么拆 3 批而不是 1 批**：单批容易超 15 分钟上限且一次失败全丢；分批的中间结果可复用。
**为什么 `gaps.md` 单独一批**：它是 AC 的核心承载物，需要最大的注意力预算。

每批 dispatch 必须要求：
- 每条断言可回溯到 `research/` 或原始路径（design.md DoD）
- 不得引入 `research/` 中不存在的新结论（如需新证据，**停止并报告**，不要自行发明）
- 完成判据自检（对照 design.md §8 的表头字段是否齐全）

---

## 6. Step 1.3 — jsonl 清单（在 P1 完成后、`task.py start` 之前）

**格式**：每行一个 JSON 对象，键 `file`，值为**相对项目根**的路径（`context-injection.ts` 用 `resolve(projectRoot, file)`）。

`implement.jsonl`（供 `myflow-implement`）：

```jsonl
{"file": ".myflow/tasks/norma-benchmark-gap-analysis/research/baseline.md"}
{"file": ".myflow/tasks/norma-benchmark-gap-analysis/research/norma-llm.md"}
{"file": ".myflow/tasks/norma-benchmark-gap-analysis/research/norma-tool-perm.md"}
{"file": ".myflow/tasks/norma-benchmark-gap-analysis/research/norma-loop-orch.md"}
{"file": ".myflow/tasks/norma-benchmark-gap-analysis/research/norma-ctx-persist.md"}
{"file": ".myflow/tasks/norma-benchmark-gap-analysis/research/norma-ext-integrate.md"}
{"file": ".myflow/tasks/norma-benchmark-gap-analysis/research/norma-plan-memory.md"}
{"file": ".myflow/tasks/norma-benchmark-gap-analysis/research/pi-surface-completeness.md"}
{"file": ".myflow/tasks/norma-benchmark-gap-analysis/research/myflow-enforcement-tiers.md"}
{"file": ".myflow/tasks/norma-benchmark-gap-analysis/research/contract-risks-and-advantages.md"}
{"file": "../Norma/README.md"}
```

`check.jsonl`（供 `myflow-check`）：同上，**去掉** `../Norma/README.md` 之外的差异不大，但**必须**保留
全部 `research/*.md`（它们是校验基准），并追加 design.md 的**证据规则**复用：
`{"file": ".myflow/tasks/norma-benchmark-gap-analysis/design.md"}`。

**预算核对**：`prd.md`(≈18 KiB) + `design.md`(≈15 KiB) + 10 × `research/*.md`(≤8 KiB 各)
+ `Norma/README.md` ≤ 18 + 15 + 80 + 10 ≈ 123 KiB，逼近但**不超** 128 KiB 总上限。
→ 若任一分片超 8 KiB，**必须拆分该分片**，而不是放任注入截断（截断会静默丢证据，比缺文件更危险）。

**注意**：`design.md` 不被自动注入（`taskContextInputPaths` 只强制 `prd.md`/`info.md`/`config.yaml`），
所以它出现在 `check.jsonl` 里是有意为之。

---

## 7. Dispatch 模板

```
Active task: .myflow/tasks/norma-benchmark-gap-analysis

分片：<Sx / Tx>
目标：<一句话>

必读（先读规则再取证）：
- .myflow/tasks/norma-benchmark-gap-analysis/design.md  §2.2 归属域、§3 证据规则、§4 层级、§5 判定
- .myflow/tasks/norma-benchmark-gap-analysis/prd.md

语料：
- Norma：../Norma/<子目录>
- Pi 1.2.0：C:/Users/wocai/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/<篇>
- myflow：.pi/extensions/myflow/、.pi/agents/、.pi/skills/、.myflow/

输出（**在响应中返回，不要尝试写文件——你没有 write 工具**）：
1. 逐条 <CAP-*>：Norma 机制+证据 / Pi 1.2.0 现状+证据 / 归属域 / O-* 码 / V-* 码
2. 每条「无」断言按 design.md §3.3 的 (NEG) 格式
3. 自我声明：全量读了什么、只检索了什么、未读什么及理由
4. 篇幅 ≤ 8 KiB

禁止：以 Desktop/pi（1.0.4）作为唯一依据；无路径的印象式判断；把 A-EXT 记作 A-PI。
```

---

## 8. P3 — 对抗式交叉校验

不用「读一遍觉得对」的方式，而是三个**可证伪**检查：

| 检查 | 做法 | 失败即 |
| --- | --- | --- |
| C1 **负向断言复核** | 抽出 `coverage.md` 的全部 `NEG` 块，逐条**重跑检索式**，并额外用「该概念的正面枚举词」再搜一遍 | 有假阴性 → 回到对应分片 |
| C2 **层级复核** | 对每个标 `E-C` 的条目，要求指出会拒绝的代码行；指不出 → 降级为 `E-G`/`E-P` | 强度虚高 → 修正判定 |
| C3 **归属复核** | 对每个标 `O-1` 的条目，做 design.md §6 测 A（卸载测试） | 归属错 → 修正 `A-*` 域 |

执行方式：`myflow-check` 做 C2/C3（需要读代码），再派 1 个 `myflow-research` 专门做 C1
（只读检索，符合其工具白名单）。

---

## 9. 评审项（`task.py start` 前请用户确认）

| 编号 | 事项 | 建议 |
| --- | --- | --- |
| `R-1` | **PRD DoD 与 spec 沉淀冲突**（design.md ADR-4）：DoD 要求 `git status` 除 `.myflow/tasks/` 外零变更，但 Q2 默认值要求沉淀 `.myflow/spec/`，workflow 3.1 又是 `[required]` | 建议：本任务只写任务目录，`coverage.md` 附「可沉淀清单」，沉淀留给后续任务。**若同意，需同时修订 PRD 的 DoD 措辞** |
| `R-2` | 相邻任务处理：`.myflow/tasks/explain-myflow-directory/` 仍为 `planning` | 建议：保持不动，本任务仅复用其结论 |
| `R-3` | 交付文档粒度 = 7 个文件（design.md §8.1） | 若嫌多可合并 `non-gaps.md` 进 `matrix.md`，但会削弱 AC「≥3 项看似缺口实际不是」的可核查性 |
| `R-4` | 分片数 = 6（W1）+ 3（W2） | 已达并行上限 6；W2 必须等 W1 |

**未确认前不执行 P0/P1。**

---

## 10. 完成判据（对应 PRD AC 的逐条落点）

| PRD AC | 落在哪个文件 |
| --- | --- |
| 覆盖 Norma 13 包，每项有 Norma 证据 | `matrix.md` 表 A（S1–S6 全覆盖） |
| Pi 侧判定指向 1.2.0 具体文档 + 版本标注 | `matrix.md` 表 A 末列 + `coverage.md` |
| 缺口条目含 7 个必备字段 | `gaps.md`（design.md §8.4 模板） |
| ≥3 项「看似缺口实际不是」 | `non-gaps.md` |
| 「有」的判定附强制层级；≥2 项提示词约定实证 | `matrix.md` 表 B + `gaps.md` 的 `QGAP-*` |
| 契约风险覆盖会话键/压缩交互/runtime 本地性 | `risks-and-advantages.md` 的 `RISK-*` |
| ≥3 项相对优势标不可回退 | `risks-and-advantages.md` 的 `ADV-*` |
| 区分已核实/推断 + 取证边界 | `coverage.md`（design.md §10 五问） |
| 中文撰写，术语保留英文 | 全部文档 |

---

## 11. 回退与失败处理

| 情形 | 处理 |
| --- | --- |
| 某研究分片超 15 分钟被截断 | 读其日志 `.myflow/.runtime/subagent-logs/`，拆成更小分片重派；**不要重做已完成部分** |
| 某分片结论明显偏离（如把 `A-EXT` 记为 `A-PI`） | 修正该分片的 dispatch prompt 后重派，并在 `coverage.md` 记录该次修正 |
| 注入被截断（`[truncated]` 标记出现） | 拆分过大的 `research/*.md`，不得让校验在截断状态下进行 |
| 发现 PRD 本身有误（如再次出现假阴性） | 回 Phase 1（planning）修订 PRD，再继续 |
