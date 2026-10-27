# design.md — 横评判定方法、证据规则与交付骨架

> 本文件定义「怎么判定」，`implement.md` 定义「按什么顺序做」。
> 本任务只产出分析文档，不改任何实现代码。

---

## 1. 目的与产出

以 `../Norma`（Go SDK）为参照，对**三层结构**（L1 Norma / L2 Pi 运行时 / L3 myflow）做能力横评，
产出**可一一补足**的缺口标准文档，交付到 `../critic_doc/`。

判定目标不是「myflow 有没有 X」，而是四问：

1. **X 这个关注点归谁**（Pi core / 用户级扩展 / myflow / 外部 MCP / 无人）？
2. **若归 myflow，是靠什么强制的**（代码 / 门控 / 提示词）？
3. **myflow 假设了 Pi 的哪些行为**，这些行为有多可信？
4. **myflow 有哪些 Norma 没有的能力**，不能被回退？

---

## 2. 三层模型与「归属域」细分

### 2.1 三层

| 层 | 对象 | 归属 | 可改性 |
| --- | --- | --- | --- |
| L1 | Norma（`../Norma`） | 外部参照 | 只读参考 |
| L2 | Pi 运行时 **1.2.0** | Pi | **不可改**，只能依赖或规避 |
| L3 | myflow（本仓库 `.pi/` + `.myflow/`） | 用户自有 | 可改 |

### 2.2 归属域（Attribution Domain）——关键修正，不可省

「L2 = Pi」这个二分**不够用**。L2 内部还分两类，且其中一类会**冒充** myflow 或 Pi core 的能力：

| 域码 | 名称 | 实体位置 | 算「Pi 内建」？ |
| --- | --- | --- | --- |
| `A-PI` | Pi core | `~/.bun/install/global/node_modules/@earendil-works/*` | ✅ 是 |
| `A-EXT` | **用户级第三方扩展** | `~/.pi/agent/npm/node_modules/`、`~/.pi/agent/extensions/`、`~/.pi/agent/skills/` | ❌ **否**（但算用户环境已有，用户选项 U-3 已认可纳入对比） |
| `A-MF` | myflow | 本仓库 `.pi/`、`.myflow/` | ❌ 否（L3） |
| `A-MCP` | 外部 MCP server | `~/.pi/agent/mcp.json` 指向的服务 | ❌ 否 |
| `A-NONE` | 无人提供 | — | — |

> ⚠️ **单点误判风险**：工具列表里的 `Agent` / `StopAgent` / `MessageAgent` / `AgentStatus`
> **不是 Pi core**，也**不是 myflow**，而是 `A-EXT` 的 `pi-subagents-lite` 注册的；
> myflow 的 `myflow_subagent` 又是 `A-MF` 注册的。两者名字都像「子代理」。
> 不做域码区分，`CAP-SUB-*` 必错。

因此：**每一行的每个非空单元格都必须带域码**，例如 `A-PI` / `A-MF` / `A-EXT:pi-subagents-lite`。

**`A-EXT` 的分级规则**（新增，防过度乐观）：`A-EXT` 提供的能力一律**不得**记为 `V-PI`（非缺口），
只能记为 `V-EXT`（见 §5.2）。理由：用户级扩展可被卸载、可被运行时改坏，且它的存在不构成 myflow 的
设计保证。若某项 **仅** 由 `A-EXT` 提供且处于 myflow 核心流程上，须在 `RISK-*` 中登记。

---

## 3. 证据规则

### 3.1 证据等级

| 代号 | 名称 | 可用性 | 例 |
| --- | --- | --- | --- |
| `E0` | 运行时自证 | ✅ 最高 | `pi --version` → `1.2.0`；`ls ~/.pi/agent/...` |
| `E1` | 安装版权威文档 | ✅ | Pi 1.2.0 `docs/compaction.md:134` |
| `E2` | 安装包公开 API / 类型快照 | ✅ | `@earendil-works/*` 导出、`.pi/extensions/myflow/pi-coding-agent.d.ts` |
| `E3` | myflow 源码与测试（本仓库当前提交） | ✅ | `.pi/extensions/myflow/index.ts:237` |
| `E4` | Norma 源码 / README（`../Norma` 当前提交） | ✅ | `Norma/noa/tier.go:33` |
| `E5` | `Desktop/pi` 源码（**1.0.4**，落后于运行时） | ⚠️ **仅作推断** | 必须写成「推断（依据 1.0.4 源码 …）」 |
| `E6` | 模型记忆、印象、常识 | ❌ **禁止** | — |

