# implement.md — 审计执行顺序、分片与发布

> 本文件定义「按什么顺序做」；判定方法见 `design.md`。
> 本任务**只产出分析文档**，不修改任何实现代码。
> 产物分两段：分片取证落 `.myflow/tasks/<task>/research/`，成品文档先落
> `.myflow/tasks/<task>/deliverables/`，最后由**主会话**发布到 `../critic_doc/`（ADR-6 / §13）。

---

## 0. 执行前提（硬约束，来自 harness 实测）

| 约束 | 实测依据 | 对计划的含义 |
| --- | --- | --- |
| `myflow-research` = `read, write, find, grep, ls`，**无 bash / 无 MCP** | `.pi/agents/myflow-research.md` frontmatter | 子代理不能跑命令、不能查图；取证只能靠读文件 |
| research 写范围被**代码**限制在 `<active task>/research/` | `writesUnder: research`；`.myflow/spec/harness/index.md` | 分片可**并行**各自落盘；但**不能**直接写 `deliverables/` 或 `../critic_doc/` |
| `myflow-implement` / `myflow-check` 可写但**一次只能一个** | `.pi/agents/*.md` tools 含 `write,edit` 且无 `writesUnder`；`subagent.ts` 拒绝写者并行 | 写文档的 dispatch 必须**串行** |
| 每次 dispatch 有 `timeoutMs` 上限（默认 15 分钟）并落日志 | `subagent.ts`；`workflow.md` §Dispatch Protocol | 分片要小；超时必须拆小重派，不得重做 |
| dispatch prompt 必须以 `Active task: <task.py current 路径>` 开头 | `workflow.md` §Dispatch Protocol | 统一模板见 §7 |
| research 子代理**不读** jsonl | `context-injection.ts: taskContextJsonlNames()` 仅对 implement/check 返回名字 | 分片指令必须写在 **prompt** 里 |
| 注入预算：单文件 32 KiB / 单 artifact 64 KiB / **合计 128 KiB** | `context-injection.ts: DEFAULT_CONTEXT_INJECTION_LIMITS`（本仓库无 `.myflow/config.yaml`，走默认值） | 必须做预算算术（§6）；超限条目会被换成 `[myflow: context limit reached…]` 提示 |
| `prd.md` + `design.md` + `implement.md` **三者都会被自动注入** | `.pi/extensions/myflow/context-injection.ts`（P0-3 已落地） | jsonl 里**不要再列**这三份，否则白占预算 |
| 本任务无 `verify:` 配置 | 无 `.myflow/worktree.yaml` → `worktree.py verify` 空跑 | `myflow-check` 的门禁不构成实质校验，P3 的 C1/C2/C3 才是真校验 |

---

## 1. 阶段与门禁总览

| 阶段 | 动作 | 执行者 | 门禁（通过条件） |
| --- | --- | --- | --- |
| P0 | 冻结基线 | 主会话（直接命令） | `research/00-baseline.md` 存在且含版本自证 |
| P1-W1-A | 5 个域分片 | 5 × `myflow-research`（**并行**） | 5 个 `research/*.md` 存在 |
| P1-W1-B | 3 个域分片 | 3 × `myflow-research`（**并行**） | 3 个 `research/*.md` 存在 |
| P1-W2 | 交叉面三分片 | 3 × `myflow-research`（**并行**） | 3 个 `research/*.md` 存在 |
| P2 | 汇总成 9 份文档 | `myflow-implement`（**串行**，按 §5 拆 4 批） | `deliverables/` 下 9 份存在 |
| P3 | 对抗式交叉校验 | `myflow-check`（串行）+ 1 × research | `deliverables/08-coverage.md` 含校验结论 |
| P4 | 发布与评审 | 主会话 | `../critic_doc/` 与 §13 清单一致；用户确认 §9 评审项 |

**顺序理由**：先评审（§9）再启动 P0/P1，避免分片白做。

---

## 2. P0 — 冻结基线（主会话直接执行，不派子代理）

基线不冻结，后面所有「Pi 现状」都不可信。产出 `research/00-baseline.md`：

