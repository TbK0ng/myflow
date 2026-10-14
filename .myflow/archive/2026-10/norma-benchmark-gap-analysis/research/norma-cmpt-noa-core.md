# S4 — CMPT 与 NOA 核心（ref / tier / block / 建议）

> 基线 `00-baseline.md`：Pi **1.2.0**；myflow@`0a702fa`；Norma@`52f17dd`。证据码见 design.md §3.1。
> Norma 简写：`c.go`=compaction/compaction.go，`s.go`=summarizer.go，无前缀=noa/。
> 覆盖 CAP-CMPT-01..05、CAP-NOA-01..03、CAP-NOA-09；Norma 相关文件与 Pi 三篇文档均全量读。

## 1. 表 A + myflow 列（域/O/V 见 design.md §5）

| CAP | Norma 机制 + 证据:行 | Pi 1.2.0 现状 + 证据:行 | 域 | O | myflow 现状 + 证据:行 | V |
|---|---|---|---|---|---|---|
| CMPT-01 多级压缩 | Micro(清旧工具结果,keep5)/Auto(阈值+预测)/Reactive 三层 + `compactableTools` 白名单 `c.go:62,69,173,249,295` | 阈值 AutoCompact + overflow/length 恢复，共 2 层 `compaction.md:32,37,39` | A-PI | O-3 | 全委托 Pi | V-PI + **V-GAP**(Micro) |
| CMPT-02 熔断 | `maxAutoCompactFails=3`+`tripped` 连败停压 `c.go:69,304` | 仅 `session_compact_failed` 遥测 `compaction.md:372`；已有**有界单次恢复重试** `compaction.md:39`（无连败计数） | **A-PI(原语)** | **O-3** | 无 | **V-GAP** |
| CMPT-03 PTL 反应式 | `Reactive` 复用 AutoCompact + `IsOverflow` + 摘要 PTL 重试(≤3,丢最老 20% API round) `c.go:200,212` `s.go:14,151` | overflow / `stopReason:"length"` → 一次 compact-and-retry `compaction.md:39,85` | A-PI | O-1 | 委托 Pi | V-PI |
| CMPT-04 非破坏 boundary | 留全历史，tail 前插 boundary+summary `c.go:295,344` | `CompactionEntry`+`firstKeptEntryId`，原文不删 `compaction.md:79,152` `sessions.md:40` | A-PI | O-1 | 委托 Pi | V-PI |
| CMPT-05 压缩×注入共存 | summary 后按 5k/25k 逐条重注入 skill 原文 `c.go:349,370` | `custom_message` 是合法切割点，压缩可摘要掉注入；Pi 不重注入扩展消息 `compaction.md:130,134` | A-PI+A-MF | O-3 | 自补：每回合注入 + `session_before_compact` 记时 + `lastInjectionTs>lastCompactionTs` 重注入 `index.ts:319,384,455`，回归 `tests/extension.test.ts:244` | V-QUAL |
| NOA-01 ref 寻址 | `mNNNNN` 永不重编号、`BLOCKED` 硬保护、双向 map `refs.go:15,25,74,78` `const.go:5,12` | 模型无 ref；仅宿主 entry id(8hex) 可被扩展经 `context_edit.targetId` 定位 `session-format.md:143,235` | A-NONE | O-5 | 无 | **V-GAP** |
| NOA-02 tier 分层 | 一次只压一层；`bN` tier 1..3 创建即固定；终层重写检测 `tier.go:22,30,78` `types.go:56,61` `config.go:105` | 单层；重复压缩靠 previousSummary 迭代 `compaction.md:83` | A-NONE | O-5 | 无 | **V-GAP** |
| NOA-03 block 与 rebuild | `bN` 块 + `ApplyCompression` 原子尺寸门 + `RebuildStateFromLog` 回放得**字节一致**摘要 `compress.go:77,225` `state.go:38` `rebuild.go:37,45` | 无块模型；摘要落 `CompactionEntry`，原文留 JSONL（可读但无法按 ref 重建） `compaction.md:79` `session-format.md:226` | A-NONE | O-5 | 无 | **V-GAP** |
| NOA-09 压缩建议/死区 | `BuildRecommendation`+`ViableRanges`(<200 token 死区)+死区重复拒绝(2) `recommend.go:256,267` `const.go:31,43` | 无对模型暴露的压缩建议面 | A-NONE | O-5 | 无 | **V-GAP** |

**判词**：CMPT 域 Pi 覆盖 3/5（V-PI），真缺口 2（Micro 层、熔断）；NOA 四条全为真缺口。压缩的**模型可控 / 可寻址 / 分层**是 Pi 与 myflow 共同空白层。

## 2. 负向断言（design.md §3.3）

