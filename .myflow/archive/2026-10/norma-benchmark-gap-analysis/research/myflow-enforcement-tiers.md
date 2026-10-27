# T2 — myflow 强制层级与回归护栏（L3 自审）

规则 `design.md` §4/§5.2/§7；证据 `E3`（仓库 `0a702fa`）。`E-C[mf]` 必须给出会拒绝的代码行；
myflow 无自有机制写 `E-N[mf]`，生效中的 Pi 强制另记 `(有效=E-*[Pi])`，不把 Pi 门控算作 myflow 的强制。
同域同判定者合并一行但逐条列 id。缩写（`.pi/extensions/myflow/`）：`ix`=index `sb`=subagent `ag`=agents
`ci`=context-injection `tc`=turn-cache `st`=status `pr`=find-project-root；测试取首词，均在 `tests/`
（`ext`=extension `sbt`=subagent `cit`=context-injection `tct`=turn-cache `tgt`=task-gate `tbt`=task-bridge
`wit`=workflow-invariant `sh`=skills-hygiene `wt`=worktree `ch`=channel `stt`=status `mvp`=mvp）。`mf`=myflow。

## 1. 主表（§7.2 全 19 域）

| CAP | 现状 + 证据 | E 层级 | R |
| --- | --- | --- | --- |
| `LLM-01..04` | 无自有 provider/协议层；仅派发时 `--model/--thinking`(sb:236-258,394-403) | `E-N[mf]`(有效 E-C[Pi])；覆盖=局部 `E-C[mf]` | R-T sbt:167 |
| `TOOL-01..06` | 无注册表/schema/输出上限；tools→`--tools`(sb:403)；fail-closed 守卫 ix:122-140 | 01,02,04,05 `E-N[mf]`+`E-G[Pi]`；03 `E-C[mf]`；06 `E-N[mf]` | R-T sbt:525,554,581 |
| `PERM-01..05` | 无权限系统。(NEG)`.pi/**` 检索 `permission\|deny\|allow`→无 allow/deny/ask 求值 | `E-N[mf]`(有效 E-C[Pi])；白名单 `E-G[Pi]` | R-∅ |
| `LOOP-01,03,04` | 无循环/配对/终止原因建模 | `E-N[mf]`(有效 E-C[Pi]) | R-∅ |
| `LOOP-02` | 无界写者禁并行(sb:641-648 抛错)；channel 单 reviewer(channel.py:512-522) | `E-C[mf]` | R-T sbt:308,334 |
| `LOOP-05` | 父 abort→killChildTree(sb:527-538,545) | `E-C[mf]`(局部) | R-∅ |
| `LOOP-06` | 900s 墙钟→杀/exit124/留日志(sb:64,473-484,519) | `E-C[mf]` | R-T sbt:208,269 |
| `SUB-01..03` | 子代理=同目录新 pi 进程(sb:394-460)；递归三层(§4)；末条文本回传(sb:275-310) | `E-C[mf]`；02 另 `E-G[Pi]`+`E-P[mf]` | R-T sbt:208,415,434 |
| `COORD-01,02` | 工具注册给主会话(sb:573-583)；parallel 上限 6(sb:57,634) | `E-C[mf]` | R-T sbt:389 |
| `CMPT-01..04` | 无策略/熔断/boundary | `E-N[mf]`(有效 E-C[Pi]) | R-∅ |
| `CMPT-05` | 压缩后重注入：ix:455-457 + `lastInjectionTs>lastCompactionTs` ix:384 | `E-C[mf]` | R-T ext:224 |
| `NOA-01..11` | 无 ref/tier/nudge/完整性/保护/归档 | `E-N[mf]` | R-∅ |
| `NOAA-01..07` | 无 ContextView/Compactor 接管；身份=会话键非内容哈希(ix:161-193) | `E-N[mf]` | R-∅ |
| `TRANS-01..04` | 无 JSONL 转录/sidechain；subagent-logs 是派发日志(sb:67) | `E-N[mf]` | R-∅ |
| `CORE-01..04` | 无 Session/Run/恢复；`--no-session`(sb:394) | `E-N[mf]`(有效 E-C[Pi]) | R-∅ |
| `HOOK-01..04` | 6 钩子(ix:254..464)；可 block(ix:426-432,451)；`continue:true` 阻结算(ix:480-495) | `E-C[mf]`；钩子面 `E-C[Pi]` | R-T ext:157,285 |
| `MCP-01..03` | 无 MCP；Pi `["-builtin:mcp"]`→实际 A-EXT:pi-mcp-adapter | `E-N[mf]`(有效 A-EXT) | R-∅ |
| `SKILL-01..04` | 8 个 SKILL.md 仅 name/description；无压缩存活/MCP 解锁 | 01,02 加载 `E-C[Pi]`+使用 `E-P[mf]`；03,04 `E-N[mf]` | R-T sh:29,54 |
| `PLAN-01..03` | 只读期无代码强制(§planning 文字)；无 ExitPlanMode，等价 task.py:517-524；无权限翻转 | 01 `E-P[mf]`；02 `E-C[mf]`+`E-P[mf]`；03 `E-N[mf]` | R-T tgt:81 |
| `MEM-01..04` | spec 约定仅 skill 文字(01,02)；无相关度/陈旧告警(03,04) | `E-P[mf]`/`E-N[mf]` | R-∅ |
| `CTX-01` | 每回合注入 ix:302-338,340-414；session_start ix:273-301 | `E-C[mf]` | R-T ext:88,110,123,203,224 |
| `CTX-02` | 键双侧同式 ix:161-193↔task.py:100-115,get_context.py:101-112；越界/投毒→no_task tc:22-33,84-98 | `E-C[mf]`(会话 id 来自 `E-G[Pi]`) | R-T tct:172,189,207,256 |
| `CTX-03` | 默认 32K/64K/128K(ci:29-33)；超限换 omitted(ci:148-176)；项目外拒收 ci:386-394,492-493 | `E-C[mf]` | R-T cit:131,142,226,443 |
| `OBS-01,02` | `/myflow-status`(ix:254-271,st:69-115)；子代理日志(sb:67,439-443)+logPath 回报(sb:286-310) | `E-C[mf]` | R-T ext:172,stt:31,sbt:208 |
| `TEST-01,02` | verify gate(ix:464-495,221-232+worktree.py:478-507)；17 测试文件+文档契约不动式(wit:71) | `E-C[mf]` | R-T ext:285,318,356 |

