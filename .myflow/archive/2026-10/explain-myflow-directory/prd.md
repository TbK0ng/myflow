# 解释 .myflow 独立目录的设计

## Goal

基于当前仓库说明为什么将工作流文件集中在 `.myflow/`，以及为什么不与 `.pi/` 或业务代码混放。

## Requirements

- 解释 `.pi/` 与 `.myflow/` 的职责边界。
- 区分目录布局的实际机制与设计取舍推断，不把推断说成历史事实。
- 说明集中管理、项目级持久化和复制安装的收益，以及额外目录和路径耦合的代价。

## Acceptance Criteria

- [ ] 给出有当前文档与代码依据的中文解释。
- [ ] 明确独立目录是组织选择，不是不可替代的技术要求。

## Definition of Done

- 核对相关路径与实现；仅作解释，不修改实现、不运行开发生命周期。

## Out of Scope

- 迁移、合并目录或重构 harness。
- 外部工具选型与跨平台框架设计。

## Findings

- `.pi/` 承载 Pi 的接入层：extension、agent、prompt、skill；`.myflow/` 集中工作流规则、脚本、项目规范、任务档案及运行态。此划分是职责边界，不是完全的可复制文件/项目文件边界。
- `.myflow/` 内仍有两类文件：workflow/scripts/agents 属于可复制 payload；spec/config/worktree/tasks/archive 属于项目，runtime 属于机器运行态。
- `findProjectRoot` 从工作目录向上寻找 `.myflow/workflow.md`，因此目录目前还承担项目定位职责。命名可重新设计，但不是直接移动目录就能保持兼容。
- `.gitignore` 忽略 `.myflow/.runtime/`；规范要求任务和归档与代码一起提交，因此集中管理不意味着全部提交或全部忽略。
- 收益是集中工作流资产、避免业务目录散落、把持久项目知识和会话运行态区分开；代价是多一层目录及多处路径契约。以上收益属于基于实现的设计解释，不宣称已经核实最初作者动机。

## Follow-up: codebase-memory-mcp

- 用户追问是否提到 codebase MCP，以及是否可选。
- `.pi/skills/myflow-spec-bootstrap/SKILL.md` 将 codebase-memory 列为优先分析工具；其 `references/mcp-setup.md` 明确写明 “tool choice, not a requirement”，不可用时回退 read/grep/find。
- MCP 需要在运行环境中另行安装配置并让工具可见；复制 myflow 文件不等于安装 MCP。
- 当前 `.pi/agents/myflow-research.md` 工具白名单只有 read/find/grep/ls；主会话可用 MCP 不代表每个子代理自动可用。
- 本机用户级 AGENTS.md 的图优先指令属于额外环境指令，应与 myflow 自身的可选依赖区别开。
- 上述三条仓库证据路径已覆盖检查并直接读取核实。

## Requested local MCP operations

- 用户明确要求索引当前目录，并从今以后默认关闭图形界面、开启 autoindex。
- 已调用 index_repository(repo_path=C:/Users/wocai/Desktop/myflow, name=myflow, mode=full, persistence=true)。结果为 ready，689 节点、1714 边，generation 2026-10-14T02:04:01Z，生成 `.codebase-memory/graph.db.zst`。
- 仅排除 `.git` 与 `.myflow/.runtime`；未报告 skipped、partial、unusable 或未索引文件。
- 通过已安装 v0.11.0 CLI 的 config set 持久设置 ui_enabled=false、auto_index=true，并用 config list 验证。auto_watch=true、watcher_enabled=true 保持不变，auto_index_limit=50000。
- CLI 提示 ui_enabled 更改需要重启 daemon 才生效；尚未重启运行中的后台服务，不声称当前 UI 已停止监听。
- 该变更属于用户明确授权的本机工具配置操作，不是 myflow 实现改动。没有改 MCP 必需依赖或执行代码开发流程。
- 参考 Context7 `/deusdata/codebase-memory-mcp` 配置文档，并以当前安装版本的 CLI 帮助和回读值为准。

## Technical Notes

- 核对来源：`.pi/skills/myflow-meta/SKILL.md`、`.pi/skills/myflow-meta/references/harness-conventions.md`、`.pi/extensions/myflow/find-project-root.ts`、`.gitignore`。
- 图项目 `myflow`，generation `2026-10-13T21:35:00Z`；候选路径覆盖检查为 metadata_changed，已直接读取上述文件核实；未做全仓审计。
- 用户已同意创建任务；任务保持 planning，尚未批准任何实现工作。