**硬规则**

- `E5` **不得**作为任何缺口判定的唯一依据。
- `E1`/`E2` 的引用必须带**版本号 `1.2.0`**，否则视为无效证据。
- L1 断言引用 `E4`；L2 断言引用 `E0`/`E1`/`E2`；L3 断言引用 `E3`。

### 3.2 引用格式

```
<相对路径>:<行号>            // 代码/文档精确定位
<相对路径> §<小节标题>        // 大文件定位
<绝对路径>                   // 项目外（Pi 安装目录、~/.pi/）
```

禁止裸写「Pi 支持 X」「Norma 做了 Y」而不给路径。

### 3.3 负向断言规则（最高风险断言）

「Pi 没有 X」「myflow 没做 Y」是**最容易出错**的断言——上一轮开工时就犯过一次：
先前判定「`docs/compaction.md` 未描述压缩与扩展注入的交互」，实为**检索模式过窄导致的假阴性**
（实际 `:134`、`:138` 直接命中）。

因此负向断言必须写成结构化形式，且**不得单独**支撑判定：

```
(NEG) 语料=<扫描范围，须穷举文件类型与目录>
      检索式=<完整正则或关键词集合，多个用 |>
      命中=<0 或 命中文件:行>
      残余风险=<哪些表述方式可能骗过这个检索式>
```

并且 `NEG` 必须**再通过 §6 归属测试**，才能支撑 `O-1`（Pi 内建）或 `V-GAP`（真缺口）。

> 教训：检索「某概念是否存在」时，必须同时检索**该概念的正面枚举**与**相邻章节标题**，
> 不能只检索自己预期的措辞。

### 3.4 版本规则

- Pi 侧一律以 `1.2.0` 安装产物为准（`E0`/`E1`/`E2`）。
- `Desktop/pi` 为 `1.0.4`：仅可解释「为什么 1.2.0 行为如此」，结论一律降级为推断。
- 版本敏感条目须在矩阵中显式标注 `[v1.2.0]`。

### 3.5 禁止事项

- ❌ 以「我当前能用什么」推断 Pi core 能力（认知陷阱）。
- ❌ 把 `A-EXT` 的能力算作 `A-PI` 或 `A-MF`。
- ❌ 无路径的印象式判断。
- ❌ 把推断写成事实。

---

## 4. 强制层级（Enforcement Ladder）

### 4.1 强度轴

| 代号 | 名称 | 判据（如何证明） | 失效方式 |
| --- | --- | --- | --- |
| `E-C` | **代码强制** | 存在会**拒绝**的代码路径：`throw` / `return {block:true}` / 非零退出 / 显式上限 | 只有改代码才失效 |
| `E-G` | **门控 / 白名单** | 可达集合被限制：agent frontmatter `tools:`、config 开关、`ctx.tools`、事件 allowlist | Pi 行为或配置变化 |
| `E-P` | **提示词约定** | 仅存于 prompt / agent md / skill 文本，靠模型自律 | **模型不遵守即失效** |
| `E-N` | 无 | 无任何机制 | — |

排序：`E-C` > `E-G` > `E-P` > `E-N`。**必须标注施加强制者**：`E-G[Pi]` ≠ `E-G[myflow]`。
写 `E-C[myflow]` 时须给出代码位置与对应测试。

### 4.2 回归轴（与强度正交）

| 代号 | 含义 |
| --- | --- |
| `R-T` | 有测试锁定（测试回退即失败） |
| `R-∅` | 无回归保护 |

### 4.3 强度判定规则

- **R-STR-1**：Norma 为 `E-C` 而 myflow 为 `E-P`/`E-G` → 即使功能名相同，判 **`V-QUAL`**。
- **R-STR-2**：强度相同但 myflow `R-∅` 而 Norma 有测试 → 判 **`V-QUAL`（弱）**。
- **R-STR-3**：`E-P` 条目**一律不得**记为「已覆盖」。记 `V-QUAL`（若 Norma 有）或 `V-GAP`。

---

## 5. 判定规则

### 5.1 归属码

