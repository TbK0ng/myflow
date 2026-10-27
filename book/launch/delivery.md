---
title: 构建、发布、更新、版本
---

# 构建、发布、更新、版本

**分类判断：** 构建打包（维度 1）**存在**，是一个能算出字节的脚本；发布（2）**存在但规模极小**，是一次 `cp -r` 加一份安装文档；更新（3）**不存在**，真实形态是整包覆盖，且没有任何地方记录「这个项目跑的是哪一版」；版本管理（4）**存在**，一个来源、三个 tag、一节 CHANGELOG 对应一次发布。

## 一句话结论

这四个维度的规模由一个事实决定：**装的人只有一个**。所以「发布」的真实形态是「人跑一条命令，产出两个文件，复制到自己机器上」；「更新」这一维根本不存在，不是漏了，是没有需要被通知的人；而「版本」目前服务的对象是 CHANGELOG 与 git，不是使用者——安装树里没有任何东西记得自己装的是哪一版。

机制细节在[发布载荷与安装](../system/release.md)已有一页；这一页只回答这四个维度各自存在到哪一步。

## 维度 1 · 构建与打包：存在

一个脚本，`tools/release.py`，四个互斥模式，互斥由 `parse_args` 自己拒绝：

| 模式 | 做什么 | 写什么 |
| --- | --- | --- |
| `--check` | 校验清单每条都存在、载荷非空、没有 `FORBIDDEN` 命中、没有构建机绝对路径泄漏 | 不写任何文件 |
| `--out [DIR]` | `build()`：生成 `DIR/myflow-<version>/` 与同名 `.zip`（默认 `dist`） | 目录 + zip |
| `--out --verify` | 先 build，再把产物解压到临时项目跑六项冒烟 | 临时目录，跑完删掉 |
| `--release {patch\|minor\|major}` | bump `package.json` → 写 CHANGELOG → check → build → verify → commit `Release <version>` → `git tag -a`；只有 `--yes` 才 push | 版本、CHANGELOG、`dist/`、commit、tag |

拒绝是具体的：`--release` 不能与 `--check` / `--out` / `--verify` 同用，`--verify` 不能离开 `--out`，`--yes` 与 `--dry-run` 互斥。`--release` 起步还要求工作树干净、HEAD 在某条分支上（`release_blockers`）；`--dry-run` 把这两条打印成「真实发布会拒绝的原因」，再打印下一个版本号、CHANGELOG 标题与 tag 名，**不写、不建、不打 tag**——它也不构建，所以不能用它预看这个版本的 zip。

**zip 为什么可复现。** `write_zip` 做三件事：条目按 posix 路径排序；每条 `ZipInfo` 的 `date_time` 统一取 `build_epoch()`（`SOURCE_DATE_EPOCH`，没设就整次构建共用一个 `time.time()`）；`create_system` 与 `external_attr` 固定，不让构建机的权限位参与。两条边界：字节一致还要求**同一个 zlib/deflate 实现**（`ZIP_DEFLATED` 的压缩输出不跨实现保证，本仓库没验证过）；`epoch` 只记在产物内部的 `RELEASE.md`（`built_at`），产物丢了，重建就没有参照。

**六项冒烟证明了什么。** 在假 Pi API 下动态 import 发布出去的 `index.ts`，断言注册的 hooks 集合与期望**完全相同**、7 个工具齐全；`task.py current` 在临时项目里报「没有活动任务」；`get_context.py` 输出里有 `[workflow-state:no_task]` 与 `## Session Runtime Context`；解压树里没有项目自有路径或 `__pycache__`，`INSTALL.md` 与 `RELEASE.md` 都在；`INSTALL.md` 没写死某个补丁版本号；每个 `.py` 用当前解释器起一遍，每个 `.mjs` 过一遍 `node --check`。

**没证明什么。** 三处：没有任何行为验证（载荷不带测试，`tests/` 在 `FORBIDDEN` 里，所以「通过验收」= 能加载、能注册、脚本 import 阶段不崩）；命令断言只覆盖一半（`EXPECTED_COMMANDS` 只有 `myflow-status`，而扩展注册了 2 个斜杠命令，所以 `/mysubagents` 掉线或改名，`--verify` 依然全绿）；`.mjs` 只查语法，源码里那条 `shortcut:` 注释自己承认这一点。

