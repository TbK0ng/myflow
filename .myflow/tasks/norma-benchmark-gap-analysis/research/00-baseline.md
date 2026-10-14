# 00 — 基线冻结（P0）

> 取证时间：本任务 P0 阶段（主会话直接执行命令）。
> 本文是后续所有「Pi 侧 / Norma 侧 / myflow 侧」判定的版本锚点。任何分片若与本文件版本不一致，
> 以本文件为准并立即报告。

## 1. 版本自证（`E0`）

| 项 | 实测值 |
| --- | --- |
| `pi --version` | **1.2.0** |
| `PI_CODING_AGENT` | 存在（值不落盘） |
| `PI_SESSION_ID` | 存在（值不落盘；仅记录**形状** = 会话唯一标识） |
| `PI_SESSION_FILE` | 存在（`…/.pi/agent/sessions/--C--Users-wocai-Desktop-myflow--/<ts>_<sessionid>.jsonl`） |
| `PI_PROVIDER` | 存在 |
| `PI_MODEL` | 存在 |
| `PI_REASONING_LEVEL` | 存在 |

**推断（`E5`，标为未验证）**：`PI_SESSION_ID` 的形状与 `PI_SESSION_FILE` 文件名中的会话 id 一致；
myflow 侧凭此派生上下文键（见 `T3` 分片）。本处**不作断言**，交由 `T3` 取证。

## 2. Pi 权威面清点（`E1`）

安装根：`C:/Users/wocai/.bun/install/global/node_modules/@earendil-works/`

| 包 | 版本 |
| --- | --- |
| `pi-coding-agent` | 1.2.0 |
| `pi-agent-core` | 1.2.0 |
| `pi-ai` | 1.2.0 |
| `pi-mcp` | 1.2.0 |
| `pi-codemode` | 1.2.0 |
| `pi-telemetry` | 1.2.0 |
| `pi-tui` | 1.2.0 |
| `chord` | 1.1.0 |

`pi-coding-agent/` 根目录：`CHANGELOG.md`、`README.md`、`dist/`、`docs/`、`examples/`、`package.json`、`schemas/`。

**`docs/` 实际清单 = 40 个 `.md` + `docs.json` + `images/`**（PRD 起草时写的「41 篇」应为 40 篇 `.md`，此处更正）：

```
cli-integration.md  cli.md             codemode.md        compaction.md
configuration.md    containerization.md custom-provider.md environment-variables.md
extensions.md       how-pi-works.md    index.md           json.md
keybindings.md      llama-cpp.md       mcp.md             message-types.md
models.md           packages.md        prompt-templates.md providers.md
quickstart.md       rpc-commands.md    rpc-extension-ui.md rpc.md
sdk.md              security.md        session-format.md  sessions.md
settings.md         shell-aliases.md   skills.md          slash-commands.md
terminal-setup.md   termux.md          themes.md          tmux.md
tui.md              usage.md           virtual-models.md  windows.md
```

**W1 八片已点名其中 27 篇；未点名 13 篇**（`cli-integration`、`configuration`、`containerization`、
`environment-variables`、`index`、`quickstart`、`rpc-extension-ui`、`shell-aliases`、`terminal-setup`、
`termux`、`tmux`、`tui`、`windows`）→ 由 `T1-pi-surface` 反向覆盖，**不得**默认它们是无关文档。

Pi 源码工作区（**非本次权威面**）：`Desktop/pi/packages/coding-agent/package.json` = **1.0.4**，
落后于运行时 1.2.0 → 依其为据的结论一律 `E5` 推断。

## 3. 归属域清点（`E0`，design.md §2.2）

### 3.1 `~/.pi/agent/` 顶层

`bin/`、`extensions/`、`npm/`、`patches/`、`sessions/`、`skills/`、`AGENTS.md`、`auth.json`、
`mcp-adapter.json`、`mcp-cache.json`、`mcp-npx-cache.json`、`mcp-onboarding.json`、
`mcp-project-approvals.json`、`mcp.json`、`models-store.json`、`models.json`、`open-tui.json`、
`settings.json`、`settings.json.bak-git-consolidation`、`trust.json`

### 3.2 `A-EXT` 扩展文件

| 路径 | 大小 |
| --- | --- |
| `~/.pi/agent/extensions/cbmem.ts` | 26.2K |
| `~/.pi/agent/extensions/rtk.ts` | 4.7K |

### 3.3 `A-EXT` 用户级 npm 包（**顶层直接依赖**，非传递依赖）

`pi-subagents-lite`、`pi-rounded-tools`、`pi-agent-loop`、`pi-ask-side`、`pi-mcp-adapter`、
`pi-open-tui`、`pi-tui-commands`、`@firstpick/pi-themes-bundle`、`@upstash/context7-pi`、
`@typesafe-ai/sdk`、`@modelcontextprotocol/*`、`@vectorize-io/*`、`@luxusai/*`

（同目录其余条目如 `ajv`、`zod`、`undici`、`jose`、`open`、`cross-spawn`、`wsl-utils` 等为**传递依赖**，
不算能力提供者，但 `wsl-utils`/`is-wsl` 的存在提示某扩展探测 WSL——与本机「无 WSL」的约束相关，
不影响能力判定。）

### 3.4 `A-EXT` 技能