| 码 | 名称 | 必要条件 |
| --- | --- | --- |
| `O-1` | Pi 内建 | `A-PI` 且 `E1`/`E2` 正向命中 |
| `O-2` | Pi**刻意**外包 | `A-PI` 文档**明示**该关注点交给扩展层（须引用原文）。**无明示则不得使用本码** |
| `O-3` | Pi 部分提供 | 原语在 Pi，**语义**由 myflow 补齐 |
| `O-4` | Pi 契约依赖 | myflow 依赖 Pi 的**未文档化或易变**行为 |
| `O-5` | 双方皆无 | `A-PI` 与 `A-MF` 均无 |
| `O-6` | **用户级扩展提供** | `A-EXT` 命中，`A-PI` 未命中（新增，见 §2.2） |

`O-2` 的「明示」要求是防手滑设计：不能用「Pi 说它 minimal」推出「Pi 故意外包了 X」。

### 5.2 结论码

| 码 | 名称 | 条件 | 动作 |
| --- | --- | --- | --- |
| `V-GAP` | **真缺口** | Norma 有 ∧ Pi 无 ∧ myflow 无 | 写**补足标准**（`GAP-*`） |
| `V-QUAL` | **质量差** | Norma 有 ∧ Pi 无 ∧ myflow 有，但强度/回归更弱 | 写**提升标准**（`QGAP-*`） |
| `V-OWNED` | 已承担 | Norma 有 ∧ Pi 无 ∧ myflow 有，强度 ≥ Norma | 记录，无动作 |
| `V-PI` | 非缺口 | `A-PI` 内建（`O-1`/`O-2`） | 记录；**检查 myflow 是否重复造轮子** |
| `V-EXT` | 扩展已给 | 仅 `A-EXT` 提供（`O-6`） | 记录 + 检核心流程依赖 → 可能触发 `RISK-*` |
| `V-UP` | 运行时约束 | 只能改 Pi 才能补 | 登记 `UP-*`，**不列为缺口** |
| `V-NA` | 场景无关 | 有价值低 / 与定位冲突 | 记录理由，不补 |
| `V-ADV` | **相对优势** | myflow 有 ∧ Norma 无 | 标**不可回退**（`ADV-*`） |

### 5.3 契约风险码

| 码 | 名称 | 条件 |
| --- | --- | --- |
| `R-HARD` | 硬依赖 | 未文档化 / 易变 **且** 失效后果严重（静默丢状态、任务指针错乱） |
| `R-SOFT` | 软依赖 | 有文档背书，或失效后果可观测、可恢复 |
| `R-OK` | 已自愈 | myflow 已有自身补偿路径（须给代码位置） |

---

## 6. 误判防呆三测

### 测 A — 卸载测试（归属域定位）

> 假想删除全部 `A-MF` 与 `A-EXT` 资产（`.pi/extensions/myflow/`、`.pi/agents/`、`.pi/prompts/`、
> `.pi/skills/`、`.myflow/`、`~/.pi/agent/npm/node_modules/`、`~/.pi/agent/extensions/`、
> `~/.pi/agent/skills/`），仅保留 Pi core 安装目录。该能力是否仍在？

- 仍在 → `A-PI`（`O-1`）
- 不在 → 逐层加回：只在 `A-EXT` 恢复时出现 → `A-EXT`（`O-6`）；只在 `A-MF` 恢复时出现 → `A-MF`

**测 A 的关键**：不能只做「Pi vs myflow」两分，否则 `pi-subagents-lite` 这类用户级扩展会被误记为 Pi 能力。

### 测 B — 归属方向测试（正向）

在 Pi core 安装目录 `docs/` 与各包 API 中以**能力名词 + 其同义表述**检索：

- 命中「Pi 提供」语义 → 倾向 `O-1`
- 命中「交给扩展 / 由你构建」语义 → `O-2`
- 无命中 → 转测 A，并以 `NEG` 记录检索式

### 测 C — 自证 vs 推断

凡结论唯一依据来自 `Desktop/pi`（1.0.4）或任何源码工作区 → 标 `E5` **推断**，
并在矩阵中降级显示，不得进入正式缺口条目。

---

## 7. 能力项分解与 ID 体系

### 7.1 ID 命名

