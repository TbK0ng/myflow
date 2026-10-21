# implement: 顺序、测试与提交

> 契约定在 `prd.md` / `design.md`；本文件只定"按什么顺序改哪些文件，拿什么证明改对了"。
> 每个工作项自带测试、单独一次提交（提交由主会话做）。

## 0. 硬约束

| 约束 | 依据 | 含义 |
| --- | --- | --- |
| 基线 | 当前仓库 | **354 / 354** 绿；任何一批不得让它变红 |
| 测试命令 | spec Pre-Development Checklist | 必须清空 `MYFLOW_*`（下方 §3） |
| implement / check 一次只能一个 | 无 `writesUnder` | 四批**全部串行** |
| 提交由主会话做 | 保证"提交 = 已验证" | 子代理实现 + 测试，主会话跑全量后提交 |
| `dist/` 不进 git | ADR-12 | 第一批就加 `.gitignore` |

## 1. 批次总览

| 批 | 项 | 产出 | 提交要点 |
| --- | --- | --- | --- |
| `R1` | 清单外置 | `tools/release-payload.json`、`tests/scaffold.test.ts` | Read the payload list from one manifest |
| `R2` | 打包脚本 | `tools/release.py`、`tests/release.test.ts` | Build a reproducible release from the manifest |
| `R3` | 安装文档与忽略项 | `tools/INSTALL.md`、`.gitignore`、`.pi/skills/myflow-meta/**` | Document how to install the payload |
| `R4` | 产出与发版 | `package.json`、`dist/`（忽略）、tag `v0.2.0` | Release v0.2.0, built from the manifest |

顺序理由：R1 让清单成为唯一来源（R2 依赖它）；R2 让"能迁移"可被脚本证明；R3 补安装说明
（脚本要把它放进产物）；R4 只做版本、构建、验证、发标签。

## 2. 各批详细

### R1 — 清单外置（行为零变化）
- 新增 `tools/release-payload.json`，内容见 `design.md` §2。
- `tests/scaffold.test.ts`：
  - 删除 `PAYLOAD_DIRS` / `PAYLOAD_TREES` / `PAYLOAD_FILES` 常量，改为读 `tools/release-payload.json`；
  - `copyPayload` 按 manifest 复制，并应用 `exclude`（先实现 `**` 匹配：`fnmatch` 语义即可，
    或把 exclude 写成 `__pycache__`、`*.pyc` 这类**逐段匹配**的规则并在测试与脚本里用同一函数——
    若无法共享函数，就让两处规则表来自 manifest，匹配实现各自 ≤10 行）；
  - **断言一字不改**（`SKILLS` / `AGENTS` / `PROMPTS` 等列表保留，它们检查的是"文件存在且 frontmatter 正确"）。
- 验证：`node --test tests/scaffold.test.ts` 全绿；`grep -n "PAYLOAD_DIRS" tests/` 为空。
- **回退即红**：把 manifest 里 `.myflow/agents` 删掉 → scaffold 的 runtime agent 断言变红。

### R2 — `tools/release.py` + `tests/release.test.ts`
- 脚本按 `design.md` §3 实现 `--check` / `--out` / `--verify`，只用标准库。
- 纯函数可单测的部分（manifest 读取、exclude 匹配、禁止清单、绝对路径扫描、zip 条目命名）
  尽量做成模块级函数。
