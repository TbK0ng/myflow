# T1 — Pi 侧反向覆盖（Pi 1.2.0 `docs/` 40 篇逐篇读完）

方法：自底向上重扫 `@earendil-works/pi-coding-agent/docs/`，未复用兄弟分片结论。规则见 `design.md` §2.2/§3/§5.1/§7.2。
版本 **[v1.2.0]**（`00-baseline.md` §1–2）；未用 `Desktop/pi`（1.0.4），无 `E5` 结论。

## 1. 逐篇清单（40/40）

1. **未归入现有 CAP** → 建议新域 `IPC`: `cli-integration` `rpc` `rpc-commands` `rpc-extension-ui` `json`；`CODE`: `codemode`；`PROMPT`: `prompt-templates`；`TUI`: `tui`；`CFG`: `configuration` `settings`；`TRUST`: `security`；`ENV`: `environment-variables` `shell-aliases` `windows` `terminal-setup` `termux` `tmux`；扩 `LLM-07`: `virtual-models`；**建议不建**: `containerization` `packages` `themes` `keybindings`；**无能力内容**: `index` `quickstart`
2. **部分归入**：`cli`(TOOL/CORE) `compaction`(CMPT) `custom-provider`(LLM) `extensions`(HOOK) `llama-cpp`(LLM) `mcp`(MCP) `models`(LLM) `sdk`(CORE) `session-format`(TRANS/CORE) `sessions`(CORE/TRANS) `slash-commands`(HOOK) `usage`(LOOP)
3. **明确归入既有 CAP**：`how-pi-works`(LOOP/CORE) `message-types`(CORE/TRANS) `providers`(LLM) `skills`(SKILL)

## 2. 「未归入任何 CAP」的能力（按重要度）

| # | 能力 | 证据 `[v1.2.0]` | 建议 | 与 myflow |
| --- | --- | --- | --- | --- |
| P1 | **project trust**：加载门禁、`trust.json`、`defaultProjectTrust`、`--approve` | `security.md:27-52` `:61-82` `how-pi-works.md:47-49` `cli.md:237-239` | 建 `TRUST`≥3 | **高**：myflow 资产全在 `.pi/`，拒信任即整体不加载；Pi **无内建工具审批**（`security.md:3`、`extensions.md:167-179` 仅示例）→ 该点由 `A-MF` 的 `tool_call` 守卫承担 |
| P2 | **环境契约**：`PI_*` 每命令启动时解析、`AI_AGENT=pi` 标记、shell 解析顺序、终端能力探测 | `environment-variables.md:22-50` `windows.md:19-25` `shell-aliases.md:9-25` `settings.md:137-143` `terminal-setup.md:171-190` | 建 `ENV`≥3 | **高**：`AGENTS.md` 依赖 `shellPath`；`PI_SESSION_ID` 形状/时机是 T3 输入 |
| P3 | **进程集成协议**：Print/JSON/RPC 四模式 + `RpcClient` + 事件流重建 + SDK 嵌入 | `cli-integration.md:10-22` `:32-56` `json.md:8-30` `rpc.md:16-30` `sdk.md:6-31` | 建 `IPC`≥3 | 中：myflow 仅 TUI；RPC/JSON 是无人值守通道（P2） |
| P4 | **codemode 沙箱**：QuickJS 内 `tools.<n>()`、`Promise.allSettled`、`store/load`、`searchTools`、`models.classify/generateImages` | `cli.md:155-156` `codemode.md:5-40` `:54-60` `:97-150` `extensions.md:181-186` | 建 `CODE`≥3 | 中高：可替代 myflow 自建批量取数/过滤 |
| P5 | **非 LLM 模型 + 请求级路由 + prompt cache** | `models.md:94-100` `:130-200` `virtual-models.md:37` `:93-110` `settings.md:21` | 扩 `LLM-06..08` | 低：宿主已给，非缺口 |
| P6 | **会话树与分支**：`/tree`·`/fork`·`/clone`、`label`、`branch_summary`、`get_tree`/`get_entries` 游标 | `sessions.md:20-40` `:56-70` `session-format.md:189-200` `:226-240` `rpc-commands.md`(get_entries/get_tree) | 建 `SESS` 或扩 CORE/TRANS | **高**：myflow 任务指针/会话键派生建立在会话身份上；树与恢复语义是 T3 的外部条件 |
| P7 | **上下文文件与提示词装配**：`AGENTS.md` 祖先链、`SYSTEM.md` 替换、`APPEND_SYSTEM.md` 追加、模板参数 | `configuration.md:41-52` `:17-39` `prompt-templates.md:8-18` `:28-45` | 建 `PROMPT`≥2 | 中高：myflow 已用 `.pi/prompts/`3 个与 AGENTS.md；**未用** `SYSTEM.md`/`APPEND_SYSTEM.md` 与参数语法 |
| P8 | **队列与续跑边界**：steering/follow-up 双队列、`queue_update`、`agent_end` vs `agent_settled`、`agent_before_settle` 单次续跑 | `usage.md:30-40` `settings.md:31-32` `extensions.md:63-67` `:118` `json.md:121` `cli-integration.md:50` | 扩 `LOOP-07` | 中高：myflow **已用** `agent_before_settle` 做 verify gate（`index.ts:464`，`E-C`），**未用**队列 |
| P9 | **扩展点分类学与工具可见性**：`register*` 8 类、`exposure` 五档、`prepareLoadout`、`reachesTools`、`ctx.executeTool` 嵌套 | `extensions.md:72-85` `:149` `:153-186` `:215` | 扩 `HOOK-05/06` | 中：myflow 仅用 `registerTool`/`registerCommand`/`on()` |
| P10 | **写并发原语** `withFileMutationQueue()` | `extensions.md:144` | 扩 `TOOL-07` | 中：myflow 靠 dispatch 拒绝写者并行（`E-C`），此为第二层 |
| P11 | **append-only 上下文编辑** `context_edit`（不改原始记录、分支相对） | `session-format.md:139-160` `:235` `compaction.md:98` | 扩 `CMPT-06` | 中高：myflow **未用**；比「每回合重注入」更强的压缩存活手段 |
| P12 | **用量/成本账目**：`get_session_stats`、`UsageEntry`、`/session`、footer context usage | `rpc-commands.md:526-560` `session-format.md:113-128` `usage.md:6` | 扩 `OBS-03` | 中：`/myflow-status` 不报 context/cost 用量 |
| P13 | **TUI 组件与 `ctx.ui`**：`select/confirm/input/editor`、`setStatus/setWidget`、`custom()`、`pi-tui` | `tui.md:8-64` `rpc-extension-ui.md:3-30` | 建 `TUI`(P2) 或扩 `OBS` | 中：myflow 仅用 `ctx.ui.notify`（`index.ts:269`） |
| P14 | **MCP HTTP/OAuth/resources/exposure** | `mcp.md:115` `:189` `:236` `:250-254` | 扩 `MCP-04..05` | 低中：本机 `mcp.json` 仅 stdio |

