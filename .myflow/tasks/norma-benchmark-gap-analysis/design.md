# design.md — 横评判定方法、证据规则与文档骨架

> 本文件定义「怎么判定」，`implement.md` 定义「按什么顺序做」。
> 本任务只产出分析文档，不改任何实现代码。

---

## 1. 目的与产出

以 `../Norma`（Go SDK）为参照，对 **三层结构**（L1 Norma / L2 Pi 运行时 / L3 myflow）做能力横评，
产出**可一一补足**的缺口标准文档。

判定目标不是「myflow 有没有 X」，而是四问：

1. **X 这个关注点归谁**（Pi core / 用户级扩展 / myflow / 外部 MCP / 无人）？
2. **若归 myflow，是靠什么强制的**（代码 / 门控 / 提示词）？
3. **myflow 假设了 Pi 的哪些行为**，这些行为有多可信？
4. **myflow 有哪些 Norma 没有的能力**，不能被回退？

---

## 2. 三层模型与「归属域」细分

### 2.1 三层（来自 PRD Q1，已定）

| 层 | 对象 | 归属 | 可改性 |
| --- | --- | --- | --- |
| L1 | Norma（`../Norma`，Go 1.23+） | 外部参照 | 只读参考 |
| L2 | Pi 运行时 **1.2.0** | 上游宿主 | **不可改**，只能依赖或规避 |
| L3 | myflow（本仓库 `.pi/` + `.myflow/`） | 用户自有 | 可改 |

### 2.2 归属域（Attribution Domain）——对本任务的关键修正

「L2 = Pi」这个二分**不够用**。本机实测发现 L2 内部还分两类，
且其中一类会**冒充** myflow 或 Pi core 的能力：

| 域码 | 名称 | 实体位置 | 是否算「宿主内建」 |
| --- | --- | --- | --- |
| `A-PI` | Pi core | `~/.bun/install/global/node_modules/@earendil-works/*` | ✅ 是 |
| `A-EXT` | **用户级第三方扩展** | `~/.pi/agent/npm/node_modules/`、`~/.pi/agent/extensions/`、`~/.pi/agent/skills/` | ❌ **否** |
| `A-MF` | myflow | 本仓库 `.pi/`、`.myflow/` | ❌ 否（L3） |
| `A-MCP` | 外部 MCP server | `~/.pi/agent/mcp.json` 指向的服务 | ❌ 否 |
| `A-NONE` | 无人提供 | — | — |

**实测到的 `A-EXT` 清单（Phase 0 须重新核对，此处为起草时快照）**：

- 包：`pi-subagents-lite`、`pi-rounded-tools`、`pi-agent-loop`、`pi-ask-side`、`pi-mcp-adapter`、
  `pi-open-tui`、`pi-tui-commands`、`@firstpick/pi-themes-bundle`、`@upstash/context7-pi`、
  `@typesafe-ai/sdk`、`@vectorize-io/*`、`@modelcontextprotocol/*`
- 扩展文件：`~/.pi/agent/extensions/cbmem.ts`（codebase-memory）、`~/.pi/agent/extensions/rtk.ts`
- 技能：`~/.pi/agent/skills/codebase-memory`、`agent-browser`（symlink）、`find-skills`（symlink）

> ⚠️ **本任务最大的单点误判风险**：工具列表里的 `Agent` / `StopAgent` / `MessageAgent` /
> `AgentStatus` **不是 Pi core**，也**不是 myflow**，而是 `A-EXT` 的 `pi-subagents-lite` 注册的；
> 而 myflow 的 `myflow_subagent` 又是 `A-MF` 注册的。两者名字都像「子代理」。
> 若不做归属域区分，「子代理」这一能力项会被记到错误的层上，直接污染 `CAP-SUB-*` 的判定。

因此：**每一行的每个非空单元格都必须带域码**，例如 `A-PI` / `A-MF` / `A-EXT:pi-subagents-lite`。

---

## 3. 证据规则

### 3.1 证据等级