| 类别 | 格式 | 例 |
| --- | --- | --- |
| 能力项 | `CAP-<域>-<nn>` | `CAP-NOA-03` |
| 真缺口 | `GAP-<域>-<nn>` | `GAP-NOA-03` |
| 质量差 | `QGAP-<域>-<nn>` | `QGAP-SUB-01` |
| 契约风险 | `RISK-<nn>` | `RISK-03` |
| 相对优势 | `ADV-<nn>` | `ADV-02` |
| 非缺口 | `NG-<nn>` | `NG-04` |
| 运行时约束 | `UP-<nn>` | `UP-01` |

域码：`LLM TOOL PERM LOOP SUB COORD CMPT NOA NOAA TRANS CORE HOOK MCP SKILL PLAN MEM CTX OBS TEST`

### 7.2 能力项清单（骨架，覆盖 Norma 全部 16 个实现包）

| 域 | 能力项 | 来源（Norma 目录） |
| --- | --- | --- |
| `LLM` | 01 多协议归一（Anthropic+OpenAI）· 02 流式增量归一 · 03 provider 无关消息模型 · 04 重试/限流/SSE 容错 | `llm` |
| `TOOL` | 01 注册表 · 02 参数 schema 校验 · 03 fail-closed 默认 · 04 延迟工具 · 05 核心工具集 · 06 工具输出上限与截断 | `tool`、`harness`（capoutput） |
| `PERM` | 01 allow/deny/ask 三态 · 02 mode 系统（6 种）· 03 deny 优先 · 04 四阶段 `Evaluate` · 05 执行中途切换模式 | `permission` |
| `LOOP` | 01 循环迭代协议（`iter.Seq2`）· 02 只读并行/写串行 · 03 tool_use↔tool_result 配对 · 04 终止原因建模 · 05 取消传播 · 06 结算与超时 | `harness` |
| `SUB` | 01 复用主循环 · 02 递归深度守卫 · 03 结果回传 | `subagent` |
| `COORD` | 01 LLM 驱动 Agent 工具 · 02 编程式 `RunParallel` 扇出 | `coordinator` |
| `CMPT` | 01 多级压缩策略 · 02 熔断 · 03 prompt-too-long 反应式恢复 · 04 非破坏性 boundary · 05 压缩与注入共存语义 | `compaction` |
| `NOA` | 01 ref 寻址（`m00001`）· 02 tier 分层压缩（一次一层）· 03 block 与 rebuild · 04 nudge 节律 · 05 turn 完整性（reasoning+act+result 不可拆）· 06 tool pair 完整性 · 07 硬保护 vs 软保护 · 08 紧急截断标记 · 09 压缩建议与死区（`ViableRangeMinTokens`）· 10 归档与 state 持久化 · 11 常驻提示词（system 段） | `noa` |
| `NOAA` | 01 接管 `ContextView`/`Compactor` · 02 内容哈希身份（非下标）· 03 子代理状态继承与边界 · 04 溢出学习窗口 · 05 `materialize` 无状态降级 · 06 工具输出压缩 · 07 ref tag 渲染与剥离 | `noaadapter` |
| `TRANS` | 01 append-only JSONL · 02 冷启动重建压缩后视图 · 03 子代理 sidechain 分离 · 04 边界与工作集持久化语义 | `transcript` |
| `CORE` | 01 `Session` 抽象 · 02 一次性 `Run` · 03 转录与恢复 · 04 `Resume` | `agentcore` |
| `HOOK` | 01 生命周期回调集合（8 个）· 02 可 block · 03 可改写/注入 · 04 Stop 门控 | `hook` |
| `MCP` | 01 stdio JSON-RPC 客户端 · 02 进程内 server · 03 工具暴露与命名 | `mcp` |
| `SKILL` | 01 `SKILL.md` + frontmatter · 02 按需注入 · 03 **存活于压缩** · 04 解锁 skill 声明的 MCP 工具 | `skill` |
| `PLAN` | 01 只读探索阶段 · 02 `ExitPlanMode` · 03 中途权限翻转 | `plan` |
| `MEM` | 01 frontmatter markdown 存储 · 02 `MEMORY.md` 索引 · 03 相关度选择 · 04 陈旧告警 | `memory` |
| `CTX` | 01 状态注入的持久与恢复 · 02 会话身份 ↔ 任务指针绑定 · 03 注入预算与降级 | 跨切面 |
| `OBS` | 01 状态可观测（`/myflow-status`）· 02 子代理日志与可追溯 | 跨切面 |
| `TEST` | 01 自查 / 门禁（verify gate）· 02 harness 自身回归 | 跨切面 |