- `tests/release.test.ts`（node，`execFileSync` 调 python）：
  | ID | 用例 |
  | --- | --- |
  | `-1` | `python tools/release.py --check` 在仓库根退出 0，输出含文件数 |
  | `-2` | 把 payload 复制到临时根、故意写一个 `C:/Users/foo/x.txt` → `--check --root <tmp>` 退出非 0 且点名该文件（为此 `--check` 需要一个 `--root` 参数，默认仓库根） |
  | `-3` | `--out <tmp>/dist` 构建成功；目录里**没有** `spec/tasks/archive/.runtime/tests/tools/__pycache__`；有 `INSTALL.md`、`RELEASE.md` |
  | `-4` | zip 存在、顶层前缀 `myflow-<version>/`、条目路径全用 `/`（无 `\`） |
  | `-5` | 固定 `SOURCE_DATE_EPOCH` 连跑两次 `--out` → 两个 zip 的 sha256 相同 |
  | `-6` | `--verify` 通过（8 hooks + 四个 `myflow_bg_*` + `myflow-status` + `task.py current` + `get_context.py`） |
- **回退即红**：从 `FORBIDDEN` 里删掉 `.myflow/tasks` → `-3` 变红；把 zip 时间戳改成 `time.localtime()` → `-5` 变红。
- 注意：测试自己的临时目录要清理；`--out` 到临时目录，不要污染仓库 `dist/`。

### R3 — 安装文档与忽略项
- `tools/INSTALL.md`：按 `design.md` §5 的五问写，命令可直接复制执行（Windows Git Bash 与 POSIX 两种写法各给一行）。
- `.gitignore` 加 `dist/`。
- `harness-conventions.md`：payload 段落写明 `tools/` 属 harness 开发、`tools/release-payload.json` 是
  **唯一清单来源**；`myflow-meta/SKILL.md` 的 layout 增 `tools/`（`release.py`、manifest、INSTALL）。
- 验证：`skills-hygiene` / `workflow-invariant` 绿；`grep -n "release-payload" .pi/skills -r` 命中两处（约定 + SKILL）。
- **回退即红**：把 manifest 路径写错（`release-payloads`）→ `--check` 报错（R2 已覆盖）；
  文档层无可断言的"红"，如实说明。

### R4 — 产出与发版
1. `package.json` → `"version": "0.2.0"`。
2. `python tools/release.py --out dist --verify` → 通过。
3. 人工抽查 `dist/myflow-0.2.0/` 的文件清单（`find | head -40`）与 zip 内容（`python -c "import zipfile;..."`）。
4. 提交版本号与任何残留文档修正；工作树必须干净（`dist/` 被忽略）。
5. `git tag -a v0.2.0 -m "myflow 0.2.0"`，推送 `main` 与 `v0.2.0`。

## 3. 固定命令

```bash
cd /c/Users/wocai/Desktop/myflow
env -u MYFLOW_AGENT_TYPE -u MYFLOW_CONTEXT_ID -u MYFLOW_SKIP_BREADCRUMB -u MYFLOW_WRITES_UNDER node --test tests/
python tools/release.py --check
python tools/release.py --out dist --verify
```

## 4. 完成判据（PRD AC ↔ 落点）

| PRD AC | 落在 |
| --- | --- |
| 清单唯一来源 | R1 + `grep -rn "release-payload" tests tools` |
| 改清单即生效 | R1 的回退即红（删 `.myflow/agents`） |
| `--check` 干净通过 / 绝对路径失败 | `-1` / `-2` |
| 产物无 spec/tasks/archive/.runtime/tests/tools | `-3` |
| zip 前缀与 `/` 分隔符 | `-4` |
| 可重复构建 | `-5` |
| `--verify` 冒烟 | `-6` |
| v0.2.0 推送、工作树干净 | R4 手工步骤 |
| 全量测试 | 每批 |

## 5. Dispatch 模板

```
Active task: .myflow/tasks/release-payload

本次批次：<R1..R4>
目标：<一句话>
必读：design.md §<对应>、implement.md §2 的 <R>、tests/scaffold.test.ts
禁止：改 prd.md/design.md/implement.md；改 .pi/extensions/**、.myflow/scripts/**；
      把 tests/ 放进 payload；把 dist/ 提交进 git。
做完报告：改了哪些文件、逐条测试结果与"删哪个判断会变红"、全量测试数、未做项。
```

## 6. 评审项

| # | 事项 | 建议 |
| --- | --- | --- |
| `T-1` | `--check --root <dir>` 这个测试参数是否保留 | 建议保留（否则"绝对路径扫描"只能靠改真实仓库来测） |
| `T-2` | exclude 的匹配语义 | 建议逐段 fnmatch（`**` 也支持），脚本与测试各自 ≤10 行，规则表唯一（来自 manifest） |
| `T-3` | zip 是否需要包含 `RELEASE.md` 的 sha256 | 建议不（自引用），只写文件数与源提交 |

## 7. 回退与失败处理

| 情形 | 处理 |
| --- | --- |
| 某批超时被截断 | 读 `.myflow/.runtime/subagent-logs/` → 拆小重派；不重做已完成部分 |
| 既有用例变红 | 停下报告；不得为让新用例通过而改既有断言 |
| `--verify` 在临时目录失败 | 先查是不是脚本漏复制（如 `.pi/prompts`），不要改成"跳过失败步骤" |
| 产物里发现本机路径 | 立即停止发版；修 `--check` 的扫描或源文件，重跑 |
| `dist/` 被误提交 | `git rm -r --cached dist`，确认 `.gitignore` 生效后再继续 |