1. **版本自证**（`E0`）
   - `pi --version` → 期望 `1.2.0`
   - `env | grep '^PI_'`（记下 `PI_SESSION_ID` 的**形状**，不要落全文）
   - `ls C:/Users/wocai/.bun/install/global/node_modules/@earendil-works/`（各包版本）
2. **Pi 权威面清点**（`E1`）
   - `ls <pi-coding-agent>/docs/`（起草时快照 ≈ 41 篇 + `images/`；须复核并逐篇列名）
3. **归属域清点**（`E0` / design.md §2.2）
   - `ls ~/.pi/agent/npm/node_modules/` 与其中的 `@*/*`
   - `ls ~/.pi/agent/extensions/`、`~/.pi/agent/skills/`
   - `cat ~/.pi/agent/mcp.json`
   - **必须确认** `Agent`/`StopAgent`/`MessageAgent`/`AgentStatus` 的注册者 = `pi-subagents-lite`（`A-EXT`），
     且 `myflow_subagent` 的注册者 = `A-MF`
4. **仓库基线**
   - `git rev-parse --short HEAD`、`git status --short`
   - `git -C ../Norma rev-parse --short HEAD`
5. **Norma 遍历清单**：16 个实现包 + `examples/` + `cmd/`，标注哪些**本次不审计**及理由
6. **预算基线**：`wc -c` 三个 artifact，算出 jsonl 余量（§6）

---

## 3. P1-W1 — 八个域分片（两波，各 ≤ 5 并发）

每个分片**同时**负责 Norma 侧与该域的 Pi 1.2.0 侧，输出一个 `research/*.md`（**≤ 6 KiB**）。
Pi 侧语料一律是 `C:/Users/wocai/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/<篇>`。

### 波 A（5 并发）

| 分片 | 覆盖能力项 | Norma 语料 | Pi 1.2.0 语料（`E1`） |
| --- | --- | --- | --- |
| `S1-llm-tool` | `CAP-LLM-01..04`、`CAP-TOOL-01..06` | `Norma/llm/`、`Norma/tool/`、`Norma/harness/`（输出上限相关） | `providers.md`、`models.md`、`custom-provider.md`、`virtual-models.md`、`llama-cpp.md`、`extensions.md`（§Tools / `tool_call` / `tool_result`）、`security.md`、`settings.md` |
| `S2-perm-loop` | `CAP-PERM-01..05`、`CAP-LOOP-01..06` | `Norma/permission/`、`Norma/harness/` | `how-pi-works.md`、`extensions.md`（事件表 / `ctx.executeTool` / `turn_end` / `agent_before_settle`）、`security.md`、`sdk.md`、`rpc.md`、`rpc-commands.md`、`cli.md`、`message-types.md` |
| `S3-sub-coord` | `CAP-SUB-01..03`、`CAP-COORD-01..02` | `Norma/subagent/`、`Norma/coordinator/` | `extensions.md`、`sdk.md`、`packages.md`、`how-pi-works.md` |
| `S4-cmpt-noa-core` | `CAP-CMPT-01..05`、`CAP-NOA-01..03`、`CAP-NOA-09` | `Norma/compaction/`、`Norma/noa/`（`refs.go` `tier.go` `state.go` `boundaries.go` `pipeline.go` `recommend.go` `sync.go` `rebuild.go`） | `compaction.md`、`session-format.md`、`sessions.md` |
| `S5-noaa-trans-core` | `CAP-NOA-10`、`CAP-NOAA-01..07`、`CAP-TRANS-01..04`、`CAP-CORE-01..04` | `Norma/noaadapter/`、`Norma/transcript/`、`Norma/agentcore/`、`Norma/noa/archive.go` `state.go` | `sessions.md`、`session-format.md`、`json.md`、`compaction.md` |

### 波 B（3 并发）

