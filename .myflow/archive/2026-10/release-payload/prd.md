# prd: release packaging — 可完全迁移的 myflow payload

## Goal

把 myflow 打包成"可以完全迁移到其他项目的初始状态"：一个**纯 payload 目录** + **zip** +
**INSTALL.md** + **可重复的打包脚本**，并打 `v0.2.0` 标签推送。

用户选择：**选项 1**（全做：目录 + zip + INSTALL + release.py + tag）。

## 已定决策（Q1，用户选 A）

**payload 清单只有一个来源**：抽出 `tools/release-payload.json`，`tests/scaffold.test.ts` 与
`tools/release.py` 都读它。代价是要改一个既有守卫测试；收益是"加/删一个 payload 文件只改一处"。

## Payload 的定义（现状取证）

`tests/scaffold.test.ts` 已经把 payload 写死为：

```
.pi/                    （扩展 + 3 agents + 3 prompts + 8 skills）
.myflow/scripts/        （task.py / get_context.py / worktree.py / channel.py / bg_runner.mjs）
.myflow/agents/         （architect.md / reviewer.md）
.myflow/workflow.md
```

**不属于 payload**：`.myflow/spec/`（项目自有约定）、`tasks/`、`archive/`、`.runtime/`、
`tests/`、`package.json`、`tsconfig.json`、`tools/`（本任务新增的打包机器）、`.git*`。

## Requirements

### R1 单一清单
- 新增 `tools/release-payload.json`：`dirs` / `trees` / `files` / `exclude` 四个字段。
- `tests/scaffold.test.ts` 的 `PAYLOAD_DIRS`/`PAYLOAD_TREES`/`PAYLOAD_FILES` 改为读该文件，
  **行为不变、断言不变**（既有 354 条中的 scaffold 用例必须原样通过）。
- `tools/release.py` 读同一文件，**不得**内置第二份清单。

### R2 打包脚本（`tools/release.py`，Python 3 标准库）
- `--check`：只校验，不产出。检查清单条目都存在、`exclude` 生效、payload 里没有**本机绝对路径**
  （`C:\Users\`、`C:/Users/`、`/Users/`、`/home/`）、没有项目自有目录（`spec/tasks/archive/.runtime/tests/tools`）。
- `--out <dir>`（默认 `dist/`）：产出 `dist/myflow-<version>/`：
  - 按清单复制 payload（应用 `exclude`：`__pycache__/`、`*.pyc`、`.DS_Store`、`*.tmp`、`*.log`）
  - 追加 `INSTALL.md`（来自 `tools/INSTALL.md`）与 `RELEASE.md`（版本、源提交、构建时间、文件数、逐目录文件数）
  - 打 `dist/myflow-<version>.zip`，**顶层带 `myflow-<version>/` 前缀**，条目时间戳固定（可重复构建）
- `--verify`：在一个**临时项目目录**里展开产出的 payload，跑冒烟：
  ① `node` 动态 import `dist` 里的扩展、注册到假 API → 断言 8 个 hook + 四个 `myflow_bg_*` 工具 + `/myflow-status`；
  ② `python .myflow/scripts/task.py current` → `no active task`；
  ③ `python .myflow/scripts/get_context.py` → 含 `[workflow-state:no_task]` 与 `## Session Runtime Context`。
  失败即非零退出。
- 版本号来自 `package.json`（本任务升到 `0.2.0`）。

### R3 安装文档与忽略项
- `tools/INSTALL.md`：复制哪些文件、Pi 里如何启用扩展（与本仓库一致的方式）、
  `.gitignore` 需要哪些行（`.myflow/.runtime/`、`dist/` 等）、首次冒烟命令、以及**不要**复制什么。
- `.gitignore` 增加 `dist/`。
- 文档同步：`.pi/skills/myflow-meta/references/harness-conventions.md` 的 payload 段落写明
  **`tools/` 属 harness 开发、manifest 是唯一清单来源**；`myflow-meta/SKILL.md` 的 layout 增 `tools/`。

### R4 产出与发版
- `package.json` 版本升到 `0.2.0`。
- 构建 `dist/myflow-0.2.0/` 与 `.zip`，跑 `--verify`。
- 打注释标签 `v0.2.0`（指向包含产物的提交；产物本身 **不进 git**，`dist/` 被忽略），推送 `main` 与标签。

## Acceptance Criteria

- [ ] `tools/release-payload.json` 存在，且 `tests/scaffold.test.ts` 与 `tools/release.py` **都只读它**（grep 无第二份清单）。
- [ ] 改清单加一个文件 → 打包会包含它、scaffold 测试也会覆盖它（一处定义生效）。
- [ ] `python tools/release.py --check` 在干净仓库上退出 0；若 payload 里塞进一个 `C:/Users/...` 绝对路径则退出非 0（用例锁定）。
- [ ] `dist/myflow-0.2.0/` 里**没有** `spec/`、`tasks/`、`archive/`、`.runtime/`、`tests/`、`tools/`、`__pycache__`。
- [ ] zip 解压后顶层是 `myflow-0.2.0/`；两次构建的 zip **字节一致**（可重复）。
- [ ] `--verify` 在临时目录里通过（8 hooks、四个 bg 工具、`task.py current`、`get_context.py`）。
- [ ] `v0.2.0` 标签推送成功，且 `git status` 干净（`dist/` 被忽略）。
- [ ] 全量测试绿（354 + 新增）；每个工作项单独一次提交。

## 不做

- 不做 npm 发布 / PyPI 发布（这是仓库内产物，不是包管理器分发）。
- 不做自动更新、版本兼容矩阵、迁移旧项目（只保证"新的初始状态"）。
- 不把 `tests/` 打进 release（选项 1 的默认；要改 harness 时从本仓库取）。
- 不移动已有的 `0.1.0` 标签（新版本另起 `v0.2.0`）。

## 风险

| 风险 | 缓解 |
| --- | --- |
| 改 `scaffold.test.ts` 的清单来源，可能削弱那个守卫 | 只改"清单从哪读"，断言与复制逻辑不变；用例本身仍要求"每个 payload 文件存在且自包含" |
| 脚本把 `dist/` 当成 payload 递归复制 | 明确排除 `dist/`；`--check` 校验排除项 |
| Windows 上 zip 路径分隔符混用（`\` vs `/`） | Python `zipfile` 写入时统一 `ZipInfo` 用 `/`；用例断言解压路径 |
| 打包把本机绝对路径带出去 | `--check` 扫描；命中即失败 |
