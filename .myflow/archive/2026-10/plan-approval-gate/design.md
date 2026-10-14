# design.md — plan 提问与批准门：机制、契约与强制层级

> `prd.md` 定「要什么」；本文件定「怎么实现、拿什么强制」；`implement.md` 定「按什么顺序做」。
> 三个设计问题（Q1/Q2/Q3）用户均已选定，本文件不重新论证，只把它们展开成可实现的契约。

---

## 1. 需求 → 机制映射（本任务的核心表）

用户要三个**有序**动作。每个动作的强制层级是分开设计的 —— 「有用例」不等于「被拦得住」。

| # | 需求 | 落点 | 强制层级 | 靠什么拦 |
| --- | --- | --- | --- | --- |
| R1 | 制定 plan 时**先用选择题提问** | 新增工具 `myflow_ask_user` | `E-C` + `E-G` | 工具存在且弹窗；子代理调用被 `tool_call` 拦（`E-C`） |
| R2 | **没问过就不给批准** | `task.py` 校验 `questions.jsonl` | **`E-C`** | 无「已作答」记录 → `approve` / 批准工具**拒绝** |
| R3 | 用户答完后**才给 plan** | `myflow-brainstorm` 技能文本 + R2 的间接强制 | `E-P`（主）+ `E-C`（经 R2） | 技能要求；且「没问就不给批准」使跳过提问**走不通** |
| R4 | **批准后才能继续** | `approval.json` + `task.py start` 门 | **`E-C`** | `start` 校验文件存在 **且 plan 哈希匹配**，否则非零退出 |
| R5 | 批准与**当前 plan**绑定 | plan 内容哈希 | **`E-C`** | 改 plan → 哈希变 → `start` 拒绝 |
| R6 | 非 TUI 模式不静默跳过 | 降级契约 | **`E-C`** | 无 UI 时工具**返回指令而不伪造答案**；批准工具**不写** `approval.json` |
| R7 | 不得引入第二份哈希实现 | 哈希只在 Python | 代码结构 + 测试 | TS 侧 `spawn` 调 `task.py plan-hash` |

**R3 的诚实说明**：无法用代码证明「模型问了**该问的**问题」。
本设计的强制是**间接但真实**的 —— 不经过 `myflow_ask_user` 就没有 `questions.jsonl` 记录，
没有记录就不能批准，不能批准就不能 `start`。所以「跳过提问直接出 plan」会被 R2+R4 拦在门外。
「问得够不够好」仍然是 `E-P`，这是本任务**不假装解决**的部分。

---

## 2. 宿主能力与硬边界（已取证）

| 事实 | 证据 | 对本设计的约束 |
| --- | --- | --- |
| `ctx.ui.select(title, options: string[]): Promise<string \| undefined>` | `.pi/extensions/myflow/pi-coding-agent.d.ts:26-27` | **只有单选、无 per-option 描述、无多选**。选项说明需自拼进字符串 |
| `ctx.ui.confirm(title, message): Promise<boolean>` | 同上 `:25` | 批准用它（是/否），不用 `select` |
| `ctx.hasUI`、`ctx.mode: "tui" \| "rpc" \| "json" \| "print"` | 同上 `:14-16` | **降级判据**：`!ctx.hasUI` 即不可交互 |
| 工具 `execute` 能拿到 `ctx` | Pi 示例 `examples/extensions/bash-spawn-hook.ts:26`（第 5 个参数 `_ctx`） | 提问工具可以做「回合内弹窗」 |
| 官方就是这么做审批拦截的 | `docs/extensions.md:175` | 本设计不是私创用法 |
| 本机已有 `A-EXT` 用同一 API 做工具审批 | `~/.pi/agent/npm/node_modules/pi-mcp-adapter/tool-approval.ts:198` | **可能两处审批叠加**；本设计只加「plan 批准」，不碰逐工具调用审批，避免与其争抢 |
| `ctx.ui` 在 myflow 中从未被调用 | 全仓 + 全 A-EXT 检索 | 本任务是首次引入交互式 UI，需在 spec 里登记 |

### 2.1 「回合内」语义（与 Norma 的差别）
Norma 的 `AskUserQuestion` 是**宿主提供回调**，SDK 不决定 UI。Pi 的等价物是
`ctx.ui.select`：模型调工具 → 处理器 `await` 弹窗 → 用户选中 → 答案作为**工具结果**返回。
两者语义一致（都不结束回合）。差别仅在 UI 由宿主固定为 TUI 控件，且**只能单选**。

