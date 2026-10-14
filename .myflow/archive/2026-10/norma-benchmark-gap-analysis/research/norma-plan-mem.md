# S8 — PLAN / MEM 域分片

> 基线 `research/00-baseline.md`（myflow@0a702fa、Norma@52f17dd、Pi **1.2.0**）。
> 规则见 `design.md` §2.2/§3/§4/§5/§7.2。证据码 `E0..E4`；**本片未用 `E5`**。

## 0 归属判定

- **PLAN = `O-2`（刻意外包）→ 本环境 `A-NONE`**：`…/pi-coding-agent/README.md:19` 明示 skips
  「plan mode」；随包示例 `examples/extensions/plan-mode/`（`index.ts:22-25` 只读工具集、`:163-171`
  bash allowlist）**未装载**（`~/.pi/agent/settings.json` 的 `extensions` 仅 `["-builtin:mcp"]`，
  `~/.pi/agent/extensions/` 无 plan-mode）⇒ 卸载测试后消失 ⇒ 非 `A-PI`/`A-EXT`。
- **MEM = `O-5`（双方皆无）**：Pi core 无长期记忆的存储/召回/自写入；docs 的「memory」一律指
  **进程内存**或**会话历史**（NEG-2）。`AGENTS.md`/skills 是**静态知识**，非 agent 自累积记忆（§3）。
- **`cbmem.ts` 属 `A-EXT`**（`~/.pi/agent/extensions/cbmem.ts` 以 `spawn` 直调 `codebase-memory-mcp.exe cli` 并注册裸名工具；**非** MCP、**非** core），不是长期记忆（NEG-3）。C3 修正：原记 `A-MCP` 与源码不符。
- **myflow 的 PLAN 承担 = `E-P`**（skill 文本，无只读代码守卫；唯一代码门 `task.py start` 在**执行前**）
  ⇒「先规划后执行」`V-QUAL`；**「探索期只读」`V-GAP`**。

## 1 表 A（含 myflow 行与结论码）