> `CTX`/`OBS`/`TEST` 不对应单个 Norma 目录，但本档（第 3 档维度）要求覆盖，故单列。
> `noa`/`noaadapter`/`transcript` 是 README 未列出的三个目录（见 PRD「语料修正」），
> 研究阶段可增删条目，但须保持「16 个实现包全覆盖」这一 AC。

---

## 8. 交付骨架（横评语境重排）

### 8.1 交付物清单 —— 落点 `C:/Users/wocai/Desktop/critic_doc/`

| 文件 | 内容 | 承载 AC |
| --- | --- | --- |
| `README.md` | 索引：这份横评是什么、阅读路径、一页速览、如何消费缺口条目、来源提交号 | 可被后续任务直接消费 |
| `01-verdict.md` | 结论：记分卡（各域 ± 与一句话判词）+ 十条最重要结论 + 「必补 / 不补」清单 | 结论可信、可执行 |
| `02-matrix.md` | 表 A 归属 / 表 B 承担度与强度 / 表 C 统计 | 覆盖 16 包、每格带证据 |
| `03-gap-register.md` | `GAP-*` 真缺口 + `QGAP-*` 质量差，**一一补足标准（核心）** | 缺口条目 8 个必备字段 |
| `04-risk-register.md` | `RISK-*` Pi 契约风险 | 契约风险 ≥3 项 |
| `05-advantage-register.md` | `ADV-*` 相对优势与不可回退项 | 优势 ≥3 项 |
| `06-non-gaps.md` | `NG-*` 看似缺口实际不是 + `UP-*` 运行时约束 | ≥3 项非缺口 |
| `07-method.md` | 判定方法自包含版（§2–§6 的对外可读版） | 可复核 |
| `08-coverage.md` | 取证边界、全量 vs 抽样、`NEG` 清单、推断清单、可沉淀清单 | 区分已核实/推断 |
| `evidence/*.md` | 任务目录 `research/` 的**快照副本** + 来源提交号 | 可回溯 |

**两段落盘**：上表 9 份先由 `myflow-implement` 写入
`.myflow/tasks/<task>/deliverables/`（仓库内、受版本控制、写者唯一），
再由**主会话**在 §13 发布到 `../critic_doc/`。`myflow-implement` / `myflow-check`
**不得**直接写 `../critic_doc/`。

**为什么重排**（用户决定 U-4）：原「7 个平铺文件」是**生产视角**（研究产物直接当交付），
横评语境需要**读者视角**：先给结论与判词（`01-verdict.md`），再给支撑矩阵，再给可执行清单，
方法与会话级取证边界后置。`07-method.md` 是为了让 `critic_doc` 脱离任务目录后**仍可独立阅读**。

### 8.2 表 A — 能力归属矩阵

| # | 能力项 | Norma 机制 | Norma 证据 | Pi 1.2.0 现状 | Pi 证据 `[v1.2.0]` | 归属域 | 归属码 |
| --- | --- | --- | --- | --- | --- | --- | --- |

### 8.3 表 B — myflow 承担度与强度

| # | 能力项 | myflow 现状 | myflow 证据 | 强制层级 | 回归 | 与 Norma 强度差 | 结论码 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

### 8.4 `GAP-*` / `QGAP-*` 条目模板（「一一补足」的标准格式）

```markdown
### GAP-<域>-<nn> <能力名>

- **能力描述**：<一句话，可验收的行为>
- **Norma 机制与证据**：`Norma/<path>:<line>` — <机制摘要>
- **Pi 现状（为什么 Pi 不给）**：<`O-*` 码> + 证据；若为 `O-2` 须引 Pi 原文
- **myflow 现状**：<`E-*`/`R-*`> + `证据:行`
- **缺口判定**：`V-GAP`（Norma 有 ∧ Pi 无 ∧ myflow 无）
- **补足标准**（逐条可验收）：
  1. 目标**强制层级**：`E-C[myflow]`（不接受 `E-P`）
  2. 目标**回归护栏**：`R-T`，测试用例 <名/路径>
  3. 行为规格：Given <前置> When <动作> Then <可观测结果>
  4. 不作弊条件：<怎样算「名义完成」，明确排除>
- **依赖与代价**：<是否需新依赖 / 是否触碰 Pi 契约 / 预估规模>
- **优先级**：`P0 | P1 | P2` + 依据（§9）
- **证据等级**：`E0..E4`（含 `E5` 则本条目不得进正式缺口）
```

