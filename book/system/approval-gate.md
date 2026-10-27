---
title: 计划批准门
---

# 计划批准门

## 职责

批准门要解决的不是"如何阻止坏人"，而是一件更常见的事：**规划阶段被跳过**。模型很擅长直接开始写代码，然后补一句"用户已经同意了这个方案"。这套机制把"用户同意"变成磁盘上一条可核对的事实，并且**绑定到计划文件的具体字节**——改一个错别字，批准就作废。

## 触发点

| 环节 | 谁做 | 写什么 |
| --- | --- | --- |
| 问一个选择题 | `myflow_ask_user` | 追加一行到 `<task>/questions.jsonl` |
| 请求批准 | `myflow_request_approval` | `<task>/approval.json` |
| 人类在终端批准 | `task.py approve` | 同一个 `approval.json` |
| 读取状态 | `task.py gate-info` | 不写，只打印一行 JSON |
| **执行**这一道门 | `task.py start` | 通过后改 `task.json` 的 `status` |

关键分工：`gate-info` 是 TypeScript 侧**唯一**的读入口——`approval.ts` 的哈希和"已答问题数"都来自同一次调用，扩展从不自己算摘要、也不自己数行数。

## 读写哪些文件

`questions.jsonl` 只追加，一行一个问题：`{at, tool, header, question, options, answer, via}`。**只有 `via: "ui-select"` 且 `answer` 非空的一行才算"用户被问过"**；无 UI 时写入的是 `via: "no-ui"` 加一条"请在正文里提问并结束这一轮"的指令——绝不替你编一个默认答案。

`approval.json` 是**独立于 `task.json`** 的一个文件，因为 `start` / `archive` 会重写任务记录，而批准是用户的决定，不是生命周期元数据。它记 `approved_at`、`approved_by`、`session_id`、`plan_files`、`plan_hash`、`questions_asked`。删掉这个文件就是撤销批准。

`plan_hash` 的定义只有一份，在 `task.py` 的 `_plan_digest`：`sha256:` 加十六进制，输入按固定顺序 `PLAN_FILES`（`prd.md`、`design.md`、`implement.md`，**只算存在的**）拼接，每一份是 `文件名` + NUL + 原始字节 + NUL。文件名和 NUL 让摘要对重排和拼接免疫；`_plan_hash` 在一个存在的文件读不出来时返回 `None`，于是门**向拒绝一侧失败**，不会去哈希一个残缺的计划。

## 三道门，顺序固定

`task.py start` 依次检查三件事，任何一件不满足就退出 1，并且**只报告自己那一条**：

1. **清单非空。** `implement.jsonl` / `check.jsonl` 如果**存在但零条**，拒绝启动（`--allow-empty-context` 可绕过）。**不存在**的清单不拦——那是"这个项目没有配置 curate 流程"，不是"配置了但没做"。
2. **批准对得上当前哈希。** 没有计划文件、状态不是 `approved`、哈希不匹配、文件读不出来，全部拒绝。
3. **回算已答问题数。** 这是 R2 回退检查：写侧（`approve` 与批准工具）已经会拒绝没有问答的批准，但**真正放行的这一步不能相信写侧**，所以用同一个函数再数一遍。

批准状态是封闭集合：`approved` / `stale` / `missing` / `invalid` / `unhashable`，只有 `approved` 通过；`status.ts` 原样透传这个字符串。

## 诚实强度

`.myflow/spec/harness/index.md` 里写了实测结论：**这是一条同意记录，不是安全边界，可以被绕开。**

- `task.py approve` 用 `sys.stdin.isatty()` 拦"代理替人批准"。在这个环境里它挡不住：Pi 的 bash 工具会分配一个 pty，`isatty()` 实测为 `True`。在 Windows 上更弱——`< /dev/null` 会被映射到 `NUL`，同样报告 `isatty() === true`；只有**管道**才算非 tty。
- 手写一份 `approval.json`（正确的 `plan_hash`、`approved_by: "ui-confirm"`、再加一行伪造的 `via:"ui-select"`）实测能直接通过 `start`。
- 没有技术反制。有的只是事后检查：`--allow-unapproved` 会打印警告，并在 `task.json` 里留下 `started_without_approval: true`。

两个明知故犯的旁路：

| 旁路 | 留下什么 | 为什么保留 |
| --- | --- | --- |
| `--allow-unapproved` | `task.json` 的 `started_without_approval` 字段 + 警告 | 有时确实要先跑起来再补计划；让跳过变响，比让跳过变不可能更现实 |
| 任何能跑 `bash` 的代理 | 什么都没留 | 拦不住。承认它，比用一个看起来像边界的检查自我安慰更好 |

代价还不止"能被绕开"：任何一次对计划文件的编辑（包括改错别字）都会让批准变成 `stale`，门在正常编辑中途反复触发，长期会把人训练成反射性重批。

## 一个最小走查

1. 规划阶段，模型用 `myflow_ask_user` 问"载荷要不要包含 `tools/`"，用户选了"不包含"。`questions.jsonl` 多一行，`via: "ui-select"`。
2. 模型写完 `prd.md` 与 `implement.md`，调 `myflow_request_approval`。它先跑四个预检（没有活动任务 / 任务不在 `.myflow/tasks/` 下 / 没有计划文件 / 零个已回答问题），全部通过后才弹确认框。
3. 对话框列出计划文件与前 12 位哈希。用户确认，`approval.json` 落盘。
4. 模型跑 `task.py start`。清单有内容、哈希匹配、答过一题，`status` 变 `in_progress`，会话指针指向这个任务。
5. 之后模型又改了 `prd.md` 的一句话。下一次 `task.py start` 会报 `stale`，并同时打印当前哈希与已批哈希，指路 `myflow_request_approval` / `approve` / `--allow-unapproved` 三种出路。

## 常见误解

- **"哈希是扩展算的。"** 不是。扩展只调 `gate-info`。两份实现就会有两套判断，症状是面板说已批准而 `start` 拒绝，且报错不指向根因。
- **"`approved_by` 能证明是人点的。"** 它记录的是写入者自称的身份，`ui-confirm` 和 `cli` 都是字符串，手写即可。
- **"批准一次管一个任务。"** 管的是**一次计划修订**。计划变了，批准就过期，这是设计目的，不是副作用。
- **"没答过问题也能批。"** 不能。`approve` 与请求批准的工具都会拒绝；`start` 还会再数一遍。