| 分片 | 覆盖能力项 | Norma 语料 | Pi 1.2.0 语料 |
| --- | --- | --- | --- |
| `S6-noa-integrity` | `CAP-NOA-04..08`、`CAP-NOA-11` | `Norma/noa/`（`nudge.go` `nudgetext.go` `turnintegrity.go` `toolpairs.go` `protected.go` `truncate.go` `prune.go` `hideconsumed.go` `prompts_*.go` `panel.go` `parseinput.go`） | `compaction.md`、`session-format.md`、`message-types.md` |
| `S7-ext-integrate` | `CAP-HOOK-01..04`、`CAP-MCP-01..03`、`CAP-SKILL-01..04` | `Norma/hook/`、`Norma/mcp/`、`Norma/skill/` | `extensions.md`、`mcp.md`、`skills.md`、`packages.md`、`prompt-templates.md`、`slash-commands.md`、`themes.md` |
| `S8-plan-mem` | `CAP-PLAN-01..03`、`CAP-MEM-01..04` | `Norma/plan/`、`Norma/memory/` | `usage.md`、`codemode.md`、`settings.md`、`skills.md`、`keybindings.md` |

**为什么 `noa` 被拆成两片**（S4 拿 ref/tier/block 与建议，S6 拿 nudge/完整性/保护/截断/提示词）：
它是全仓最大目录（5392 行、11 个能力项），单片必然超 15 分钟且超 6 KiB。

**每个分片必须产出**（写入 `research/<分片>.md`）：

1. 表 A 片段：`CAP-*` × 〔Norma 机制+证据 / Pi 现状+证据 / 归属域 / `O-*` 码〕
2. 对每个「Pi 无」的断言，按 design.md §3.3 写 `NEG` 块（检索式 + 残余风险）
3. 明确标注「全量读了哪些文件」vs「只做了检索」
4. 未读清单与理由
5. **单独一节**：本域内发现的可疑「Pi 刻意外包」原文引用（供 `O-2` 判定）
6. **单独一节**：本域内 Norma 有、而 myflow 已用自己的办法解决的地方（供 `ADV-*` 与 `V-OWNED`）

**完成判据**：8 个文件均存在；每条 Pi 判定带 `[v1.2.0]` 与路径；无 `E5` 单独支撑的结论。

---

## 4. P1-W2 — 交叉面三分片（并行）

W1 是「按域正查」；W2 是**反向覆盖与横向验证**。上一次假阴性就是靠这一层才可能被发现。

| 分片 | 目的 | 输出 |
| --- | --- | --- |
| `T1-pi-surface` | **反向覆盖**：逐篇读 Pi `docs/`，列出「W1 八片均未归入任何 `CAP-*` 的 Pi 能力」。这是「Pi 已给但我方没想到要比较」的漏网口，也是 `O-1` 清单的补全 | `research/pi-surface-completeness.md` |
| `T2-myflow-tiers` | L3 自审：对 design.md §7.2 的**每一个** `CAP-*` 定 `E-*`（带施加强制者）与 `R-*`，给 `证据:行`。重点识别 `E-P` 条目；并覆盖 `CAP-OBS-01..02`、`CAP-TEST-01..02` | `research/myflow-enforcement-tiers.md` |
| `T3-risk-adv` | 契约风险与优势：覆盖 `CAP-CTX-01..03`，产出 `RISK-*`（重点：`PI_SESSION_ID` 会话键派生、注入与压缩/分支的交互、`.myflow/.runtime/` 机器本地性、`A-EXT` 核心流程依赖）与 `ADV-*`（重点：唯一写者机制、dispatch 上限与日志、research/check 分离） | `research/contract-risks-and-advantages.md` |

`T1` 的判据独立于 W1：**不得**复用 W1 的结论，必须自底向上从 `docs/` 目录重扫一遍。
`T3` 必须验证 design.md 里那条已取证链条：
`index.ts:237-253`（`before_agent_start` 返回 `custom_message`）+ `compaction.md:134`
+ `session-format.md:178` + `index.ts` 的 `context` 钩子 `lastInjectionTs > lastCompactionTs`
→ `RISK` 应判 `R-OK`（已有自身补偿）还是 `R-HARD`，需给出论证。

---

## 5. P2 — 汇总成文档（`myflow-implement`，串行 4 批）

写者唯一，故拆成 4 次**串行** dispatch。产出**先落** `.myflow/tasks/<task>/deliverables/`，
由主会话在 P4 发布到 `../critic_doc/`（implement/check **不得**直接写 `../critic_doc/`）。