---

## 3. 数据契约

### 3.1 `questions.jsonl`（新增，任务目录内）

每行一个 JSON 对象，**只追加**：

```json
{"at":"2026-10-14T13:02:11Z","tool":"myflow_ask_user","header":"门的位置","question":"门卡在哪个转换点？","options":["只卡规划→执行","每次动手前","两者都要"],"answer":"只卡规划→执行","via":"ui-select"}
```

| 字段 | 含义 |
| --- | --- |
| `at` | ISO-8601 UTC |
| `question` / `options` | 原样记录模型提交的内容（**可审计**，也是回答的存档） |
| `answer` | 用户所选；**取消/无 UI 时为 `null`** |
| `via` | `ui-select`（真弹窗得到） / `none`（未取得答案） |

**不变式**：
- **只有 `via === "ui-select"` 且 `answer` 非空**的行才算「已作答」。这是 R2 的判据。
- 无 UI 时**也要写行**（`via: "none"`, `answer: null`）——「问过但问不出来」与「根本没问」必须可区分。
- 写入者只有 `myflow_ask_user` 的处理器。子代理不得写（见 §6）。

### 3.2 `approval.json`（新增，任务目录内）

```json
{"approved_at":"2026-10-14T13:20:03Z","approved_by":"ui-confirm","session_id":"<PI_SESSION_ID>","plan_files":["prd.md","design.md","implement.md"],"plan_hash":"sha256:9f2c…","questions_asked":3}
```

| 字段 | 含义 |
| --- | --- |
| `approved_by` | `ui-confirm`（TUI 弹窗） / `cli`（人类跑 `task.py approve`） |
| `plan_files` | 参与哈希的文件**实际存在**的那些，固定顺序 |
| `plan_hash` | 见 §3.3 |
| `questions_asked` | 批准时的「已作答」计数（快照，便于事后审计） |

**不变式**：
- 缺文件 / `plan_hash` ≠ 当前 plan 哈希 → **视为未批准**（`start` 拒绝）。
- **删除该文件即撤销批准**（无需额外命令）。
- 该文件由工具处理器或 `task.py approve` 写入；**模型不应手写**（见 §8 威胁模型）。

### 3.3 plan 哈希规格（**只有一份实现**）

- **实现位置**：`.myflow/scripts/task.py` 的 `plan-hash <slug>` 子命令（唯一权威）。
- **算法**：对 `["prd.md", "design.md", "implement.md"]` 中**存在**的文件，
  按该固定顺序，逐个取 `filename` 的 UTF-8 字节 + `\0` + 文件**原始字节** + `\0`，
  拼接后取 `sha256`，输出 `sha256:<hex>`。
- **不含**：`task.json`、`*.jsonl`、`questions.jsonl`、`approval.json`、mtime、路径。
- **TS 侧**：只能通过 `task.py gate-info <slug>`（§5.1）读取，**不得**重新实现哈希。

> **为什么写死「一份实现」**：横评已把「两侧各派生一份、必须逐字符等价」登记为 `RISK-01`（`R-HARD`）。
> 哈希比会话键更危险：算法或分隔符任一不一致，都会表现成「明明批准了却 start 不了」，
> 且没有报错指向根因。**TS 侧任何形式的内联哈希都是缺陷。**
>
> **同一道理适用于「已作答」判据**（B3 开工前的设计修正）：若 TS 侧自己数 `questions.jsonl`、
> Python 侧也自己数，两边稍有不一致就会表现成「批准写下了、`start` 却放行」或反之。
> 因此判据也不得两份：TS 侧统一调 `gate-info`。

---

## 4. 两个新工具

命名沿用 myflow 的 `myflow_` 前缀（与 `myflow_subagent` 一致）。

### 4.1 `myflow_ask_user`

| 项 | 规格 |
| --- | --- |
| 用途 | 向用户提**一个**选择题，拿到答案后继续（不结束回合） |
| 入参 | `header`（短标签，≤ 24 字符）、`question`（问题正文）、`options`（**2–4** 个字符串） |
| 出参 | 取得答案 → `{ "answer": "<选中项>", "via": "ui-select" }`；取消 → `{ "answer": null, "via": "cancelled" }`；无 UI → `{ "answer": null, "via": "no-ui", "instruction": "<见下>" }` |
| 副作用 | 追加一行 `questions.jsonl`（**唯一**写者） |
| 校验 | `options` 少于 2 或多于 4 → 返回错误结果（不弹窗）。Pi 的 `select` 无选项上限，但 2–4 是 Norma `AskUserQuestion` 的既有约定，超出即难以在窄终端读完 |
| 子代理 | **禁用**（见 §6） |