`QGAP-*` 同模板，但「缺口判定」改为 `V-QUAL`，并**必须**附差距实证一行：`Norma:<E-码> vs myflow:<E-码>`。

### 8.5 `RISK-*` 条目模板

```markdown
### RISK-<nn> <风险名>

- **myflow 的假设**：<一句话>
- **依赖的 Pi 行为**：<行为描述>
- **证据与强度**：`<E-码>` + 路径；文档化程度（明示 / 隐含 / 未文档化）
- **失效后果**：<可观测症状；是否静默>
- **现有补偿**：<myflow 自己做了什么；给代码位置；没有则写「无」>
- **风险码**：`R-HARD | R-SOFT | R-OK`
- **钉住手段**（至少 1 条）：断言测试 / 启动期校验 / 防御性自愈 / 运行时登记
```

### 8.6 `ADV-*` 条目模板

```markdown
### ADV-<nn> <优势名>

- **myflow 机制**：<描述> + `证据:行`
- **强制层级**：`E-*[谁]` + 回归 `R-*`
- **Norma 对照**：<为何 Norma 没有；是设计取舍还是缺失>
- **不可回退理由**：<回退会破坏什么既得行为>
- **回退护栏**：<哪个测试/文档防止被后人删掉>
```

### 8.7 表 C — 判定统计

按 `V-*` 与 `O-*` 两维交叉计数，并给出：真缺口数、质量差数、非缺口数、运行时约束数、优势数、硬风险数。

---

## 9. 优先级评分法

不引入数值打分，用**规则判定**，避免伪精确：

| 级别 | 条件（满足任一） |
| --- | --- |
| `P0` 必补 | `V-GAP` ∧ （状态/数据丢失风险 ∨ 已有用户可见故障 ∨ 补足仅需 myflow 侧改动且代价小） |
| `P0-R` 风险钉住 | `R-HARD`（与是否缺口无关，独立成列） |
| `P1` 应补 | `V-GAP` 代价中等；或 `V-QUAL` 且位于**核心流程**（状态注入、任务生命周期、子代理调度） |
| `P2` 可补 | `V-GAP` 代价高；或 `V-QUAL` 边缘；或 `V-ADV` 增强类 |
| 不补 | `V-PI` / `V-EXT` / `V-UP` / `V-NA` |

「代价」三维度：**是否需新依赖**、**是否触碰 Pi 契约**（触碰则升一级代价）、**预估规模**（小/中/大）。

---

## 10. 自我审计与取证边界

`08-coverage.md` 必须回答：

1. **全量 vs 抽样**：哪些能力项是逐行读源得出的（全量），哪些是检索命中即止（抽样）。
2. **未读清单**：Norma 未审计的目录（`examples/`、`cmd/`）及其理由。
3. **NEG 清单**：所有负向断言及其检索式，集中列出以便复核。
4. **推断清单**：所有 `E5` 条目，单独列出，声明为未验证。
5. **可沉淀清单**：值得进 `.myflow/spec/` 的稳定契约候选（本任务不写 spec，见 ADR-4）。
6. **已知薄弱点**：无法验证 Pi 未来版本行为；`noa` 域为抽样而非逐行。

**诚实性要求**：宁可写「未审计」，不得写「已确认无」。

---

## 11. 决策记录（ADR-lite）

### ADR-1 判定维度取第 3 档

- **Decision**：功能清单 + 强制层级 + Pi 契约风险 + 相对优势保护。
- **Consequences**：产出体积增大；但两个已取证反例（提示词守卫、`PI_SESSION_ID` 派生）
  在档 1/2 下会漏判或降级，故 3 是唯一能避免假阴性的档位。

### ADR-2 归属域从 2 类细化为 5 类

- **Decision**：加入 `A-EXT`（用户级第三方扩展）、`A-MCP`，并要求每格标注域。
- **Consequences**：`Agent`/`StopAgent`/`MessageAgent`/`AgentStatus` 不再被误记为 Pi 或 myflow 能力。
- **补充（本回合）**：`A-EXT` 的能力**不得**记为 `V-PI`，只记 `V-EXT`（§2.2），
  避免「用户装了扩展」被当成「myflow 不缺」。