| 代号 | 名称 | 可用性 | 例 |
| --- | --- | --- | --- |
| `E0` | 运行时自证 | ✅ 最高 | `pi --version` → `1.2.0`；`PI_SESSION_ID` 实测；`ls ~/.pi/agent/...` |
| `E1` | 安装版权威文档 | ✅ | Pi 1.2.0 `docs/compaction.md:134` |
| `E2` | 安装包公开 API / 类型快照 | ✅ | `@earendil-works/*` 的导出、本仓库 `.pi/extensions/myflow/pi-coding-agent.d.ts` |
| `E3` | myflow 源码与测试（本仓库当前提交） | ✅ | `.pi/extensions/myflow/index.ts:237` |
| `E4` | Norma 源码 / README | ✅ | `Norma/README.md`「Packages」表 |
| `E5` | `Desktop/pi` 源码（**1.0.4**，落后于运行时） | ⚠️ **仅作推断** | 必须写成「推断（依据 1.0.4 源码 …）」 |
| `E6` | 模型记忆、印象、常识 | ❌ **禁止** | — |

**硬规则**
- `E5` **不得**作为任何缺口判定的唯一依据。
- `E1`/`E2` 的引用必须带**版本号 `1.2.0`**，否则视为无效证据。
- L3 断言引用 `E3`；L1 断言引用 `E4`。

### 3.2 引用格式

```
<相对路径>:<行号>            // 代码/文档精确定位
<相对路径> §<小节标题>        // 大文件定位
<绝对路径>                   // 项目外（Pi 安装目录、~/.pi/）
```

禁止裸写「Pi 支持 X」「Norma 做了 Y」而不给路径。

### 3.3 负向断言规则（最高风险断言）

「Pi 没有 X」「myflow 没做 Y」是**最容易出错**的断言——本任务开工时就已经犯过一次：
先前判定「`docs/compaction.md` 未描述压缩与扩展注入的交互」，实为**检索模式过窄导致的假阴性**
（实际 `:134`、`:138` 直接命中，见 PRD「原取证空洞已关闭」）。

因此负向断言必须写成结构化形式，且**不得单独**支撑判定：

```
(NEG) 语料=<扫描范围，须穷举文件类型与目录>
      检索式=<完整正则或关键词集合，多个用 |>
      命中=<0 或 命中文件:行>
      残余风险=<哪些表述方式可能骗过这个检索式>
```

并且：`NEG` 必须**再通过 §6 的归属测试**，才能支撑 `O-1`(宿主内建) 或 `V-GAP`(真缺口)。

> 反面教材就是本次：只用 `inject|extension|custom_message|appendEntry|system.*message`，
> 漏掉了 `Cut Point Rules` 一节对 `custom_message` 的**正面列举**。
> 教训：检索「某概念是否存在」时，必须同时检索**该概念的正面枚举**与**相邻章节标题**，
> 不能只检索自己预期的措辞。

### 3.4 版本规则

- Pi 侧一律以 `1.2.0` 安装产物为准（`E0`/`E1`/`E2`）。
- `Desktop/pi` 为 `1.0.4`：仅可解释「为什么 1.2.0 行为如此」，结论一律降级为推断。
- 版本敏感条目须在矩阵中显式标注 `[v1.2.0]`。

### 3.5 禁止事项

- ❌ 以「我当前能用什么」推断 Pi core 能力（认知陷阱，见 PRD）。
- ❌ 把 `A-EXT` 的能力算作 `A-PI` 或 `A-MF`。
- ❌ 无路径的印象式判断。
- ❌ 把推断写成事实（`E5`/未验证内容）。

---

## 4. 强制层级（Enforcement Ladder）

### 4.1 强度轴

| 代号 | 名称 | 判据（如何证明） | 失效方式 |
| --- | --- | --- | --- |
| `E-C` | **代码强制** | 存在会**拒绝**的代码路径：`throw` / `return {block:true}` / 非零退出 / 显式上限 | 只有改代码才失效 |
| `E-G` | **门控 / 白名单** | 可达集合被限制：agent frontmatter `tools:`、config 开关、`ctx.tools`、事件 allowlist | 宿主行为或配置变化 |
| `E-P` | **提示词约定** | 仅存于 prompt / agent md / skill 文本，靠模型自律 | **模型不遵守即失效** |
| `E-N` | 无 | 无任何机制 | — |

排序：`E-C` > `E-G` > `E-P` > `E-N`。