```
(NEG) 语料=pi-coding-agent/docs/*.md 全 40 篇 (v1.2.0)
 A 检索式=tier|m0000|ref address|message ref
   命中=tier 仅 promptCache 保留等级(custom-provider.md:95, models.md:94)；余 0
   残余=「按 token 预算切段」不含 ref 词，本式只证「无 ref 名词」，靠 §3 语义互补。
 B 检索式=compress|context_edit|model-selectable|choose.*messages.*summar
   命中=compress=0；context_edit 5 处(compaction.md:93,138; extensions.md:118; session-format.md:144,235)
   残余=「模型自选压缩范围」可能有未枚举同义词；已做同义枚举复查，0 命中。
   结论=Pi 无模型可调用的压缩工具；context_edit 是扩展经 turn_end 追加的宿主条目。
 C 检索式=tier 分层|layered summary|multi-level compact → 0
   残余=previousSummary 迭代(compaction.md:83)形似分层但语义不同：迭代把上轮摘要与新消息合压一遍，
        无「同层不合压」约束。
 D 语料=docs/compaction.md 全篇；检索式=circuit|breaker|consecutive.*fail|trip ——【C1 裁决：部分】
   原命中=0；重跑=0（唯一 consecutive=skills.md:81 连字符规则）
   正面枚举命中=repeated.{0,20}fail|give up|disable.{0,20}compact → compaction.md:437、rpc-commands.md:408（人工开关）；
     **compaction.md:39「one compact-and-retry recovery attempt」= 有界单次重试**
   已排除的同义命中=以上两项（人工开关与有界单次重试均非「连败计数熔断」）
   修正后的结论=无「连败 N 次自动停压」；已有**有界单次恢复重试** → O-5 改 O-3；措辞窄化为「无连败计数熔断」
   残余=仅限文档面；内部可能有未文档化计数 → 覆盖不足，非「确认无」。
```

## 3. 能力差：Pi compaction vs Norma noa（不是「有没有压缩」）

| 维度 | Pi 1.2.0 | Norma noa |
|---|---|---|
| 可控性 | 阈值自动 + `/compact`；扩展可换摘要或给自定义 `firstKeptEntryId`（`dist/core/compaction/compaction.d.ts:18-21`；`types.d.ts:601,1137`） | 模型循环内用 `Compress` 工具自选区间 |
| 可寻址 | 模型无 ref | `mNNNNN` 稳定 + `bN` 块 id |
| 可逆 | 原文留 JSONL；`context_edit` 追加式移除/替换(`session-format.md:143,235`)，摘要丢失需重生成 | 先写归档再改 state(`compress.go:74-77`)；回放得**字节一致**摘要(`rebuild.go:37`) |
| 分层 | 单层；重复压缩从上次 kept 边界再摘要一遍(`compaction.md:83`) | tier 1→2→3，一次一层，终层重写被拒(`tier.go:22,78`) |
| 原子性 | 未见批次级全成功/全失败门 | 批次原子尺寸门，部分成功整体拒绝(`compress.go:221-225`) |

共性：二者均非破坏性、均有溢出反应式恢复、均做 tool_use↔tool_result 配对修复(`s.go:109`)。

## 4. Norma 有、myflow 用别的办法解决（供 ADV-* / V-OWNED）

- **注入存活(CMPT-05)**：目标达成路径不同；myflow 依赖 Pi 事件时序 → RISK（见 T3），有 `R-T`(`tests/extension.test.ts:244`)。
- **原文保留(CMPT-04)** / **溢出恢复(CMPT-03)**：myflow 直接用 Pi 的 JSONL 与恢复流程，不自建 → **宿主已覆盖**。

## 5. 自我声明（design.md §10）

- **全量逐行**：Norma `compaction/{compaction,summarizer}.go`、`noa/{refs,tier,state,boundaries,pipeline,recommend,rebuild,const,types,config}.go`、`noa/compress.go`（结构+尺寸门）；Pi 上述三篇文档。
- **只检索**：Pi `docs/` 其余 37 篇（§2 NEG 全局扫描，命中即止）；`dist/…/compaction.d.ts` 仅 `CompactionResult`/`CompactionPreparation` 段。
- **未读**：`noa/nudge*.go`、`turnintegrity.go`、`toolpairs.go`、`protected.go`、`truncate.go`（→S6）；`noaadapter/`、`transcript/`（→S5）；Norma `*_test.go` 不逐行读。
- **薄弱**：§2-D 仅文档面；noa 域为「关键文件全量+其余抽样」。
- **可疑 O-2 原文**：`extensions.md:77`「Add a model-callable operation | `pi.registerTool()`」、`:118`（`turn_end`/`agent_before_settle` 可链 `context_edit`/`compaction`）。表明「模型可调用压缩」落在 Pi 交扩展层，但**未明示**「压缩归扩展」→ NOA 行判 O-5，**不判 O-2**。
