# research 写能力与并行守卫路径化

## Goal

让 `myflow-research` 能**自己把调查结论落盘**到当前任务的 `research/<topic>.md`，同时**不削弱**「一个工作树同时只有一个写者」这条不变量——做法是把守卫从 **agent 级**（"你能不能写"）改成 **路径级**（"你只能写在哪儿"）。

动机：`subagent.ts:593` 的写者守卫按 **agent** 判定，于是 `research` 为了保住并行能力**被迫放弃 `write`**，结论只能经 prompt 回传（子代理不继承父会话对话 → token 走两遍），且 `workflow.md` §1.2「persist findings to `research/<topic>.md`」的契约长期悬空。

本任务要把两头都拿到：**research 有 write 且能并行**，而写范围由**代码**兜住（严格于参考实现）。

## Requirements

1. **新增 frontmatter 声明 `writesUnder: <相对路径>`**（相对**活动任务目录**）。research 用 `writesUnder: research`。
   - `AgentConfig` 增加 `writesUnder?: string`；`agents.ts` 的 `parseSimpleYaml` 已支持该 YAML 子集，只需取值。
2. **放宽并行守卫**（`subagent.ts:593`）：仅当 agent **可写且未声明 `writesUnder`** 时拒绝 `mode: "parallel"`。
   - 错误信息须说明两条出路（改成单写者，或声明 `writesUnder`）。
3. **子代理进程内做路径约束**（`index.ts` 的 `tool_call` 钩子，`:340-341` 已有先例）：
   - 拦截 `write` / `edit`；目标路径解析后**必须位于 `<活动任务目录>/<writesUnder>/` 之内**，否则 block。
   - **fail closed**：无活动任务、未声明 `writesUnder`、或路径无法解析 → 一律 block。
   - 路径处理要在 Windows 上正确：`resolve`、`..` 归一、大小写不敏感、`/` 与 `\` 混用。
   - 需要把声明传给子进程：新增环境变量（如 `MYFLOW_WRITES_UNDER`），由 `subagent.ts` 与 `MYFLOW_AGENT_ENV` 一起注入。
4. **`.pi/agents/myflow-research.md`**：`tools: read, write, find, grep, ls`；加 `writesUnder: research`；正文写清契约：**每个调查主题必须各自落盘为 `research/<topic-slug>.md`；只许写这个目录**。
5. **同步所有陈述旧规则的文案**（不同步就是新的契约不一致）：
   - `.myflow/workflow.md:66-71`（Dispatch Protocol「parallel is for read-only work」）
   - `.pi/skills/myflow-meta/references/harness-conventions.md:60-63` 与 `:114-116`
   - `.pi/extensions/myflow/subagent.ts:15` 文件头注释、`:535` 工具描述、`:597` 错误信息
6. **测试**（`tests/`）：
   - `subagent.test.ts:311` 现断言 `isWriteCapable(research) === false` → 会因加 `write` 而崩，须更新为 `true`。
   - `subagent.test.ts:285`「parallel dispatch is rejected for write-capable agents」须改用**未声明 `writesUnder`** 的可写 agent，继续锁住拒绝路径。
   - **新增**：声明了 `writesUnder` 的可写 agent 允许 `mode: "parallel"`。
   - **新增**：路径约束——在 `research/` 内放行；`research/` 外（含 `../` 逃逸、绝对路径、大小写差异）一律 block；无活动任务时 block。
   - 如涉及 frontmatter 解析，补 `agents-commands.test.ts` 一条 `writesUnder` 解析断言。

## Acceptance Criteria

- [ ] `myflow-research` 的 frontmatter 为 `tools: read, write, find, grep, ls` + `writesUnder: research`。
- [ ] `mode: "parallel"` 对 `myflow-research` **不再抛错**；对一个未声明 `writesUnder` 的可写 agent **仍然抛错**。
- [ ] 子代理进程内，写到 `<活动任务>/research/` 之外被 block，且**有明确 reason**；无活动任务时 fail closed。
- [ ] Windows 路径边界有测试覆盖：`../` 逃逸、绝对路径、`\`/`/` 混用、大小写。
- [ ] `node --test tests/` 全绿。
- [ ] `workflow.md` 与 `harness-conventions.md` 的规则陈述与代码一致（不再说「parallel 只给只读」）。

## Definition of Done

- `node --test tests/` 全绿；改动仅限上述文件。
- 新规则在 `workflow.md` 与 `harness-conventions.md` 同步更新，且**不引入**与实现不符的措辞。
- 不改变 `myflow-implement` / `myflow-check` 的既有行为（它们不声明 `writesUnder`，仍串行）。

## Out of Scope

- 不引入 `bash` 给 research（否则路径约束有洞：`bash` 可写任意位置）。
- 不做「多写者写同一文件」的仲裁/锁；本任务的保证是**缩小爆炸半径**，不是事务隔离。
- 不建 `.myflow/config.yaml`（用户明确不需要）。`.myflow/spec/` **在本任务的 3.1 步由 `myflow-update-spec` 惰性创建**——本任务确实改了契约（`writesUnder` + 边界保证 + 并行规则），按项目惯例应落 spec。
- 不改其余 5 个 agent（`architect`/`reviewer`/`implement`/`check`）的工具白名单。

## Technical Notes

- 关键行号：`subagent.ts:151-163`（`WRITE_TOOLS` + `isWriteCapable`）、`:593`（并行拒绝）、`:409-410`（env 注入先例 `MYFLOW_AGENT_ENV`/`MYFLOW_CONTEXT_ENV`）、`:15`/`:535`/`:597`（文案）。
- `index.ts:340-341` 已有 `isSubAgent` + `tool_call` 拦截先例（递归守卫），路径约束挂同一处。
- `agents.ts:22-28` `AgentConfig`；`:64+` `parseSimpleYaml`（支持 plain/quoted scalar、逗号或 inline list、`|` 块标量）。
- **安全论证（须写进注释或文档）**：并行放行的前提是「同一 agent 的各并行 prompt 写**互不重叠**的文件」——代码无法验证重叠性，因此改为**把爆炸半径限制在一个目录内** + 要求每主题一文件。这是**边界**保证，不是**互斥**保证。
- 本任务的文件白名单声明在后文由 `implement.jsonl` 指向。

## 与本任务链的关系

- 解掉「research 不能 `write`」这一代码阻塞。落地后，研究分片可由 research 直接落盘，省掉两轮串行 implement 与一趟 token 往返。