| 批次 | 产出文件（`deliverables/`） | 输入 |
| --- | --- | --- |
| `B1` | `02-matrix.md` | 全部 `research/*.md` + design.md §8.2/8.3/8.7 |
| `B2` | `03-gap-register.md`（核心） | `research/*.md` + design.md §8.4/§9 |
| `B3` | `04-risk-register.md`、`05-advantage-register.md`、`06-non-gaps.md` | `research/*.md` + design.md §8.5/8.6 |
| `B4` | `README.md`、`01-verdict.md`、`07-method.md`、`08-coverage.md` | 已完成的三批 + `research/00-baseline.md` + design.md §2–§6/§10 |

**为什么拆 4 批而不是 1 批**：单批容易超 15 分钟上限且一次失败全丢；分批的中间结果可复用。
**为什么 `03-gap-register.md` 单独一批**：它是 AC 的核心承载物，需要最大的注意力预算。
**为什么 `01-verdict.md` 放最后**：判词必须读得到完整的缺口登记册。

每批 dispatch 必须要求：

- 每条断言可回溯到 `research/` 或原始路径（design.md DoD）
- 不得引入 `research/` 中不存在的新结论（如需新证据，**停止并报告**，不要自行发明）
- 完成判据自检（对照 design.md §8 的表头/字段是否齐全）
- 只在 `deliverables/` 内写文件，不动 `research/`、不动 `.pi/`、不动代码

---

## 6. Step 1.3 — 预算算术与 jsonl 清单（P1 完成后、`task.py start` 之前）

**格式**：每行一个 JSON 对象，键 `file`，值为**相对项目根**的路径
（`context-injection.ts` 用 `resolve(projectRoot, file)`）。
用 `python .myflow/scripts/task.py add-context <task> implement <path> "<why>"` 追加。

**分片文件名（固定）**：

| 名称 | 产出 |
| --- | --- |
| `research/00-baseline.md` | P0 |
| `research/norma-llm-tool.md` | `S1-llm-tool` |
| `research/norma-perm-loop.md` | `S2-perm-loop` |
| `research/norma-sub-coord.md` | `S3-sub-coord` |
| `research/norma-cmpt-noa-core.md` | `S4-cmpt-noa-core` |
| `research/norma-noaa-trans-core.md` | `S5-noaa-trans-core` |
| `research/norma-noa-integrity.md` | `S6-noa-integrity` |
| `research/norma-ext-integrate.md` | `S7-ext-integrate` |
| `research/norma-plan-mem.md` | `S8-plan-mem` |
| `research/pi-surface-completeness.md` | `T1` |
| `research/myflow-enforcement-tiers.md` | `T2` |
| `research/contract-risks-and-advantages.md` | `T3` |

**预算算术（必须实算，不得估算）**：

```bash
cd .myflow/tasks/norma-benchmark-gap-analysis
wc -c prd.md design.md implement.md     # 三者被自动注入 → 计入每次 dispatch 的总量
wc -c research/*.md                     # 只有被该 agent 的 jsonl 引用的才计入
# 规则：Σ(prd+design+implement) + Σ(本次 jsonl 引用的 research) ≤ 122880 (120 KiB)
# 起草时实测：prd+design+implement = 64,892 B（≈63.4 KiB）→ 每次 dispatch 的 jsonl 余量 ≈ 64 KiB
```

**关键决定（不要全量列入 jsonl）**：三次 P2 批次的**关注面不同**，把 12 个分片全塞进
`implement.jsonl` 会让每批都背负 60+ KiB 无关语料。因此：

- **`implement.jsonl`（计划 5 条，≤ 30 KiB）**：`00-baseline.md`、`myflow-enforcement-tiers.md`、
  `contract-risks-and-advantages.md`、`pi-surface-completeness.md`、`norma-cmpt-noa-core.md`
  → 实算 64,892 + 30,720 = **95,612 B** ✓
- **`check.jsonl`（计划 8 条，≤ 48 KiB）**：8 个域分片
  （校验者需要完整证据面才能复核 `NEG` 与 `E-C`；`00-baseline.md` 改在 prompt 里 `read`）
  → 实算 64,892 + 49,152 = **114,044 B** ✓（余量约 8.6 KiB）
- **其余分片**由对应批次的 dispatch prompt **点名让子代理自行 `read`**
  （子代理有 `read` 工具；jsonl 的作用是「保证到手」，不是「唯一入口」）