**必须标注施加强制者**：`E-G[Pi]`（宿主门控）≠ `E-G[myflow]`（myflow 自己过滤）。
写 `E-C[myflow]` 时须给出代码位置与对应测试。

### 4.2 回归轴（与强度正交）

| 代号 | 含义 |
| --- | --- |
| `R-T` | 有测试锁定（测试回退即失败） |
| `R-∅` | 无回归保护 |

### 4.3 强度判定规则

- **R-STR-1**：Norma 为 `E-C` 而 myflow 为 `E-P`/`E-G` → 即使功能名相同，判 **`V-QUAL` 质量差**。
- **R-STR-2**：强度相同但 myflow `R-∅` 而 Norma 有测试 → 判 **`V-QUAL`（弱）**。
- **R-STR-3**：`E-P` 条目**一律不得**记为「已覆盖」。它记 `V-QUAL`（若 Norma 有）
  或 `V-GAP`（若 Norma 也无，则说明这是 nobody-owns 的关注点，另判）。

> 已取证示例（PRD）：`myflow-research` 的递归守卫 = `E-P`（`.pi/agents/myflow-research.md` 的
> "Do NOT spawn another …" 文字）+ `E-G[myflow]`（`tools:` 白名单）；而 Norma `subagent` 是 `E-C`
> 代码深度守卫。纯功能清单会把两者都记成「有」——这正是本档要治的假阴性。

---

## 5. 判定规则

### 5.1 归属码

| 码 | 名称 | 必要条件 |
| --- | --- | --- |
| `O-1` | 宿主内建 | `A-PI` 且 `E1`/`E2` 正向命中 |
| `O-2` | 宿主**刻意**外包 | `A-PI` 文档**明示**该关注点交给扩展层（须引用原文）。**无明示则不得使用本码** |
| `O-3` | 宿主部分提供 | 原语在 Pi，**语义**由 myflow 补齐（如 compaction 内建，但「注入在压缩后仍存在」由 myflow 补） |
| `O-4` | 宿主契约依赖 | myflow 依赖 Pi 的**未文档化或易变**行为 |
| `O-5` | 双方皆无 | `A-PI` 与 `A-MF` 均无 |

`O-2` 的「明示」要求是防手滑设计：不能用「Pi 说它 minimal」推出「Pi 故意外包了 X」。

### 5.2 结论码

| 码 | 名称 | 条件 | 动作 |
| --- | --- | --- | --- |
| `V-GAP` | **真缺口** | Norma 有 ∧ Pi 无 ∧ myflow 无 | 写**补足标准**（`GAP-*`） |
| `V-QUAL` | **质量差** | Norma 有 ∧ Pi 无 ∧ myflow 有，但强度/回归更弱 | 写**提升标准**（`QGAP-*`） |
| `V-OWNED` | 已承担 | Norma 有 ∧ Pi 无 ∧ myflow 有，强度 ≥ Norma | 记录，无动作 |
| `V-PI` | 非缺口 | Pi core 内建（`O-1`） | 记录；**检查 myflow 是否重复造轮子** |
| `V-UP` | 上游约束 | 只能改 Pi 才能补 | 登记上游依赖（`UP-*`），**不列为缺口** |
| `V-NA` | 场景无关 | 有但价值低 / 与「不追求零依赖」定位冲突 | 记录理由，不补 |
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

> 假想删除全部 `A-MF` 与 `A-EXT`：
> `.pi/extensions/myflow/`、`.pi/agents/`、`.pi/prompts/`、`.pi/skills/`、`.myflow/`、
> `~/.pi/agent/npm/node_modules/`、`~/.pi/agent/extensions/`、`~/.pi/agent/skills/`，
> 仅保留 Pi core 安装目录。该能力是否仍在？

- 仍在 → `A-PI`（`O-1`）
- 不在 → 再逐层加回：只在 `A-EXT` 恢复时出现 → `A-EXT`；只在 `A-MF` 恢复时出现 → `A-MF`

**测 A 的关键**：不能只做「Pi vs myflow」两分，否则 `pi-subagents-lite` 这类用户级扩展会被误记为宿主能力。

### 测 B — 归属方向测试（正向）

在 Pi core 安装目录 `docs/` 与各包 API 中以**能力名词 + 其同义表述**检索：