### ADR-3 `research/*.md` 的落盘主体

- **修正后的定性**：`myflow-research` 现持有 `write` 并声明 `writesUnder: research`，
  守卫为**路径级**（仅拒绝「可写且未声明安全范围」的 agent），故 11 个分片可**并行**各自落盘。
- **Consequences**：写入范围契约见 `.myflow/spec/harness/index.md`。

### ADR-4 本任务不写 `.myflow/spec/`

- **Context**：PRD DoD 要求工作树干净；workflow Step 3.1 又是 `[required]` 的 `myflow-update-spec`。
- **Decision**：只写任务目录 + `../critic_doc/`。`08-coverage.md` 附「可沉淀清单」；
  Step 3.1 显式记录「本任务无新增契约」（本次无代码改动，故无新契约可沉淀）。

### ADR-5 结论码用规则判定而非数值打分

- **Decision**：§9 的规则判定。**Consequences**：无伪精确；不同评审者可复现同一结论。

### ADR-6（新）交付落点分离：研究在仓库内，成品在 `../critic_doc/`

- **Context**：用户决定 U-2 = 方案 a。`../critic_doc/` 在仓库外、不受版本控制，
  而 `myflow-research` 的写范围被代码限制在 `<active task>/research/`。
- **Decision**：三段分工 —— 分片落 `.myflow/tasks/<task>/research/`（可追溯、受写范围约束、可提交）；
  9 份成品由 `myflow-implement` 落 `.myflow/tasks/<task>/deliverables/`（写者唯一、串行 4 批）；
  **主会话**执行 §13 发布，把 `deliverables/` 与 `research/` 快照复制到 `../critic_doc/` 并写来源提交号。
- **Consequences**：
  - 好处：分片有 git 历史；外部目录只收成品；主会话是唯一外部写者，无越界风险。
  - 代价：`../critic_doc/` 的内容**不被版本控制**，若被删只能从 `research/` 重生成 → `00` 步骤记录来源提交号。
  - 约束：`myflow-implement` / `myflow-check` **不得**写 `../critic_doc/`
    （其写范围未声明，技术上可写，但本任务明确禁止，避免两个写者）。

### ADR-7（新）语料从 13 包扩到 16 包

- **Context**：README「Packages」表漏掉 `noa/`（5392 行）、`noaadapter/`（1918 行）、`transcript/`（268 行），
  合计约占全仓非测试代码 20%，而 `noa` 恰是 myflow 最该对照的 `CTX` 域。
- **Decision**：纳入三者，新增 `NOA` / `NOAA` / `TRANS` 三个域；AC 改为「16 个实现包全覆盖」。
- **Consequences**：分片从 6+3 增到 8+3；`noa` 域条目最多（11 项），单列一片以防超时。
  好处是避免一次「最该做的对比被系统性跳过」的漏判。

---

## 12. 与后续任务的衔接

本任务的产物是「补足标准」。后续实现任务应能**直接复制** `03-gap-register.md` 中单个 `GAP-*` 条目
作为自己的 PRD 主体（字段已对齐：能力描述 → PRD Goal；补足标准 → PRD Requirements +
Acceptance Criteria；依赖与代价 → PRD Technical Notes；优先级 → 排期）。

因此不建议把多个 `GAP-*` 合并成一个大任务；条目已是**可独立验收**的最小单元。
本任务是**父级**分析任务：它不创建子任务（缺口未知），缺口创建在 P4 评审通过后进行。

---

## 13. 发布步骤（主会话专属）

1. `mkdir -p ../critic_doc/evidence`
2. `cp .myflow/tasks/<task>/deliverables/*.md ../critic_doc/`（9 份，主会话执行）
3. `cp .myflow/tasks/<task>/research/*.md ../critic_doc/evidence/`
4. 在 `README.md` 与 `08-coverage.md` 顶部写入来源提交号：
   `myflow@$(git rev-parse --short HEAD)`、`Norma@$(git -C ../Norma rev-parse --short HEAD)`、
   `pi 1.2.0`、交付时间戳
5. 自检：`ls ../critic_doc/` 与 §8.1 清单逐项对齐；`grep -c '^### ' 03-gap-register.md` 与表 C 统计一致