**明确不列**：`prd.md` / `design.md` / `implement.md`（已自动注入）、`../Norma/README.md`
（§3 已把所需 Norma 证据摘进分片）。

**硬上限与实际落点（P1 完成后实测，偏离已修正）**：原计划写「每个分片 ≤ 6 KiB」并据此算
`implement 5 条 / check 8 条`。实际 12 个分片落在 **6.6–15.8 KiB**（合计 111,953 B），
于是按 §6 阶梯重构策展并**逐字节实算**：

| manifest | 条数 | 引用的分片字节 | + artifacts | 合计 | 限值 | 余量 |
| --- | --- | --- | --- | --- | --- | --- |
| `implement.jsonl` | 6 | 54,938 | 65,161 | **120,099** | 131,072 | 10,973 |
| `check.jsonl` | 7 | 58,412 | 65,161 | **123,573** | 131,072 | 7,499 |

被移出 jsonl、改由 dispatch prompt 点名 `read` 的分片：

- implement：`norma-llm-tool`、`norma-perm-loop`、`norma-sub-coord`、`norma-noaa-trans-core`、
  `norma-ext-integrate`、`norma-plan-mem`
- check：`00-baseline`、`norma-ext-integrate`（后者 15,785 B，是最大的单个分片）

**待修（遗留问题，写进 `08-coverage.md`）**：`norma-ext-integrate.md` 超出它自己的篇幅上限近一倍；
下次同类任务应在 dispatch prompt 里给定**字节上限**而不是 KiB 目标，并在分片写完后实测再定稿。

超限时的降级顺序（**不得**放任截断，截断会静默丢证据）：

若日后确实需要一次注入更大证据面，正确做法是调 `.myflow/config.yaml` 的
`context_injection.max_total_bytes`（本仓库当前无该文件，走默认 128 KiB），
**不是**放任截断；但那是配置变更，须单独评审并提交。

---

## 7. Dispatch 模板

```
Active task: .myflow/tasks/norma-benchmark-gap-analysis

分片：<Sx / Tx>
目标：<一句话>

必读（先读规则再取证）：
- .myflow/tasks/norma-benchmark-gap-analysis/design.md  §2.2 归属域、§3 证据规则、§4 层级、§5 判定、§7.2 能力项
- .myflow/tasks/norma-benchmark-gap-analysis/prd.md

语料：
- Norma：../Norma/<子目录>
- Pi 1.2.0：C:/Users/wocai/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/<篇>
- myflow：.pi/extensions/myflow/、.pi/agents/、.pi/skills/、.myflow/

输出（持久化到 research/<分片>.md，你只能写 research/ 目录）：
1. 逐条 <CAP-*>：Norma 机制+证据 / Pi 1.2.0 现状+证据 / 归属域 / O-* 码 / V-* 码
2. 每条「无」断言按 design.md §3.3 的 (NEG) 格式
3. 本域「疑似 O-2（Pi 刻意外包）」的原文引用
4. 本域「Norma 有而 myflow 另法解决」的条目（供 ADV-*/V-OWNED）
5. 自我声明：全量读了什么、只检索了什么、未读什么及理由
6. 篇幅 ≤ 6 KiB

禁止：以 Desktop/pi（1.0.4）作为唯一依据；无路径的印象式判断；把 A-EXT 记作 A-PI；写 research/ 之外的文件。
```

P2 的 dispatch 在同上头部之后追加：

```
本次批次：<B1..B4>
额外必读（不在 jsonl 内，请自行 read）：
- .myflow/tasks/norma-benchmark-gap-analysis/research/<本批需要的分片>.md
产出（只写这些文件，写进 deliverables/）：
- .myflow/tasks/norma-benchmark-gap-analysis/deliverables/<文件名>
禁止：写 ../critic_doc/、改 research/、改任何代码或 .pi/ 资产。
```

---

## 8. P3 — 对抗式交叉校验

不用「读一遍觉得对」的方式，而是三个**可证伪**检查：

