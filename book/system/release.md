---
title: 发布载荷与安装
---

# 发布载荷与安装

## 职责

`tools/release.py` 做两件事：把 `.pi/` 和 `.myflow/` 打成一个可复制的目录，然后**证明它能起来**。它不发 npm 包，不做版本化 API，也不管升级。发布物是一个目录加一个可复现的 zip，装的人解压、复制、改一处配置。

## 触发点

只有人手动跑，没有 CI 自动发布，也没有 tag 监听。

| 命令 | 做什么 |
| --- | --- |
| `--check` | 只校验 manifest 与载荷，不产出任何文件 |
| `--out OUTDIR` | 生成 `OUTDIR/myflow-<version>/` 与同名 `.zip`（`OUTDIR` 默认 `dist`） |
| `--verify` | 解压到临时项目并跑六项冒烟检查；**必须**和 `--out` 一起用 |
| `--release {patch\|minor\|major}` | 改版本、写 CHANGELOG、check、build、verify、commit、打 tag；只有 `--yes` 才推送 |
| `--dry-run` | 配 `--release`，打印计划，不写任何东西 |

互斥关系由脚本自己拒绝：`--release` 不能和 `--check` / `--out` / `--verify` 同用，`--yes` 与 `--dry-run` 同时出现直接报错。版本号只有一个来源：`package.json`（现在是 `0.3.0`）。

## 读写哪些文件

| 文件 | 角色 |
| --- | --- |
| `tools/release-payload.json` | **唯一**的载荷清单：`dirs: [".pi", ".myflow"]`、`trees: []`、`files: []` 加一份排除表 |
| `tools/release.py` | 读清单、构建、校验、发布 |
| `tools/INSTALL.md` | 逐字拷进每个发布物的安装说明 |
| `dist/myflow-<version>/` + `.zip` | 产物；`RELEASE.md` 里记 manifest 的 sha256 |

排除表全是机器状态与项目产物：`__pycache__`、`*.pyc`、`.DS_Store`、`*.tmp`、`*.log`、`.pi/git/**`、`.pi/npm/**`、`.pi/settings.json`、`.myflow/.runtime/**`、`.myflow/tasks/**`、`.myflow/archive/**`，以及本仓库自己的 `worktree.yaml`（发布物里由 `worktree.template.yaml` 代替）。

清单只有一份的原因很实际：`tests/scaffold.test.ts` 也读它，所以"加一个载荷文件"是一次清单编辑，不是两个消费者各自维护一份列表。同理，仓库根新增一个目录（比如这本书的 `book/`）天然在载荷之外，既不需要也不该加条目——但**反过来说，"该发却没发"也不会报错**，这是清单式边界的老问题。

## 不变量

**有些路径永远进不去。** `FORBIDDEN` 是硬拒绝：`dist`、`.git`、`.myflow/tasks`、`.myflow/archive`、`.myflow/.runtime`、`tests`、`tools`、`package.json`、`tsconfig.json`；清单里写了它们也构建失败。

**泄漏要扫，不靠自觉。** 载荷里每一行文本都被扫 `C:\Users\`、`C:/Users/`、`/Users/`、`/home/` 以及构建机的根路径，命中就报"文件:行: 命中内容"。

**zip 可复现。** 时间戳来自 `SOURCE_DATE_EPOCH`（没设就整次构建共用一个 epoch），所以相同的树产出字节一致的归档。

**`--verify` 是六项检查，不是一个"跑起来了"。**

1. 在假 Pi API 下动态 import 发布出来的 `index.ts`，断言注册的 hooks 集合**完全相同**、tools 与 commands 至少包含期望名字。
2. `task.py current` 在临时项目里报告"没有活动任务"。
3. `get_context.py` 输出 `no_task` 状态块。
4. 解压出来的树里没有夹带项目自有路径。
5. `INSTALL.md` 里没有写死具体版本号。
6. 每个随载荷发布的脚本都能用自己的解释器起来：`.py` 只要不出现 `Traceback`（用法错误退 2 不算失败），`.mjs` 只跑 `node --check`。

## 两个已知空洞

**命令断言只覆盖一半。** `EXPECTED_COMMANDS` 里只有 `myflow-status`，而扩展实际注册了两个斜杠命令。冒烟测试只查"缺失的名字"，所以 `/mysubagents` 掉了、注册坏了、改名了，`--verify` 依然全绿。钩子列表完整，工具列表完整，只有命令这一项残缺。

**`--verify` 只证明"能起来"。** 第三、四项检查上下文输出与目录干净度；第六项对 `.mjs` 只做语法检查，源码里带着一条 `shortcut:` 注释承认这一点。没有任何一项验证行为——载荷里没有测试，也不该有：`tests/` 是开发机器的一部分，被 `FORBIDDEN` 挡在外面。所以"通过验收"的真实含义是：它加载了、注册了、脚本没在 import 阶段就崩。

还有一个相关的软处：`worktree.template.yaml` 的 `verify:` 出厂值是 `python3 .myflow/scripts/task.py current`，只能证明 harness 能跑。不改这一行，`myflow-check` 的 settle 门就什么都不检查；`INSTALL.md` 明写了，但没有机制强制。

## 安装路径

`INSTALL.md` 是唯一权威，要点有四步：复制 `.pi/` 与 `.myflow/` 下的 `agents`、`scripts`、`spec`、`workflow.md` 加模板配置；**不要**复制 `tasks/`、`archive/`、`.runtime/`、`tests/`、`tools/`；把 `worktree.template.yaml` 复制成 `worktree.yaml` 并改 `verify:`；然后把 Pi 的 shell 钉到本机的 Git Bash。

硬前置写在同一份文件里：一个 git 仓库（worktree 会话就是 git worktree）、`python3` 在 `PATH` 上（扩展要 shell 出去调 `gate-info` 和验证门）、Node.js、Git for Windows。载荷里没有 `node_modules`，扩展只 import Node 内置模块——但这不等于"没有依赖"：上面三样缺一个，功能就会残缺或拒绝运行。

最后一关是人的：Pi 启动时问一次是否信任这个目录的 Pi 资源，拒绝则 `.pi/extensions` 不被加载。第一次成功运行的标志是 `/myflow-status` 打印 `myflow: no_task`。

## 一个最小走查

1. `python tools/release.py --check`：清单里的每一条都存在、载荷非空、没有 `FORBIDDEN` 命中、没有绝对路径泄漏。
2. `python tools/release.py --out dist --verify`：产出 `dist/myflow-0.3.0/` 与 `.zip`，再解压到临时目录跑六项检查，每项 `ok`。
3. 把 zip 交给一个空项目，按 `INSTALL.md` 复制、改 `verify:`、钉 `shellPath`、接受项目信任。
4. 启动 Pi，`/myflow-status` 打印 `no_task`，`python3 .myflow/scripts/task.py list` 返回空列表。安装成立。

## 常见误解

- **"发布的是代码。"** 发布的是**项目脚手架**：agents、prompts、skills、`workflow.md`、Python 脚本、spec 树。装的人被期望去改它，所以它没有 semver 意义上的 API。
- **"可以覆盖升级。"** 不能。没有 `--upgrade`，没有迁移脚本，安装树里也没有版本标记；升级等于手工 diff 自己改过的 `.pi/`。
- **"`--verify` 说明功能正常。"** 它说明载荷能加载、能注册、脚本能起。行为验证不在发布流程里。
- **"`--release` 会推。"** 只有加 `--yes` 才推；不加则 commit 与 tag 留在本地。