不建独立域（并入既有域语料）：`SANDBOX` `DIST` 与 TUI 主题/键位、`CFG`/`OPS` 纯清单（见 §1）。

## 3. (NEG) 负向断言块

**NEG-1 无内建子代理/代理派生** ——【C1 裁决：部分】
语料=`docs/*.md`(40)｜检索式=`sub-?agent|spawn|parallel agent|teammate|orchestrat|swarm|multi-agent`(i)
命中=原声明 0 不实：`spawn` 命中 `environment-variables.md:53,57,64,69`（`spawnHook` = **进程** spawn 钩子，非代理）；
  `orchestrat` 仅 `extensions.md:158,181`（指编排**工具**）；`swarm|teammate|consensus` → 0
修正后的结论=「无内建子代理」成立；「命中=0」不实，`spawnHook` 本应列入并以「非代理」显式排除
残余风险=以「nested model call」措辞描述代理（`extensions.md:137,215`、`sdk.md:8,28`）→ 只能断言「无内建子代理能力」，不得断言「Pi 无法实现」。

**NEG-2 docs 无 plan mode**
语料同上｜检索式=`plan mode|plan-mode|planner|\bplan\b`(i)
命中=`virtual-models.md:93,98,99`（示例路由阶段名）、`providers.md:46-65`（ZAI 套餐名），均非 plan mode
结论=docs 不覆盖；唯一原文在包根 `README.md:19`，`O-2` 判定须引 README，**不得**引 `docs/`。

**NEG-3 无内建工具审批/permission 系统**
语料同上｜检索式=`permission|allow/deny|permissionMode|approve|confirm before`(i)
命中=`security.md:3`（明示「does not ask for approval before every tool call」）、`extensions.md:167-179`（**示例**扩展）、`mcp.md:252-254`、`skills.md:78`（`allowed-tools` 实验）、`cli.md:237-239`（`--approve`=项目信任开关）
残余风险=`defaultTools`/`--exclude-tools` 是**声明层**限制，不等于逐调用审批。

**NEG-4 docs 无 noa 式分层/ref/nudge 压缩**
语料同上｜检索式=`m00001|ref tag|content hash|\btier\b|nudge`
命中=`models.md:94,100`、`custom-provider.md:95`（promptCache「retention tier」，非上下文分层）
残余风险=`compaction.md` 的 cut point/`firstKeptEntryId`/split user-span 功能上部分替代分层 → 判 `V-GAP` 前须做机制对照。

## 4. docs 与 README 的覆盖差

| 主题 | 包根 `README.md` | `docs/` |
| --- | --- | --- |
| 「skips features like sub-agents and plan mode」 | **有** `:19` | **无**（NEG-1/2）→ `O-2` 唯一权威原文在 README，是 **docs 覆盖缺口** |
| 「minimal, extensible agent harness」 | `:13` | `index.md:3` 仅「extensible AI agent」，**无** minimal/skips 语义 |
| OpenClaw 集成、`pi-share-hf` 分享 | `:21` `:46-60` | 无（`/share` 见 `sessions.md:56`，无 HF 路径） |
| 开发流程：`pi-test.sh`、`npm run check`、`CONTRIBUTING.md`、Nix 安装 | `:66-84` `:40` | 仅 Nix 见 `quickstart.md:11-25` |
| myflow `AGENTS.md` 的 Pi 行为断言 | — | 均有支撑：`shell-aliases.md` `windows.md:19-25` `settings.md:137` `environment-variables.md:22-50` |

## 5. 自我声明

- **全文读完 40/40**（含 13 篇 W1 未点名者）；`docs.json` 导航亦读，页清单一致。§1「部分」指该篇能力跨多域，非未读。
- **未读**：`docs/images/*`（截图）、`examples/**`（示例代码；按 `00-baseline.md` §5 不作能力主证据）、`schemas/*`（字段校验，与能力无关）。
- **未验证**：Pi 未来版本行为；是否存在已实现但未文档化的能力。「Pi 有」均为 `E1` 正向命中；「Pi 无」均走 §3 `NEG` 并声明残余风险。
- 「与 myflow」列的 myflow 侧取证为本次自查 `.pi/extensions/myflow/index.ts`，**不构成** T2 的强制层级判定。