**无 UI 时的 `instruction` 文案（行为契约，不是建议）**：

```
No interactive UI is available in this session (ctx.hasUI=false, mode=<mode>).
Pose this question in your reply as a numbered list, then END YOUR TURN and wait
for the user's answer. Do not proceed and do not guess an answer.
```

**为什么返回指令而不抛错**：抛错会让模型「重试工具」，返回指令让它走降级路径。
**为什么不返回一个默认答案**：伪造同意是本设计最不能犯的错（见 §8）。

### 4.2 `myflow_request_approval`

| 项 | 规格 |
| --- | --- |
| 用途 | 把当前 plan 交给用户批准，并在**用户同意时**落 `approval.json` |
| 入参 | 无（工具自己解析活动任务与 plan 文件） |
| 前置校验（**按序，任一失败即拒绝且不弹窗**） | ① 有活动任务；② 活动任务在 `.myflow/tasks/` 内；③ 至少存在一个 plan 文件（`prd.md`）；④ `questions.jsonl` 的「已作答」计数 ≥ 1 |
| 交互 | `ctx.ui.confirm("批准这个 plan？", "<plan 文件清单 + 哈希前 12 位>")` |
| 同意 | 调 `task.py plan-hash` 取哈希 → 写 `approval.json`（`approved_by: "ui-confirm"`）→ 返回 `{ approved: true, plan_hash }` |
| 拒绝 | 返回 `{ approved: false }`，**不写任何文件** |
| 无 UI | 返回 `{ approved: false, via: "no-ui", instruction: "..." }`，**不写文件**。指令内容：让**人类**运行 `python3 .myflow/scripts/task.py approve <slug>` |
| 子代理 | **禁用**（见 §6） |

### 4.3 为什么拆成两个工具而不是一个带 `kind` 的工具
- 副作用不同：一个只追加审计行，一个写**授权凭证**。同一个工具两种危险级别，评审时无法区分。
- 前置校验不同：批准有 4 条前置，提问没有。
- 子代理守卫、测试用例、文档都能一对一说清。

---

## 5. 门：`task.py`

### 5.1 新增子命令

| 子命令 | 作用 |
| --- | --- |
| `plan-hash <slug>` | 打印 `sha256:<hex>`（§3.3）。**唯一哈希实现**，供人类与脚本使用。 |
| `gate-info <slug>`（**B3 设计修正新增**） | **只读**，输出单行 JSON：`{"plan_hash":…,"plan_files":[…],"questions_answered":N,"approval":{"status":"approved\|stale\|missing\|invalid\|unhashable","plan_hash":…}}`。`status` **原样透传** `_approval_report` 的状态集（不在 TS 或本命令里归并成三值）——否则就是「另写一份判据」。实际用者只判断 `!= "approved"`。**TS 侧的唯一读数入口**（一个进程调用同时拿到哈希与已作答计数，避开两份实现）。 |
| `approve <slug>` | 供**人类**在非 TUI 场景批准：校验「已作答 ≥ 1」→ 计算哈希 → 写 `approval.json`（`approved_by: "cli"`）。**`sys.stdin.isatty()` 为假时拒绝**并说明「请由人类在终端运行，或用 TUI 里的批准工具」 |
| `task.py status`（可选，若成本低） | 打印 `approval: approved\|stale\|missing` + 哈希前 12 位 |

### 5.2 `start` 的第二个门

在现有「空上下文门禁」**之后**追加：

```
未批准（approval.json 缺失 / 不可解析 / plan_hash ≠ 当前 plan-hash）
  → stderr 打印：原因 + 当前哈希与已批准哈希的前 12 位对比 + 三条可操作提示
    (a) 用 myflow_request_approval 请求批准
    (b) 由人类运行 task.py approve <slug>
    (c) 明知故犯：--allow-unapproved
  → exit 1
```