## 2. `E-P` 专章（仅靠文本约束者）

| # | 位置 | 不遵守的后果 | 兜底 |
| --- | --- | --- | --- |
| P1 | workflow.md §planning(只做需求/设计) | 未评审即改码，评审闸静默跨过 | 无（start 只改状态字） |
| P2 | workflow.md §no_task(先征同意) | 擅自建任务/接管指针 | 部分 task.py:465-472 |
| P3 | workflow.md Phase Index 3.1 `[required]`(沉淀 spec) | 契约丢失，**无症状** | 无；wit 只覆盖 `[required · once]`，其 map(wit:42-49)**不含 3.1** |
| P4 | workflow.md §in_progress「implement→check」 | 跳过 check 直接提交 | 无 |
| P5 | workflow.md §Dispatch Protocol(`Active task:` 前缀) | 解析不到任务→无 task-context，**静默空上下文** | 无校验 |
| P6 | agents/{implement,check,research}.md Recursion Guard 文字 | 自旋 | **有**（§4 #1） |
| P7 | agents/myflow-research.md「one topic per file」 | 并行分片互相覆盖，静默丢结论 | 半：目录边界 `E-C`，文件不相交只有文本 |
| P8 | skills/myflow-before-dev:59「Mandatory …spec tree」 | 忽略项目约定 | 无 |
| P9 | skills/myflow-brainstorm:39「Always ensure a task」 | 讨论无留痕 | 无 |
| P10 | prompts/myflow-finish-work.md + §completed | 未提交即宣告完成 | 无 |
| P11 | skills/myflow-check 复核清单 | 复核流于表面 | 仅 verify 最低线 |

**R-STR-3**：P1,P3,P4,P5,P7,P8,P9,P10,P11 **不得**记为已覆盖；对应 Norma 项记 `V-QUAL`/`V-GAP`。
P6 唯一「文字+代码」双写，按最高层 `E-C` 记；P2 有部分兜底仍主记 `E-P`。

## 3. `E-C` 专章（会拒绝的代码行）

| 关注点 | 拒绝行 | 形式 | 测试 |
| --- | --- | --- | --- |
| 递归派发 | ix:423-433 | `block:true` | sbt:434 |
| 写范围越界 | ix:440-452(+116-152) | `block:true` | sbt:456,525,554,581 |
| 无界写者并行/并行超限/缺参数 | sb:641-648,633-634,627-631 | `throw` | sbt:308,198,389 |
| 超时/取消 | sb:473-484,527-538,545 | 杀树+exit124/throw | sbt:208,269（取消 R-∅） |
| writesUnder 残留清除 | sb:452-453 | 不注入(fail-safe) | sbt:612 |
| 空上下文门禁/非法 manifest 名 | task.py:496-521,648-651 | `return 1` | tgt:81,103,119,170 |
| 任务目录越界 | task.py:444-448,482-486,574-578,641-645 | `return 1` | tbt:273,311 |
| 会话指针越界/投毒 | tc:22-33,84-98 | →no_task | tct:172,189,207,256 |
| 注入预算耗尽/jsonl 引用项目外 | ci:148-151,161-176,386-394,492-493 | 换 omitted/跳过 | cit:131,142,226,443 |
| verify 未过/命令失败 | ix:478-495；worktree.py:496-507 | `continue:true`/`return 1` | ext:285,318,356；wt:130 |
| channel 并发/单写者 | channel.py:506-522 | `return 1` | ch:179,389 |
| 项目根误判 | pr:13-25 | 返回 null，扩展不激活 | mvp:33,43 |

