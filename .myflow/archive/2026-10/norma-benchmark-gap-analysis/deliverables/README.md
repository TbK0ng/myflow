# myflow × Norma 能力横评 — 交付索引（README）

> **来源戳**（发布时由主会话改写为实际值）：
> `myflow@0a702fa`（主会话在发布时替换为实际 HEAD）、`Norma@52f17dd52d95b087265e5d5b306fe85c1ea05599`、`pi 1.2.0`。
> **交付时间戳**：`<主会话在发布时写入>`。**证据快照来源**：本任务目录 `.myflow/tasks/norma-benchmark-gap-analysis/research/*.md`
> （12 个分片，已由主会话复制到 `evidence/`）。
> **权威版本面**：Pi 侧 = 已安装的 **1.2.0** 产物（`C:/Users/wocai/.bun/install/global/node_modules/@earendil-works/*`）；
> `Desktop/pi` 源码为 **1.0.4**，**不作为权威依据**。Norma 侧 = 只读参考 `../Norma@52f17dd`。

---

## 1. 这份横评是什么

这是一份**三层能力横评**：以 Norma（Go 编写的通用 Agent Harness SDK，`../Norma`）为参照物，
对「**Pi 运行时 ∪ 用户级扩展 ∪ myflow**」逐项识别能力缺口的分析文档。它回答四个问题：

1. **X 这个关注点归谁**（Pi core / 用户级扩展 `A-EXT` / myflow / 外部 MCP / 无人）？
2. **若归 myflow，是靠什么强制的**（代码 `E-C` / 门控 `E-G` / 提示词 `E-P` / 无 `E-N`）？
3. **myflow 假设了 Pi 的哪些行为**，这些行为有多可信（宿主契约风险）？
4. **myflow 有哪些 Norma 没有的能力**，不能被回退？

覆盖范围：Norma **16 个实现包**（README 13 + `noa` + `noaadapter` + `transcript`）→ **19 域 / 82 个 `CAP-*`**。
产物：**29 `GAP-*` 真缺口 + 6 `QGAP-*` 质量差 + 6 `RISK-*` + 10 `ADV-*`（6 条 ★ 不可回退）+ 36 `NG-*` + 8 `MIS-*`**。
本任务**只产出分析文档，不改任何实现代码**；缺口条目本身就是后续实现任务的输入。

---

## 2. 文档地图（每篇「什么时候读它」）

| 文件 | 读它的时机 |
| --- | --- |
| `01-verdict.md` | **先读这篇。** 要一页拿到结论、19 域记分卡、十条最重要结论、必补/不补清单时 |
| `02-matrix.md` | 要核对**证据**时：能力归属矩阵（表 A）、myflow 承担度与强度（表 B）、判定统计（表 C） |
| `03-gap-register.md` | 要**动手补足**时：逐条 `GAP-*`/`QGAP-*` 的 8 字段补足标准（可一对一转 PRD） |
| `04-risk-register.md` | 要**钉住宿主契约风险**时：`RISK-*` 的假设 / 依赖 / 后果 / 现有补偿 / 钉住手段 |
| `05-advantage-register.md` | 要**避免补一个洞、砸一个优势**时：`ADV-*` 相对优势、6 条 ★ 不可回退、缺口×优势约束矩阵 |
| `06-non-gaps.md` | 要确认**什么不该补**时：`NG-*` 非缺口清单 + 8 项「看似缺口实际不是」专题（`MIS-*`） |
| `07-method.md` | 要**复核方法是否可信**时：判定法自包含版（三层模型、证据等级、强制层级、误判防呆三测） |
| `08-coverage.md` | 要**知道哪里没查全**时：取证边界、全量 vs 抽样、`NEG` 集中清单、推断清单、偏离记录 |
| `evidence/*.md` | 要**回溯原始取证**时：任务目录 `research/` 的 12 个分片快照 + 来源提交号 |

---

## 3. 三条阅读路径

### 路径 ① 决策者（只读两篇）

`01-verdict.md` → `03-gap-register.md` §2（优先级汇总表）。
目标：拿到「必补 8 条、不补 36 条」的排期依据，不进入证据细节。

### 路径 ② 实现者（单条缺口 → 矩阵 → 方法）

`03-gap-register.md` 选一条 `GAP-*` → `02-matrix.md` 表 B 看该能力的 myflow 现状与强制层级 →
`07-method.md` 理解「补足标准」里 `E-C`/`R-T`/`O-*` 的含义 → 必要时查 `05-advantage-register.md` 的约束矩阵。
目标：把一条 `GAP-*` 直接写成一份可验收的实现任务。

### 路径 ③ 复核者（方法 → 边界 → 原始证据）

`07-method.md`（判定法）→ `08-coverage.md`（`NEG` 集中清单 + 推断清单 + 全量/抽样边界）→ `evidence/*.md`（重跑检索式）。
目标：证伪任意一条断言，重点是所有**负向断言**（「Pi 没有 X」）与所有 `E-C` 判定。