| 名称 | 类型 |
| --- | --- |
| `codebase-memory` | 实目录 |
| `agent-browser` | symlink → `C:/Users/wocai/.cc-switch/skills/agent-browser` |
| `find-skills` | symlink → `C:/Users/wocai/.cc-switch/skills/find-skills` |

### 3.5 `A-MCP`

`~/.pi/agent/mcp.json`：

```json
{ "mcpServers": { "codebase-memory-mcp": {
    "type": "stdio",
    "command": "C:/Users/wocai/.local/bin/codebase-memory-mcp.exe",
    "enabled": true } } }
```

### 3.6 `settings.json` 键

`compaction`、`defaultModel`、`defaultProvider`、`defaultThinkingLevel`、`defaultTools`、
`extensions`（= `["-builtin:mcp"]`）、`lastChangelogVersion`、`packages`、`shellPath`。

**注意**：`extensions: ["-builtin:mcp"]` 意味着内建 MCP 被**显式关闭**，改由 `pi-mcp-adapter`
（`A-EXT`）接管 → 这是 `MCP` 域归属判定里最容易搞错的一条，必须单独取证。

### 3.7 工具归属（**必须核对，勿凭印象**）

| 工具 | 声称归属 | 待核对 |
| --- | --- | --- |
| `myflow_subagent` | `A-MF` | `.pi/extensions/myflow/subagent.ts` |
| `Agent` / `StopAgent` / `MessageAgent` / `AgentStatus` | `A-EXT:pi-subagents-lite` | 读该包导出 |
| MCP 代理工具（`mcp`、`mcp__*`） | `A-EXT:pi-mcp-adapter` | 读该包导出 |
| `read/write/edit/bash/grep/find/ls` | `A-PI`（core 工具集） | 对 Pi `docs/extensions.md` §Tools |

**本表是待核对清单，不是结论**。分片必须给出注册者证据。

## 4. 仓库基线

| 项 | 值 |
| --- | --- |
| myflow HEAD | `0a702fa6cc26807480b6cb2174f60105beb16fd4`（短 `0a702fa`） |
| myflow 分支 | `main` |
| myflow 工作树 | 仅 `.myflow/tasks/norma-benchmark-gap-analysis/` 下 4 个文件被修改（本任务 artifact） |
| Norma HEAD | `52f17dd52d95b087265e5d5b306fe85c1ea05599`（短 `52f17dd`，2026-10-11，`docs: add Apache-2.0 LICENSE`） |
| Norma 分支 | `main` |

## 5. Norma 语料清单（16 个实现包 + 2 个非包目录）

| 目录 | 非测试文件 | 测试文件 | 是否在 README「Packages」表 |
| --- | --- | --- | --- |
| `llm` | 12 | 12 | ✅ |
| `tool` | 27 | 10 | ✅ |
| `permission` | 1 | 1 | ✅ |
| `harness` | 4 | 13 | ✅ |
| `compaction` | 2 | 9 | ✅ |
| `hook` | 1 | 1 | ✅ |
| `subagent` | 1 | 1 | ✅ |
| `mcp` | 2 | 1 | ✅ |
| `plan` | 1 | 1 | ✅ |
| `memory` | 3 | 1 | ✅ |
| `skill` | 1 | 2 | ✅ |
| `coordinator` | 1 | 1 | ✅ |
| `agentcore` | 1 | 7 | ✅ |
| **`noa`** | **29** | **22** | ❌ **README 未列** |
| **`noaadapter`** | **13** | **15** | ❌ **README 未列** |
| **`transcript`** | **2** | **1** | ❌ **README 未列** |
| `examples` | 6 | 0 | 非包（示例） |
| `cmd` | 1 | 0 | 非包（CLI 入口） |
| **合计** | **108** | **98** | — |

**本次不审计**：`examples/`、`cmd/`（非能力提供者，仅装配示例；如某能力仅在 examples 中出现，
分片可提一句，但**不得**作为「Norma 有此能力」的主证据）。理由：判定对象是**可复用能力**，
不是示例的演示代码。

## 6. 注入预算基线（Step 1.3 用）

```
prd.md      20,835 B
design.md   24,575 B
implement.md 19,751 B
------------------------------
合计        65,161 B  (≈63.6 KiB)
总上限     131,072 B  (128 KiB)
每次 dispatch 可用余量 ≈ 65,911 B (≈64.4 KiB)
```

据此，`implement.jsonl` 策展 5 条（≤ 30 KiB）、`check.jsonl` 策展 8 条（≤ 48 KiB），
每个分片 ≤ 6 KiB。超限时的降级顺序见 `implement.md` §6。

## 7. 本文件的取证边界

- **全量**：`pi --version`、`@earendil-works/*` 版本、`docs/` 文件名清单、`~/.pi/agent/` 顶层清单、
  `extensions/` `skills/` `npm/node_modules/` 顶层清单、`mcp.json`、`settings.json` 键名、
  两个仓库的 HEAD、Norma 逐目录文件计数、三份 artifact 的字节数。
- **抽样**：无（本文件只做清点，不做机制判定）。
- **未做**：未核对任何工具的注册者（§3.7 是待核对清单）；未读任何 `docs/*.md` 正文；
  未读 any `noa`/`noaadapter` 正文（除 PRD 记录的抽样抽读）。