| CAP | Norma 机制+证据 | Pi 1.2.0 现状+证据 `[v1.2.0]` | 域 | `O-*` | myflow 现状+证据 | `V-*` |
|---|---|---|---|---|---|---|
| PLAN-01 只读探索 | `plan/plan.go:81-98`（EnterTool）；只读由权限层**代码**强制 `permission/permission.go:52,100-103`；`R-T` `agentcore/plan_test.go:17-72`、`plan/plan_test.go:13-52` | core 无（`README.md:19`）；原语 `extensions.md:165,187`（`setActiveTools`）、`:106,170-178`（`tool_call` block）、`:263`；示例未装载 | `A-NONE` | `O-2` | 无只读阶段；仅文字 `.pi/skills/myflow-brainstorm/SKILL.md:9-13`（NEG-3） | `V-GAP` |
| PLAN-02 `ExitPlanMode`+审批门 | `plan/plan.go:100-144`（`Approver` 回调；拒绝则 `tool.Errorf` 且留在 plan）；`R-T` `plan/plan_test.go:28-52` | 无内建；审批原语 `extensions.md:104`（`before_agent_start` 改 prompt/工具） | `A-NONE` | `O-2` | 评审门 `.myflow/workflow.md:20,106-107`+`.pi/prompts/myflow-continue.md:32-34`；代码门 `task.py:493-508`（空 jsonl 拒绝 `start`）；无 plan 对象 → `E-P`（门禁本身 `E-C[myflow]`） | `V-QUAL` |
| PLAN-03 中途权限翻转 | `plan/plan.go:68-72`（approve→target）；`agentcore/agentcore.go:269-276`（每轮经 `PermissionModeFunc` 读取）⇒ 循环内即时生效 | core 无常驻 mode；扩展可在 `tool_call` 动态放行/阻断（`extensions.md:170-178`） | `A-NONE` | `O-2`（依赖 S2/PERM） | 无；子代理权限 spawn 时固定（`--approve`，`subagent.ts:394`），主会话无 mode 概念 → `E-N` | `V-GAP`（P2） |
| MEM-01 frontmatter 存储 | `memory/memory.go:1-6,146-196`（`parseFrontmatter`/`renderFrontmatter`：name/description/type）；`:103-118`（`Save` + 重建索引）；`R-T` `memory_test.go:13-38` | 无 memory store；最近似 `configuration.md:18,45`、`cli.md:224,231`（纯文本无 schema）；skills frontmatter `skills.md:24,67` 属知识分发 | `A-NONE` | `O-5` | `.myflow/spec/**/*.md` 无 frontmatter/type；`.pi/skills/*/SKILL.md` 有（Pi 格式，非 myflow 自建） | `V-QUAL` |
| MEM-02 `MEMORY.md` 索引 | `memory/memory.go:119-145`（`Index`/`rebuildIndex`/`buildIndex`，每次 `Save` 自动重建）；`memory_test.go:30-34` | 无索引文件；skills 仅靠 `description` 供发现（`skills.md:53,85`） | `A-NONE` | `O-5` | `.myflow/spec/index.md` **人工维护**（`.pi/skills/myflow-update-spec/SKILL.md:50` 步骤 5）→ 无自动重建，有漂移风险 | `V-QUAL` |
| MEM-03 相关度选择+自动注入 | `memory/relevant.go:31-83`（`score`：name×3/desc×2/body×1，recency 破平）、`:52`；自动注入 `agentcore/agentcore.go:438-445`（`MaxInject` 默认 3，`:223`）；工具 `memory/tools.go:20-96` | 无相关性召回：skills 由模型自选（`skills.md:45`「model might fail to load」→ `E-P`）；context files 无条件全量加载（`configuration.md:18`） | `A-NONE` | `O-5` | `myflow-before-dev` 让模型 `cat .myflow/spec/index.md`（`.pi/skills/myflow-before-dev/SKILL.md:14,27-29`）——纯提示词、无排序、无上限 | `V-GAP` |
| MEM-04 陈旧告警 | `memory/relevant.go:85-108`（`Age`+`stalenessNote`：>48h 附「point-in-time note, not live state」）、`:115-132` 附保存时间 | 无（无 memory 即无陈旧概念） | `A-NONE` | `O-5` | 无运行时告警；靠 git blame/review | `V-GAP`（P2） |

## 2 NEG 块（均不单独支撑判定；已过 design §6 测 A）

```
(NEG-1) Pi core 无 plan mode
 语料=docs/*.md(40)+README.md+cli.md+settings.md+configuration.md
 检索式=(?i)plan[ -]?mode|EnterPlanMode|ExitPlanMode|--plan|\b/plan\b
 命中=README.md:19（skips → O-2 正证，非能力）；docs 正文 0（cli/settings 无 plan 项）；
      plan-mode 示例与 CHANGELOG.md:4913-4918 为示例/历史记录
 残余风险=改名词（read-only mode/approval）；补检 (?i)read-?only|approv → 仅 extensions.md:104、security.md 项目信任
(NEG-2) Pi core 无长期记忆（存储/召回/自写入）
 语料=同上 40 篇 + sdk.md
 检索式=(?i)long-?term memory|RecallMemory|RecordMemory|remember across|persistent memory|memory (store|dir|file)
 命中=0；「memory」命中均为进程内存（codemode.md:226、llama-cpp.md:28）或 in-memory session（cli.md:99、sdk.md:38,42-48）
 残余风险=quickstart.md:108 称 AGENTS.md 为 "persistent instructions"；skills.md:45 的按需加载——均非动态记忆
(NEG-3) myflow 无只读代码守卫；cbmem.ts 非长期记忆；A-EXT 无 plan/memory
 语料=.pi/extensions/myflow/*.ts、.pi/{agents,prompts,skills}/**、.myflow/scripts/*.py、~/.pi/agent/extensions/cbmem.ts、pi-subagents-lite/**(.md)
 检索式=(?i)read-?only|readonly|readOnly|plan mode|memory|remember
 命中=myflow 仅 …/references/spec-task-planning.md:69（描述性，非强制）；cbmem 仅 codebase-memory-* 工具（`A-EXT` 代码图，C3 修正原记 `A-MCP`）；
      pi-subagents-lite 0（其 src/ 注册面由 S3 独立取证）
 残余风险=自然语言「不许改代码」散落 prd/skill 无法穷举（本 NEG 只否定代码级机制）；名称含 memory 易误判
```