---

## 4. 如何消费缺口条目

### 4.1 一对一转 PRD

`03-gap-register.md` 的每条 `GAP-*` / `QGAP-*` 都是**可独立验收**的最小单元，
字段已与 PRD 对齐，可**直接复制**为后续任务的 PRD 主体：

| `03-gap-register.md` 字段 | 后续任务 PRD 字段 |
| --- | --- |
| 能力描述 | `## Goal` |
| 补足标准（逐条可验收） | `## Requirements` + `## Acceptance Criteria` |
| 依赖与代价 | `## Technical Notes` |
| 优先级（`P0`/`P0-R`/`P1`/`P2` + 依据） | 排期 |
| Norma 机制与证据 / Pi 现状 / myflow 现状 / 证据等级 | 背景与依据（供评审） |

> **不建议把多个 `GAP-*` 合并成一个大任务**：合并会破坏「字段 ↔ PRD 字段」的一对一映射，
> 且让评审标准不同的条目（行为变更 vs 断言测试）混在同一任务里。理由详见 `03-gap-register.md` §3 末段。

### 4.2 必建子任务（`P0` / `P0-R`，评审通过后创建）

| 建议 slug | 覆盖条目 | 一句话 |
| --- | --- | --- |
| `myflow-context-pointer-integrity` | `GAP-CTX-04` | 键在而指针缺失 → 显式告警；两侧无键回退同口径 |
| `myflow-tool-output-cap` | `GAP-TOOL-06` | `myflow_subagent` 等结果统一上限 + 保留 `logPath` |
| `myflow-session-key-contract-pin` | `QGAP-CTX-02`（`P0-R`） | 端到端断言键派生等价 + fork 父链继承 |

次优先（`P1`）拆分建议见 `03-gap-register.md` §3。

### 4.3 实现时的硬约束

补足任一 `GAP-*` 前，先读 `05-advantage-register.md` §2 的「缺口 × 优势」约束矩阵——
每条缺口都标注了「不得牺牲的优势」（如新增权限规则表不得削弱 `writesUnder` 路径守卫）。
同时对照 `04-risk-register.md`：触碰 Pi 契约的条目须按该册的钉住手段补断言测试。

---

## 5. 交付物结构与编号一致性

本横评的交付物 = `README.md` + 8 篇编号正文（`01`–`08`）+ `evidence/` 快照。
本目录在发布前先落 `.myflow/tasks/<task>/deliverables/`，由**主会话**在发布时复制到 `../critic_doc/` 并写入来源提交号。

| 编号 | 文件 | 承载内容 |
| --- | --- | --- |
| — | `README.md` | 本索引 |
| `01` | `01-verdict.md` | 结论、记分卡、十条结论、必补/不补、一页速览 |
| `02` | `02-matrix.md` | 表 A 归属 / 表 B 承担度与强度 / 表 C 统计 |
| `03` | `03-gap-register.md` | 29 `GAP-*` + 6 `QGAP-*`（核心） |
| `04` | `04-risk-register.md` | 6 `RISK-*` + `DOC-DRIFT-01` + `A-EXT` 依赖专节 |
| `05` | `05-advantage-register.md` | 10 `ADV-*`（6 ★ 不可回退） |
| `06` | `06-non-gaps.md` | 36 `NG-*` + 8 `MIS-*` |
| `07` | `07-method.md` | 判定方法（自包含版） |
| `08` | `08-coverage.md` | 取证边界与自我审计（六问 + 偏离记录 + 交叉校验 C1–C4 结论） |
| `evidence/` | `research/*.md` 快照 | 12 个分片 + 来源提交号 |

**发布自检**（主会话执行）：`ls ../critic_doc/` 与上表逐项对齐；
`grep -c '^#### GAP-' 03-gap-register.md` = 29、`grep -c '^#### QGAP-'` = 6、
`grep -c '^### RISK-' 04` = 6、`grep -c '^### ★\? *ADV-' 05` = 10、`06` 的 `NG-*` = 36 / `MIS-*` = 8，
且与 `02-matrix.md` 表 C 统计一致。

---

## 6. 已知边界（一句话预告）

- 本横评的「Pi 无 X」结论均有结构化 `NEG` 块（检索式 + 命中 + 残余风险），但**不代表已穷尽实现**，
  只代表「在 1.2.0 安装产物与文档面未命中」（`08-coverage.md` §3）。
- `noa` 域为**抽样**而非逐行审计；`Norma/examples`、`Norma/cmd` 未读（理由见 `08-coverage.md` §1–§2）。
- 无法验证 Pi 未来版本行为；任何版本敏感处均标注 `[v1.2.0]`。
- `../critic_doc/` 不在版本控制内，用来源提交号 + `evidence/` 快照兜底。