- 命中「Pi 提供」语义 → 倾向 `O-1`
- 命中「交给扩展 / 由你构建」语义 → `O-2`
- 无命中 → 转测 A，并以 `NEG` 记录检索式

### 测 C — 自证 vs 推断

凡结论唯一依据来自 `Desktop/pi`（1.0.4）或任何源码工作区 → 标 `E5` **推断**，
并在矩阵中降级显示，不得进入 `gaps.md` 的正式条目。

---

## 7. 能力项分解与 ID 体系

### 7.1 ID 命名

| 类别 | 格式 | 例 |
| --- | --- | --- |
| 能力项 | `CAP-<域>-<nn>` | `CAP-MEM-01` |
| 真缺口 | `GAP-<域>-<nn>` | `GAP-MEM-01` |
| 质量差 | `QGAP-<域>-<nn>` | `QGAP-SUB-01` |
| 契约风险 | `RISK-<nn>` | `RISK-03` |
| 相对优势 | `ADV-<nn>` | `ADV-02` |
| 非缺口 | `NG-<nn>` | `NG-04` |
| 上游约束 | `UP-<nn>` | `UP-01` |

域码：`LLM TOOL PERM LOOP SUB COORD CMPT CORE HOOK MCP SKILL PLAN MEM CTX OBS TEST`

### 7.2 能力项清单（骨架，覆盖 Norma 全部 13 包）

| 域 | 能力项 | 来源（Norma 包） |
| --- | --- | --- |
| `LLM` | 01 多协议归一（Anthropic+OpenAI）· 02 流式增量归一 · 03 provider 无关消息模型 | `llm` |
| `TOOL` | 01 注册表 · 02 参数 schema 校验 · 03 fail-closed 默认 · 04 延迟工具加载 · 05 核心工具集 | `tool` |
| `PERM` | 01 allow/deny/ask 三态 · 02 mode 系统（6 种）· 03 deny 优先 · 04 四阶段 Evaluate · 05 执行中途切换模式 | `permission` |
| `LOOP` | 01 循环迭代协议（`iter.Seq2`）· 02 只读并行/写串行 · 03 tool_use↔tool_result 配对 · 04 终止原因建模 · 05 取消传播 | `harness` |
| `SUB` | 01 复用主循环 · 02 递归深度守卫 · 03 结果回传 | `subagent` |
| `COORD` | 01 LLM 驱动 Agent 工具 · 02 编程式 `RunParallel` 扇出 | `coordinator` |
| `CMPT` | 01 多级压缩策略 · 02 熔断 · 03 prompt-too-long 反应式恢复 · 04 非破坏性 boundary · 05 压缩与注入共存语义 | `compaction` |
| `CORE` | 01 `Session` 抽象 · 02 一次性 `Run` · 03 JSONL 转录 · 04 `Resume` | `agentcore` |
| `HOOK` | 01 生命周期回调集合（8 个）· 02 可 block · 03 可改写/注入 · 04 Stop 门控 | `hook` |
| `MCP` | 01 stdio JSON-RPC 客户端 · 02 进程内 server · 03 工具暴露与命名 | `mcp` |
| `SKILL` | 01 `SKILL.md`+frontmatter · 02 按需注入 · 03 **存活于压缩** · 04 解锁 skill 声明的 MCP 工具 | `skill` |
| `PLAN` | 01 只读探索阶段 · 02 `ExitPlanMode` · 03 中途权限翻转 | `plan` |
| `MEM` | 01 frontmatter markdown 存储 · 02 `MEMORY.md` 索引 · 03 相关度选择 · 04 陈旧告警 | `memory` |
| `CTX` | 01 状态注入的持久与恢复 · 02 会话身份 ↔ 任务指针绑定 | （跨切面，非单一 Norma 包） |
| `OBS` | 01 状态可观测（`/myflow-status`） | （跨切面） |
| `TEST` | 01 自查 / 门禁（verify gate） | （跨切面） |

> `CTX`/`OBS`/`TEST` 不对应单个 Norma 包，但本档（第 3 档）要求覆盖，故单列。
> 研究阶段可增删条目，但须保持「13 包全覆盖」这一 AC。

---

## 8. 文档骨架与条目 Schema

### 8.1 交付物清单