| 检查 | 做法 | 失败即 |
| --- | --- | --- |
| `C1` **负向断言复核** | 抽出 `08-coverage.md` 的全部 `NEG` 块，逐条**重跑检索式**，并额外用「该概念的正面枚举词」再搜一遍 | 有假阴性 → 回到对应分片 |
| `C2` **层级复核** | 对每个标 `E-C` 的条目，要求指出会拒绝的代码行；指不出 → 降级为 `E-G`/`E-P` | 强度虚高 → 修正判定 |
| `C3` **归属复核** | 对每个标 `O-1` / `V-EXT` 的条目，做 design.md §6 测 A（卸载测试） | 归属错 → 修正 `A-*` 域 |
| `C4` **预算与完整性复核** | 核对注入未出现 `[myflow: context limit reached …]`；核对 `deliverables/` 9 份齐全且编号与 §8.1 一致 | 有截断/缺件 → 补 |

执行方式：`myflow-check` 做 C2/C3/C4（需要读代码与文件），再派 1 个 `myflow-research` 专门做 C1
（只读检索，符合其工具白名单）。校验结论写进 `deliverables/08-coverage.md` 的「交叉校验」一节。

---

## 9. 评审项（`task.py start` 前请用户确认）

| 编号 | 事项 | 建议 |
| --- | --- | --- |
| `R-1` | 语料扩到 16 包、分片 8+3（ADR-7） | 已按用户 U-3 决定执行；此处仅确认分片粒度（`noa` 拆两片） |
| `R-2` | 交付骨架 9 份 + `evidence/`（ADR-6、§8.1） | 已按用户 U-4 重排；确认编号与命名 |
| `R-3` | 本任务不写 `.myflow/spec/`（ADR-4） | 本任务无代码改动，Step 3.1 将记录「无新增契约」 |
| `R-4` | `../critic_doc/` 不受版本控制 | 接受；用来源提交号 + `research/` 快照兜底 |
| `R-5` | 相邻任务 `.myflow/tasks/explain-myflow-directory/` 仍为 `planning` | 保持不动，仅复用其结论 |
| `R-6` | 缺口→实现任务的创建时机 | P4 评审通过后，每个 `GAP-*` 建一个子任务（本任务不建） |

**未确认前不执行 P0/P1。**

---

## 10. 完成判据（对应 PRD AC 的逐条落点）

| PRD AC | 落在哪个文件 |
| --- | --- |
| 覆盖 16 个实现包，每项有 Norma 证据 | `02-matrix.md` 表 A（S1–S8 全覆盖） |
| `NOA` ≥9 / `NOAA` ≥5 / `TRANS` ≥3 能力项 | `02-matrix.md` 表 A（S4/S5/S6 承载） |
| Pi 侧判定指向 1.2.0 具体文档 + 版本标注 | `02-matrix.md` 表 A 末列 + `08-coverage.md` |
| 缺口条目含 8 个必备字段 | `03-gap-register.md`（design.md §8.4 模板） |
| ≥3 项「看似缺口实际不是」 | `06-non-gaps.md` |
| 「有」的判定附强制层级；≥2 项提示词约定实证 | `02-matrix.md` 表 B + `03-gap-register.md` 的 `QGAP-*` |
| 契约风险覆盖会话键/压缩交互/runtime 本地性 | `04-risk-register.md` |
| ≥3 项相对优势标不可回退 | `05-advantage-register.md` |
| 区分已核实/推断 + 取证边界 + NEG 集中清单 | `08-coverage.md`（design.md §10 六问） |
| 中文撰写，术语保留英文 | 全部文档 |
| `../critic_doc/` 结构一致 + 来源提交号 | `README.md`（design.md §13 第 4、5 步） |

---

## 11. 回退与失败处理

| 情形 | 处理 |
| --- | --- |
| 某研究分片超 15 分钟被截断 | 读其日志 `.myflow/.runtime/subagent-logs/`，拆成更小分片重派；**不要重做已完成部分** |
| 某分片结论明显偏离（如把 `A-EXT` 记为 `A-PI`） | 修正该分片的 dispatch prompt 后重派，并在 `08-coverage.md` 记录该次修正 |
| 注入被截断（出现 `[myflow: context limit reached …]`） | 按 §6 降级顺序处理，不得让校验在截断状态下进行 |
| `myflow-implement` 试图写 `../critic_doc/` | 立即停止该批；发布是主会话的职责（ADR-6） |
| 发现 PRD 本身有误（如再次出现假阴性） | 回 Phase 1（planning）修订 PRD，再继续 |
