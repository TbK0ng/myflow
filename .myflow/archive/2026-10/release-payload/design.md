# design: release packaging — 机制、契约与产物形态

> 契约定在 `prd.md`；本文件解释**为什么这样切**、产物长什么样、脚本怎么保证"可迁移"。

## 1. 为什么 payload 清单要单独成文件

同一份"哪些文件可迁移"现在只活在 `tests/scaffold.test.ts` 的常量里。打包脚本需要它，
第二个消费者一旦出现，就有两份会漂移的定义——这正是本仓库反复修的那类 bug。
所以清单外置为 `tools/release-payload.json`，测试与脚本都读它。

**放 `tools/` 而不是 `.myflow/scripts/`**：`.myflow/scripts/` 是 payload 的一部分，
脚本本身会被复制进 release；一个在目标项目里没有对应清单的 `release.py` 只会造成困惑。
`tools/` 与 `tests/` 同级，属 **harness 开发**，不进 payload。

## 2. 清单 schema（`tools/release-payload.json`）

```json
{
  "version": 1,
  "dirs":  [".pi"],
  "trees": [".myflow/scripts", ".myflow/agents"],
  "files": [".myflow/workflow.md"],
  "exclude": [
    "**/__pycache__/**",
    "**/*.pyc",
    "**/.DS_Store",
    "**/*.tmp",
    "**/*.log"
  ]
}
```

- `dirs` = 整棵复制；`trees` = 整棵复制但**会被 payload 内的忽略规则过滤**（两者语义相同，
  分开只为让历史读者看出哪些是"根级目录"）；`files` = 单文件。
- **不变量**：manifest 里的每个 path 必须存在；`exclude` 命中即跳过；`dist/`、`.git/`、
  `.myflow/{spec,tasks,archive,.runtime}`、`tests/`、`tools/`、`package.json`、`tsconfig.json`
  永不进入产物（脚本硬编码拒绝，即使有人把它们加进 manifest 也报错）。
- 测试侧：`tests/scaffold.test.ts` 的 `copyPayload` 改为按 manifest 复制（同样应用 `exclude`），
  **其余断言一字不改**——它仍然是"复制到空目录 → 扩展能加载、脚本能跑"的守卫。

## 3. `tools/release.py`

```
python tools/release.py --check                 # 校验，不产出
python tools/release.py --out dist              # 产出 dist/myflow-<ver>/ + .zip
python tools/release.py --out dist --verify     # 产出并在临时目录冒烟
```

### 3.1 `--check`（快速、无副作用）
1. manifest 里每个 path 存在；
2. 禁止清单命中：`dist/`、`.git/`、`.myflow/spec|tasks|archive|.runtime`、`tests/`、`tools/`；
3. 逐文件扫描 payload：出现本机绝对路径（`C:\Users\`、`C:/Users/`、`/Users/`、`/home/`、仓库绝对根）
   **或** `.myflow/.runtime` 字样 → 失败并列出文件与行号；
4. 打印"将复制的文件数"与"被 exclude 跳过的文件数"，便于人工核对。

### 3.2 构建
- 目标 `dist/myflow-<version>/`；若已存在则先删（幂等）。
- 复制后追加：
  - `INSTALL.md`（来自 `tools/INSTALL.md`，逐字复制）
  - `RELEASE.md`：`version`、`source_commit`（`git rev-parse HEAD`）、`built_at`、
    `files`（总数）、按顶层目录分组计数、`manifest` 的 sha256。
    `built_at` 用**环境变量 `SOURCE_DATE_EPOCH` 优先，否则当前时间**；同一次构建里 zip 条目时间戳
    统一取该时间 → 同一天两次构建字节一致（测试用固定 `SOURCE_DATE_EPOCH` 断言）。
- zip：`zipfile.ZipFile(..., ZIP_DEFLATED)`，每个 `ZipInfo` 的 `filename` 用 `/`、
  `date_time` 固定、`external_attr` 固定（`0o644`），条目顺序 = 排序后的路径 → 可重复。

### 3.3 `--verify`（证明"能迁移"）
在临时目录里展开 `dist/myflow-<version>/`，然后：
1. 用 `node --input-type=module -e` 动态 import 该 release 的扩展，注册到假 API，
   断言 hook 集合 = 8 个、tools 含四个 `myflow_bg_*`、commands 含 `myflow-status`；
2. `python .myflow/scripts/task.py current` → 输出 `no active task`；
3. `python .myflow/scripts/get_context.py` → 含 `[workflow-state:no_task]` 与 `## Session Runtime Context`；
4. 断言临时目录里**没有** `.myflow/spec`、`.myflow/tasks`、`.myflow/.runtime`、`tests/`。

任一步失败 → 非零退出，并打印失败的那一步。

## 4. 产物形态

```
dist/
├── myflow-0.2.0/
│   ├── .pi/…            扩展、agents、prompts、8 个技能
│   ├── .myflow/
│   │   ├── agents/      architect.md、reviewer.md
│   │   ├── scripts/     5 个脚本（无 __pycache__）
│   │   └── workflow.md
│   ├── INSTALL.md
│   └── RELEASE.md
└── myflow-0.2.0.zip     顶层前缀 myflow-0.2.0/
```

## 5. INSTALL.md 必须回答的问题

1. 复制哪些（`cp -r` 的精确命令）；**不要**复制什么，以及为什么；
2. 在目标项目里如何让 Pi 加载扩展（与本仓库相同的方式：`.pi/extensions/` 自动发现 /
   项目级 settings，按实际情况写）；
3. `.gitignore` 至少要有的行（`.myflow/.runtime/`、`dist/`）；
4. 首次冒烟：`/myflow-status`、`python .myflow/scripts/task.py current`（应为 `no active task`）；
5. 首次建任务的最小路径（`task.py create`），以及 spec 是**项目自有**（首次可空）。

## 6. ADR

### ADR-11 清单外置 + 双消费者
- Context：清单只在测试里；打包是第二个消费者。
- Decision：`tools/release-payload.json`，测试与脚本都读。
- Consequences：改一处生效；代价是测试要读文件（原来读常量），并新增一个 `tools/` 目录（dev-only）。
- Rejected：脚本内置清单（必然漂）、解析测试源码（脆弱）。

### ADR-12 release 产物不进 git
- Context：zip 与目录是构建产物；进 git 会让每次构建都产生噪音 diff。
- Decision：`dist/` 加进 `.gitignore`；`v0.2.0` 标签指向**构建脚本与文档**的提交，产物由脚本重建。
- Consequences：仓库轻；代价是"标签里的提交不包含 zip 本身"，需在 `RELEASE.md` 与 INSTALL 里
  说明如何重建（`python tools/release.py --out dist`，且构建可重复）。

### ADR-13 可重复构建
- Context：可重复的 zip 才能让"这个 tag 对应这个产物"可验证。
- Decision：固定条目时间戳与顺序、`external_attr` 固定、`SOURCE_DATE_EPOCH` 可覆盖。
- Consequences：同一天两次构建字节一致（测试锁定）。

## 7. 不做 / 已知限制

| 项 | 为什么不做 |
| --- | --- |
| 目标项目自动安装（写 settings / 建 spec） | `INSTALL.md` 给步骤即可；自动改 Pi 配置风险高于收益 |
| 带 `tests/` | 用户选 1 的默认；要改 harness 从本仓库取 |
| 移动 `0.1.0` 标签 | 已有标签代表一次历史发布，不重写 |
| 跨平台 zip 权限位语义 | 只用 `0o644` 固定值，不追求可执行位（脚本由 python/node 调用） |