**`--allow-unapproved` 的存在理由与代价**（与既有 `--allow-empty-context` 对称）：
非交互场景（CI、纯自动化）需要一个明知故犯的出口。为让它**不伪装成正常路径**：
- 传该标志时在 stderr 打印醒目警告；
- 在 `task.json` 写 `started_without_approval: true`，使事后可查。
- 该标志同时跳过下面的 R2 兑底（它代表「跳过整个 plan 批准门」）。

#### R2 兑底（**B3 开工前的设计修正，必读**）

原先 R2（「没问过就不给批准」）只在 `approve` 与批准工具两处校验，而 `start` **只查**
`approval.json` + 哈希 → **存在漏洞**：只要任一处「已作答」判据偏宽，就能写出批准而 `start` 放行。

**修正**：`start` 在批准校验通过后，**再独立校验一次** `questions_answered >= 1`（用与 `approve`
同一个函数，不另写一份）。不满足 → 拒绝，提示「先提问：用 `myflow_ask_user`」。

这使 R2 的兑底落在**真正生效的那个点**（`start`），而不是只依靠写入方守规矩。

### 5.3 `validate` 的报告项
`validate <slug>` 追加报告：`questions.jsonl` 已作答计数、`approval.json` 状态（approved/stale/missing）、
哈希是否匹配。让 `validate` 成为「这个任务能不能 start」的单点自检。

---

## 6. 子代理守卫（`E-C`）

两个新工具**只许主会话调用**。理由：子代理运行在非交互进程里（`print`/`json`），
既弹不出窗，也不该代替用户表达意愿。

实现沿用既有递归守卫的形态（`.pi/extensions/myflow/index.ts` 的 `tool_call` 钩子）：

```ts
if (ASK_TOOL_NAMES.has(toolEvent.toolName) && isSubAgent) {
  return { block: true, reason: "只有主会话可以向用户提问或请求批准；请把建议回报给主会话。" };
}
```

**两手都要有**：工具自身的 `execute` 也拒绝（第一道，防钩子被绕过）；
`tool_call` 的 `block` 是第二道。这与 `.pi/agents/*.md` 的 `tools:` 白名单（子代理本就不含这两个工具）
合起来是**三层**，与横评里 `ADV-04`（递归守卫的三层升级栈）同一形态。

---

## 7. 交互流程

### 7.1 正常路径（TUI）
```
用户提需求
  ↓
main: 复杂任务 → myflow_ask_user（Q1）  ← 弹窗，用户选
  ↓ 答案回模型（不结束回合）
main: myflow_ask_user（Q2）…（按需 N 次）
  ↓
main: 写 prd.md / design.md / implement.md
  ↓
main: myflow_request_approval      ← 弹 confirm
  ↓ 用户同意 → approval.json 落盘
main: task.py start                ← 门通过
  ↓
执行期（本任务不改）
```

### 7.2 非 TUI 降级
- `myflow_ask_user` 返回 `via: "no-ui"` + 指令 → 模型在回复里列编号选项并**结束回合**。
- `myflow_request_approval` 返回 `via: "no-ui"` + 指令 → 让人类跑 `task.py approve <slug>`。
- **两条路径都不伪造同意**，且都会留下 `via: "none"` 的审计行或干脆不留批准文件。

### 7.3 改 plan 之后
模型改任何一个 plan 文件 → 哈希变 → `approval.json` 变 `stale` → `start` 拒绝 →
必须重新 `myflow_request_approval`。**这是设计意图，不是缺陷**（PRD 已接受该代价）。

---

## 8. 威胁模型（诚实声明，必须写进 spec）

**这道门防的是「忘记问 / 忘记批准 / 图省事跳过」，不是防恶意模型。**

任何能跑 `bash` 的 agent 都可以直接写 `approval.json`、或调 `task.py approve`。
本设计的对策只提高**误跳过**的门槛，不构成安全边界：

| 攻击面 | 现状对策 | 是否充分 |
| --- | --- | --- |
| 模型忘记问问题直接出 plan | R2：无已作答记录 → 不能批准 | ✅ 拦得住失误 |
| 模型手写 `approval.json` | 无技术拦截 | ❌ **只能靠事后审计，且审计能力有限**：P3 实测——伪造者把 `plan_hash` 写成**当前正确值**、`approved_by` 写成**合法值 `"ui-confirm"`**，再补一行伪造的 `via:"ui-select"`，`start` 就放行。⇒ **`approved_by` 不是可信字段**，不得用它区分真伪；本表这一行为「无对策」，不是「弱对策」 |
| 模型跑 `task.py approve` | `isatty()` 为假时拒绝 | ❌ **已实测失效**（B1 取证）：Pi 的 bash 工具**分配 pty**，`python3 -c "import sys;print(sys.stdin.isatty())"` 在该环境实测为 **`True`**。所以该检查**拦不住模型**。保留它只为挡住真正无 tty 的自动化（CI 自带进程）；**不得当任何保证**。 |
| 模型传 `--allow-unapproved` | 无拦截，但会写 `started_without_approval` + 显式警告 | ⚠️ 可实现事后发现 |

