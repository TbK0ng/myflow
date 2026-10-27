---
title: 最锋利的三处
---

# 最锋利的三处

[缺陷登记表](./defects.md) 有 26 行。这里只挑三行，判据不是「最严重」，而是「最能说明这套东西真实状态」：一条守卫被一整类进程绕过、一条路径被测试认证却没人生产、一条规则被自己的代码违反了两行。三条都不是我猜的，每一条都能用 `路径` 加符号名复现。

## 一、channel worker 绕过了所有「仅主会话」守卫

**现象。** `.myflow/scripts/channel.py` 起 worker 时拼的命令是 `pi -p --approve --append-system-prompt <definition>`，环境变量只加 `MYFLOW_SKIP_BREADCRUMB=1`，`reviewer` 再加 `MYFLOW_VERIFY_GATE=1`。它从不设 `MYFLOW_AGENT_TYPE`。而 `.pi/extensions/myflow/index.ts` 的 `detectAgentType()` 只认这一个变量，`isSubAgent = agentType !== null`。于是 `/tool_call` 里那四道守卫——递归派发、`myflow_ask_user` / `myflow_request_approval`、四个 `myflow_bg_*`、`writesUnder` 路径检查——全部走 `if (!isSubAgent) return;`。这个 worker 在扩展眼里是主会话：能派子代理、能起后台任务、能写到树里任何地方。

**为什么它不是小问题。** 它破坏的是 `.myflow/workflow.md` 的 Dispatch Protocol 里写下的那句话：*只有主会话可以派发*，子代理必须"报告建议"而不是自己再派。这句话的实现方式是两层：agent 定义的 allowlist 里不写这些工具，加上 `tool_call` 的守卫作为第二道。channel worker 用的是 `.myflow/agents/*.md`，那两个定义的 frontmatter 里根本没有工具 allowlist，也不带 `writesUnder`；第二道守卫又因为缺少一个环境变量而整类失效。承诺的两层同时不存在，而文档没有一处提到这件事。

**修它要付什么。** 加一行 `MYFLOW_AGENT_TYPE` 看起来是一分钟的事，其实不是：一旦 worker 被当成子代理，`writesUnder` 守卫生效，而 worker 没有声明作用域，于是它每次 `write` / `edit` 都被拒绝——可 `reviewer` 的职责就是"在任务范围内直接修"。所以真实的选择只有两个：给 channel agent 加上作用域、并教会 Python 启动器读 frontmatter 再注入 `MYFLOW_WRITES_UNDER`（等于把 transport 的环境注入逻辑在第二种语言里再写一遍），或者承认 channel 这条并行路径没有独立的守卫模型、直接删掉它。前者是新增一套跨语言契约，后者是删掉一个功能。这才是它一直没被修的原因。

## 二、`completed` 是一条被测试认证、却没有任何东西会产出的路径

**现象。** `.myflow/workflow.md` 里的 `[workflow-state:completed]` 块带着两条收尾指令：提交（步骤 3.2）和 `/myflow-finish-work`（步骤 3.3）。`tests/workflow-invariant.test.ts` 用 `PHASE_BLOCK` 把步骤 3 映射到 `completed`，用 `ENFORCEMENT` 断言那块文本里必须出现 `/commit/i` 和 `/myflow-finish-work/`。而 `.myflow/scripts/task.py` 只写三个状态：`create` 写 `planning`，`start` 写 `in_progress`，`archive` 写 `completed`——写完同一个函数里立刻 `shutil.move` 进 `.myflow/archive/<YYYY-MM>/` 并清空会话指针。也就是说，`[workflow-state:completed]` 从来没有机会被注入：它需要的「状态是 `completed`、任务还在 `tasks/` 里」这个组合，没有任何代码会生产。`status.ts` 的 `phaseForStatus` 至今还把历史状态 `done` 映射过去，`.pi/prompts/myflow-continue.md` 的阶段表也仍然把 `completed` 列成「仍在 `tasks/`」。

**为什么它不是小问题。** 这个项目把「用测试钉住文档」当成对抗漂移的主要机制（`doc-numbers`、`scaffold`、`skills-hygiene` 都是同一招）。这一条恰好是那招的反例：测试是绿的，被认证的路径是死的。更贵的是它挡住了什么——一条本该走向「提交并归档」的会话，拿到的仍然是 `in_progress` 块，收尾指令从没出现在它眼前。绿灯在这里不是证据，是替代品。

**修它要付什么。** 两条路都要动设计。删：删块、删 `phaseForStatus` 里的映射、删 `PHASE_BLOCK` 里那一项，同时承认少一张漂移网；或者让 `finish` 写 `completed`（现在它只清指针、不改状态），把收尾拆成「标记完成」和「归档」两步——但那等于把一个已经删掉的 `done` 状态以另一个名字请回来，而删掉 `done` 正是 0.3.0 明确做过的决定。要么承认这条块是遗留物，要么承认状态集少一个；两者都不能靠改一行修好。

## 三、`board/render.ts` 里有两行中文 UI 文案

**现象。** `.pi/extensions/myflow/board/render.ts` 的 `sectionTitle` 调用点里有 `… · detached · 终端退出后仍在运行`，两个视图各一处。`.myflow/spec/harness/index.md` 的 Quality Check 第一条写着：*没有任何 shipped file（扩展、脚本、文档、skill）含有非英文散文或面向用户的文本；测试文件是唯一例外。*

**为什么它不是小问题。** 这条规则是仓库里唯一一条覆盖**全部**发布文本的规则，而它靠人工勾选。仓库为其它三类漂移各写了一个测试，唯独这条没有，所以它漏了——漏得还很典型：正是那种「扫一眼就过」的检查项最容易漏。附带一个我没测但很可能存在的代价：面板宽度计算依赖注入的 `truncate`，中文全角字符的显示宽度不等于字符数，标题栏会错位。

**修它要付什么。** 改两行字是一分钟。真正的价钱是把它变成机制：一个扫描 shipped tree 非 ASCII 字符的测试。而这个测试会立刻撞上自己的 UI——同一份 `render.ts` 里的状态图标 `▶` / `✓` / `✗` / `⏱` 都是非 ASCII。要么给符号开白名单（白名单就是下一个会腐烂的清单），要么把规则从「字符集」改写成「不得含 CJK」——后者能被绕过，但至少能抓住这一类。

---

这三条加起来是这本书不是营销材料的证明：一条守卫被一整类进程绕过、一条路径被测试认证却没有生产者、一条规则被自己的代码违反。它们都不大，但都不是能被「已修复」一句话盖住的。