| 文件 | 内容 | 关键 AC 承载 |
| --- | --- | --- |
| `index.md` | 结论摘要 + 如何消费缺口条目 + 一页速览 | 可被后续任务直接消费 |
| `matrix.md` | 表 A 归属 / 表 B 强度 / 表 C 统计 | 覆盖 13 包、每格带证据 |
| `gaps.md` | `GAP-*` 真缺口 + `QGAP-*` 质量差 | **一一补足标准（核心）** |
| `risks-and-advantages.md` | `RISK-*` + `ADV-*` | 契约风险 ≥3 项、优势 ≥3 项 |
| `non-gaps.md` | `NG-*` + `UP-*` | 「看似缺口实际不是」≥3 项 |
| `coverage.md` | 取证边界、全量 vs 抽样、自我审计 | 已核实/推断区分 |
| `research/*.md` | 分片原始取证 | 可回溯 |

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
- **Pi 现状（为什么宿主不给）**：<`O-*` 码> + 证据；若为 `O-2` 须引 Pi 原文
- **myflow 现状**：<`E-*`/`R-*`> + `证据:行`
- **缺口判定**：`V-GAP`（Norma 有 ∧ Pi 无 ∧ myflow 无）
- **补足标准**（必须逐条可验收）：
  1. 目标**强制层级**：`E-C[myflow]`（不接受 `E-P`）
  2. 目标**回归护栏**：`R-T`，测试用例 <名/路径>
  3. 行为规格：
     - Given <前置> When <动作> Then <可观测结果>
  4. 不作弊条件：<怎样算「名义完成」，明确排除>
- **依赖与代价**：<是否需要新依赖 / 是否触碰 Pi 契约 / 预估规模>
- **优先级**：`P0 | P1 | P2` + 依据（见 §9）
- **证据等级**：`E0..E4`（含 `E5` 则本条目不得进正式缺口）
```

`QGAP-*` 同模板，但「缺口判定」改为 `V-QUAL`，并**必须**附「差距实证」一行：
`Norma:<E-码> vs myflow:<E-码>`。

### 8.5 `RISK-*` 条目模板

```markdown
### RISK-<nn> <风险名>

- **myflow 的假设**：<一句话，例如「宿主会在压缩后重新排空注入」>
- **依赖的 Pi 行为**：<行为描述>
- **证据与强度**：`<E-码>` + 路径；文档化程度（明示 / 隐含 / 未文档化）
- **失效后果**：<可观测症状；是否静默>
- **现有补偿**：<myflow 自己做了什么；给代码位置；没有则写「无」>
- **风险码**：`R-HARD | R-SOFT | R-OK`
- **钉住手段**（至少给 1 条）：
  - 断言测试：<测试名，锁住哪条行为>
  - 启动期校验：<版本/API 探测，不符则告警>
  - 防御性自愈：<已有或待加的补偿路径>
  - 上游登记：<写进文档，标注为外部依赖>
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

按 `V-*` 与 `O-*` 两维交叉计数，并给出：
真缺口数、质量差数、非缺口数、上游约束数、优势数、硬风险数。

---

## 9. 优先级评分法

不引入数值打分，用**规则判定**，避免伪精确：

| 级别 | 条件（满足任一） |
| --- | --- |
| `P0` 必补 | `V-GAP` ∧ （状态/数据丢失风险 ∨ 已有用户可见故障 ∨ 补足仅需 myflow 侧改动且代价小） |
| `P0-R` 风险钉住 | `R-HARD`（与是否缺口无关，独立成列） |
| `P1` 应补 | `V-GAP` 代价中等；或 `V-QUAL` 且位于**核心流程**（状态注入、任务生命周期、子代理调度） |
| `P2` 可补 | `V-GAP` 代价高；或 `V-QUAL` 边缘；或 `V-ADV` 增强类 |
| 不补 | `V-PI` / `V-UP` / `V-NA` |

「代价」三维度：**是否需新依赖**、**是否触碰 Pi 契约**（触碰则升一级代价）、**预估规模**（小/中/大）。

---

## 10. 自我审计与取证边界

`coverage.md` 必须回答：