**结论写法**：spec 与 `workflow.md` 里必须写「本门是**约定强化**（防误跳过），非权限边界」，
不得暗示它能阻止有 `bash` 的 agent。这与横评 `01-verdict.md` 对「静默失效」的判据口径一致。

**已实测的具体后果（B1 取证 + P3 复核，必须原样写进 spec）**：本机 Pi bash 分配 pty，故 `approve` 的
`isatty` 检查**在本环境不生效** —— 模型完全可以自己跑 `task.py approve` 或直接写 `approval.json`。
因此本门的真实强度是：**能挡住「忘记」与「懒得走流程」，挡不住「存心绕过」**。

**Windows 附加细节（P3 补测）**：重定向 `< /dev/null`（映射到 Windows `NUL`）时 `isatty()` **仍为 `True`**，
只有**管道**才算非 tty（`printf '' | python3 task.py approve …` 会拒绝）。
⇒ 该检查在本平台比在 POSIX 上更弱，进一步印证「不得当任何保证」。

---

## 9. 决策记录（ADR-lite）

### ADR-1 plan 哈希只有一份实现（Python），TS 侧 spawn 调用
- **Context**：`RISK-01` 已证明「两侧各派生一份必须逐字符等价」是 `R-HARD` 级隐患。
- **Decision**：`plan-hash` 只存在于 `task.py`；TS 侧 `spawnSync` 调用。
- **Consequences**：批准动作多一次进程启动（一次性，可接受）；
  换来「算法不可能漂移」。任何内联哈希实现视为缺陷。

### ADR-2 批准与提问拆成两个工具
见 §4.3。**Consequences**：工具数 +2，需要 2 处子代理守卫、2 组测试、1 处文档清单更新。

### ADR-3 「没问过就不给批准」是让 R3 可强制的支点
- **Context**：无法用代码证明「问题问得好」，但可以证明「一次都没问」。
- **Decision**：`questions.jsonl` 的已作答计数 ≥ 1 是批准的前置。
- **Consequences**：需要新增一个只追加的审计文件；好处是同时获得可审计的问答存档，
  并可被 implement 子代理当输入读（回答里往往就是需求细节）。

### ADR-4 非 TUI 时返回指令，绝不返回默认答案
- **Decision**：`no-ui` 是一个**结果状态**，不是错误，也绝不是「同意」。
- **Consequences**：headless 场景下必须由人类跑 `approve`，多一步；
  换掉的是「静默跳过用户同意」这一类最坏失效。

### ADR-5 `--allow-unapproved` 保留但留痕
- **Context**：与既有 `--allow-empty-context` 对称，非交互场景需要出口。
- **Decision**：允许，但打警告 + 在 `task.json` 记 `started_without_approval: true`。
- **Consequences**：门可被绕过；但绕过会留痕，可事后发现。

### ADR-6 不做多选、不做 per-option 描述
- **Context**：Pi `select` 的签名限制（§2）。
- **Decision**：接受限制；需要说明时把描述拼进选项字符串；多选拆成多轮提问。
- **Consequences**：表达力弱于 Norma；但零自造 UI 代码，且随宿主升级自动受益。

---

## 10. 不做与已知限制

- **不做**：逐调用权限审批（`PERM` 域独立任务）、多选提问、plan 版本历史、批准的超时/过期。
- **已知限制**：
  1. 「问得够不够好」仍是 `E-P`（§1 R3）。
  2. 门不是安全边界（§8）。
  3. `--allow-unapproved` 是逃生口（ADR-5）。
  4. 非 TUI 场景必须人类跑一次 `approve`（ADR-4）。
  5. 批准后改 plan 必须重新批准（§7.3）——用户已知情接受。
  6. 与 `pi-mcp-adapter` 的 `tool-approval` 各自独立：本设计只拦「plan 批准」，
     不拦工具调用，两套不会互相触发。