**这个形态里它该长什么样：** 一个脚本、四种模式、产物是目录加 zip。它不需要发布流水线——流水线的价值是缩短「merge 到别人手上」的时间，而这里那个别人不存在。它需要的只是**可复现**与**拒绝**，两样都有。

## 维度 2 · 发布：存在，规模极小

没有 registry、npm 包、官网、下载页、邮件。唯一权威是 `tools/INSTALL.md`，它被逐字拷进每个发布物，其余靠 Git Bash：

- **复制**：`.pi/` 整个，加 `.myflow/` 的 `agents`、`scripts`、`spec`、`workflow.md`，`worktree.template.yaml` 复制成 `worktree.yaml`。
- **不复制**：`tasks/`、`archive/`、`.runtime/`、`tests/`、`tools/`、`INSTALL.md`、`RELEASE.md`。
- **必须改**：`worktree.yaml` 的 `verify:`，否则 settle 门什么都不查。
- **必须钉**：项目 `.pi/settings.json` 的 `shellPath`。这里有个缺口：`myflow_bg_*` 的 shell 解析链（`bg_runner.mjs`）读环境变量、用户级 settings、标准安装位置、`PATH`，**不读项目文件**，`INSTALL.md` 明写了这一条。

**这个形态里它该长什么样：** 发布 = 一个仓库 + 一份安装文档 + 一次手动构建。验收标准不是「用户能装上」（装的人就是作者），而是「解压出来的树能加载、能注册、脚本能起」——正好是六项冒烟在量的事。

## 维度 3 · 更新方式：不存在

三条独立证据：载荷里没有代码读自己的版本或去找新 release（`.pi/extensions/myflow/**` 与 `.myflow/scripts/**` 都搜不到）；`INSTALL.md` 没有升级章节；`release.py` 最后一步是 `git push --follow-tags`，之后没有通知环节。

真实形态只有一条：**人重新拿一个新 zip，重新 `cp -r`**，并且自己处理「我改过的载荷会被覆盖」——而 `INSTALL.md` 开头还说载荷是 meant to be edit-in-place。所以准确说法是：手动覆盖式更新，没有 diff 工具、没有版本对照、没有备份。更要紧的是下半句：装完之后，**目标项目里没有任何东西记录「我这套 myflow 是哪个版本」**——`INSTALL.md` 明确要求不要把 `RELEASE.md` 复制过去，载荷里也没有 version 文件。

**这个形态里它该长什么样：** 不做。触发条件是第二个使用者：那时「你覆盖了我的改动」才会从无所谓变成事故。

## 维度 4 · 版本管理：存在

**一个来源。** `package.json` 的 `version`（现在是 `0.3.0`）是唯一读点：`version_of` 从这里读，`dist/myflow-<version>/` 的目录名与 zip 名都来自它。一次版本声明实际是三处同步——`package.json`、`CHANGELOG.md` 的一节、`dist/` 的目录名——前两处由脚本一次写，第三处是产物。

**一次发布 = 一节 CHANGELOG。** `bumped_changelog` 的契约很硬：必须有 `## Unreleased`，段里必须有内容（空的直接 `fail()`，提示 write the entry first），标题换成 `## <version> — <日期>`，上面插回一个新的 `## Unreleased`。版本号本身是纯算术（`next_version` 只加一，不查 tag），所以跳过某个号不会报错，只有 tag 会拦。

**三个 tag。** `v0.1.0`、`v0.2.0`、`v0.3.0`，都是 annotated tag，都能 peel 到 commit。仓库只有一个长期分支 `main`，特性分支短命、合回就删，没有 `release/*`——所以 tag 不标在分支上，标在发布那一次 commit 上。

**CI 不出包。** `ci.yml` 只做 typecheck 加测试，不 tag、不产 `dist/`；`book.yml` 只发布这本书。出包永远是人的动作：`python tools/release.py --release patch|minor|major [--yes]`。

**不可变是约定，不是机制。** 脚本不会重打 tag（对同一版本跑第二次 `--release` 会在 `git tag` 那一步失败），但没有东西阻止 `git tag -f`：仓库没有 tag 保护声明，CI 也不校验 tag 与内容是否一致。这句话留在这里，是因为它是[灰度与回滚](./rollback.md)那张不可恢复清单的前提。

**这个形态里它该长什么样：** 版本号的唯一职责是让人能说出自己在跑哪一版。目前它只服务到一半：git 与 CHANGELOG 说得清，**装在项目里的那棵树说不清**。这也是维度 3 与 6 缺口的同一个根。