1. **全量 vs 抽样**：哪些能力项是逐行读源得出的（全量），哪些是检索命中即止（抽样）。
2. **未读清单**：Norma 未审计的目录（如 `noa/`、`noaadapter/`、`examples/`、`cmd/`）及其理由。
3. **NEG 清单**：所有负向断言及其检索式，集中列出以便复核。
4. **推断清单**：所有 `E5` 条目，单独列出，声明为未验证。
5. **已知薄弱点**：本文档方法论的已知局限（如：无法验证 Pi 未来版本行为）。

**诚实性要求**：宁可写「未审计」，不得写「已确认无」。

---

## 11. 决策记录（ADR-lite）

### ADR-1 判定维度取第 3 档

- **Context**：Q3 阻塞项，三档递进。
- **Decision**：取档 3 = 功能清单 + 强制层级 + 宿主契约风险 + 相对优势保护。
- **Consequences**：产出体积明显增大（7 个文档）；但两个已取证反例（`myflow-research` 提示词守卫、
  `PI_SESSION_ID` 会话键派生）在档 1/2 下会漏判或降级，故 3 是唯一能避免假阴性的档位。

### ADR-2 归属域从 2 类细化为 5 类（`A-PI`/`A-EXT`/`A-MF`/`A-MCP`/`A-NONE`）

- **Context**：PRD 的认知陷阱只提「Pi core vs myflow」两分。
- **Decision**：加入 `A-EXT`（用户级第三方扩展）等域码，并要求每格标注域。
- **Consequences**：`Agent`/`StopAgent`/`MessageAgent`/`AgentStatus`（来自 `pi-subagents-lite`）
  不再被误记为宿主或 myflow 能力；`CAP-SUB-*` 判定因此可信。代价是矩阵多一列。

### ADR-3 `research/*.md` 的落盘主体（**第二轮修正，原决定作废**）

- **Context**：`workflow.md` §1.2 与 `myflow-brainstorm` 的契约是「research 结论持久化到
  `research/<topic>.md`」。实测 `.pi/agents/myflow-research.md` 的 frontmatter 为
  `tools: read, find, grep, ls`——**无 `write`**。
- **原决定（已作废）**：把「无 write」判为**契约断裂**，改由主会话代写。该定性是**错的**。
- **修正后的定性**：`.pi/agents/myflow-research.md` 当时无 `write`，是因为 `subagent.ts:593`
  的守卫**按 agent 判定**、拒绝写者并行——于是 research 为保住并行能力放弃了 `write`。
  两者都已修正：research 获得 `write` 并声明 `writesUnder`，守卫改为**路径级**。
- **Consequences**：写入范围契约见 `.myflow/spec/harness/index.md`。

### ADR-4 本任务不写 `.myflow/spec/`（与 PRD DoD 的冲突及处理）

- **Context**：PRD `Definition of Done` 写「`git status` 除 `.myflow/tasks/` 外无新增变更」；
  而 Q2 默认值又说「稳定结论沉淀进 `.myflow/spec/`」；workflow Step 3.1 又是 `[required]`
  的 `myflow-update-spec`。三者互相冲突。
- **Decision**：本任务**只写 `.myflow/tasks/norma-benchmark-gap-analysis/`**。
  `coverage.md` 内附一节「可沉淀清单」，列出候选 spec 结论；沉淀动作留给**后续任务**
  （或 Step 3.1 显式记录「本任务无新增契约」）。
- **Consequences**：DoD 得以维持（工作树干净）；代价是 spec 沉淀延后一次任务。
  **此项需在评审时由用户确认**（见 `implement.md` §9 评审项 R-1）。

### ADR-5 结论码用规则判定而非数值打分

- **Context**：需要优先级排序以便后续补足。
- **Decision**：§9 的规则判定。
- **Consequences**：无伪精确；不同评审者可复现同一结论。

---

## 12. 与后续任务的衔接

本任务的产物是「补足标准」。后续实现任务应能**直接复制** `gaps.md` 中单个 `GAP-*` 条目
作为自己的 PRD 主体（字段已对齐：能力描述 → PRD Goal；补足标准 → PRD Requirements +
Acceptance Criteria；依赖与代价 → PRD Technical Notes；优先级 → 排期）。

因此不建议把多个 `GAP-*` 合并成一个大任务；条目已是**可独立验收**的最小单元。