## 3 知识持久化的三条路线对照

| | Norma `memory` | myflow `.myflow/spec/` | Pi `AGENTS.md`+skills |
|---|---|---|---|
| 目标 | agent **自动累积**的跨会话事实 | 项目**契约**（executable contract） | **静态**指令与可复用工作流 |
| 写入者 | agent（`memory/tools.go:51-96`） | 人+agent（`myflow-update-spec`），版本控制 | 人（`configuration.md:18`） |
| 检索 | 关键词 top-N（`relevant.go:31-83`）+每轮自动注入（`agentcore.go:438-445`） | 人工索引+模型 `cat`（`myflow-before-dev/SKILL.md:14`） | context file 全量；skill 由模型自选（`skills.md:45`） |
| 陈旧 | >48h 自动加 caveat（`relevant.go:101-108`） | 靠 git blame/review | 无 |
| 解决 | 个人化偏好、跨项目、零人工维护 | 团队共享、可 review、与代码同版本、可测试 | 零成本、跨工具兼容（`CLAUDE.md`）、可打包 |
| 不解决 | 事实准确性/冲突消解、语义检索、结构化契约 | 无自动积累/召回/告警、不跨项目 | agent 自写、排序、告警、类型化 |

myflow 是**有意**选 spec 路线：`.pi/skills/myflow-before-dev/SKILL.md:61`「**Specs are authoritative
over memory**」。故 MEM-01/02 缺的是「**元数据+自动索引**」，MEM-03/04 是**机制缺失**（无召回、无告警）。

## 4 「Norma 有而 myflow 用别的办法解决」（供 `ADV-*`/`V-OWNED`）

- **规划-实现分离**：Norma 约束**探索期的工具集**；myflow 约束**开始编码的条件**（`workflow.md:10-20`
  Phase 1→2、jsonl 预策展、`task.py:493-508`）。两者皆非提示词 ⇒ `PLAN-02` 的代码门部分 `V-OWNED`。
- **知识持久化**：myflow 用 **git 版本控制的 spec+skill**（可 diff、可回滚）替代 memory 工具 → `ADV` 候选。
- **待办跟踪**：Norma `tool/todo.go`（TodoWrite）；myflow 用 `workflow.md` 状态机 + `task.py:13-17`（可脚本查询）。
  附带反向差异：Norma 的 `Approver` 可自动化审批，myflow 复用对话审批、不可脚本化（非缺口）。

## 5 自我声明

- **全量读**：`Norma/plan/{plan.go,plan_test.go}`、`Norma/memory/{memory,relevant,tools,memory_test}.go`、
  `Norma/permission/permission.go:90-125`、`Norma/agentcore/plan_test.go`、`Norma/README.md`（相关行）、
  `pi-coding-agent/examples/extensions/plan-mode/{README.md,index.ts(检索)}`、`.pi/extensions/myflow/index.ts:410-460`、
  `.pi/skills/{myflow-brainstorm(前半),myflow-before-dev,myflow-update-spec}/SKILL.md`、`.myflow/workflow.md`（Phase 表）、
  `.myflow/spec/index.md`、`.myflow/scripts/task.py:478-530`。
- **只检索未通读**：`docs/{usage,cli,settings,quickstart,configuration,skills,keybindings,codemode}.md`（按 NEG 式）；
  `agentcore/agentcore.go:200-320,405-460`；`myflow-brainstorm/SKILL.md` 后半。
- **未读**：`Norma/examples/`、`Norma/cmd/`（00-baseline §5）；`myflow-spec-bootstrap/references/*`。**未用 `E5`**。
- **残余薄弱点**：① 未通读全部 40 篇 docs，MEM 负向结论依赖 NEG-2 及其残余风险；② `AGENTS.md` 能否被 agent
  用 write 改写未验证；③ PLAN-03 与 S2（PERM）重叠，定稿前须与之对齐。