## 4. 同一关注点的「代码强制 vs 提示词约定」成对实例

1. **递归守卫（升级栈样板）**：文字(agents md:12-18) → `E-G[Pi]`（三 agent `tools:` 无该工具，经
   sb:403 `--tools` 交 Pi 硬门控，sh:133 钉死） → `E-C[mf]`(ix:423-433，sbt:434 锁定)。myflow 具备
   `E-P`→`E-G`→`E-C` 升级能力栈，且已用于本项。
2. **写范围**：文字(agent md)+`E-C`(ix:116-152,440-452)+并行闸(sb:641-648)；文字只是代码行为说明。
3. **verify 门**：文字(workflow.md)+`E-C`(ix:478-495)，且 channel.py:564-569 把非子代理 review worker
   纳入同一门 →「一关注点两路强制」样板，可复用于 P1/P3。
4. **反例（未升级）**：P3、P5 只有文字，无 `E-G`/`E-C` → 宜作 `QGAP` 样板：照 #1/#3 补代码路径+测试。

## 5. 跨切面域 `OBS`／`TEST`（无 Norma 对应目录）

- `OBS-01` E-C[mf] / R-T stt:31：`/myflow-status` 无模型调用，输出 phase、task、git、next 与
  `phaseBlockFound`（暴露 workflow 漂移）；`ix:254-271`, `st:69-115`。
- `OBS-02` E-C[mf] / R-T sbt:208：子代理日志+进度事件+超时/失败回报 logPath，日志惰性创建 sb:439-443。
- `TEST-01` E-C[mf] / R-T ext:285：verify gate（§3）。本仓库无 `worktree.yaml` → 空跑，机制在但对本任务无拦截。
- `TEST-02` E-C[mf] / R-T wit:71：17 个测试文件；含把**文档契约**钉成测试的先例。

**可复用**：wit:71 证明 myflow 能用测试锁住提示词文本本身（wit:42-49 map 与 workflow.md 双向对齐），
是把 P1/P3/P5 从 `E-P` 升到「`E-P`+`R-T`」的最便宜路径（无需新运行时代码），建议写入 `03-gap-register.md`。

## 6. 自我声明

- **全量读**：`.pi/extensions/myflow/` 9 个 TS（d.ts 仅扫 register*）；`.pi/agents/` 3 份；`.pi/prompts/` 3 份；
  `.myflow/workflow.md`；`.myflow/spec/harness/index.md`；`task.py:100-140,397-432,439-760`；
  `channel.py:492-600`；`worktree.py:478-507`；`get_context.py:95-165`。
- **只检索**：`.pi/skills/*/SKILL.md`（grep 关键句）；`tests/` 17 文件（grep 用例名+行号，**未读测试体**，
  故 `R-T` 判据=「存在同名用例」，未验证断言强度）；`channel.py`/`worktree.py` 其余子命令。未读
  `.myflow/archive/`、skills `references/*`（非强制机制所在）、Pi 1.2.0 `docs/*.md`（属 W1/T1 语料，
  本片 Pi 侧一律以「有效=`E-*[Pi]`」占位）。
- **NEG**：`PERM-01..05`、`MCP-01..03` 两行。`PERM` 行残余风险：权限可能只在 Pi 侧配置 → 须 T1 复核
  `settings.json`/`docs/security.md` 后才可作最终 `V-GAP` 依据。`MCP` 行【C1 裁决：部分】——命中列原记「仅 `subagent.ts:69` 注释」不实：
  `.pi/**` 内 `mcp` 实测 **≥14 处**，集中在 `skills/myflow-spec-bootstrap/references/mcp-setup.md:11,18,22,23,25,34,39-43,55,87`、
  `…/repository-analysis.md:13,16,36`、`myflow-meta/references/harness-conventions.md:74`、`subagent.ts:69`；
  **断言本身成立**（myflow 只**文档化** Pi 的 MCP，无任何 `.ts` 消费）。**薄弱点**：未量化「哪条 `E-P` 最常被违反」；
  `R-T` 只判存在性。
