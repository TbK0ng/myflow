---
title: 上下文注入
---

# 上下文注入

## 职责

派发出去的子进程不共享父会话的记忆。所以"上一轮谈了什么"必须变成文本，塞进子进程的第一个模型请求里。这一页讲三件事：按什么顺序塞、每份多大、塞不下时留下什么话。

## 触发点

唯一的生产者是 `context-injection.ts` 的 `buildTaskContext(projectRoot, taskDir, agentType)`。调用点两处：`index.ts` 的 `session_start`（主会话与子代理都调）和 `context`（每轮比对当前内容与已注入内容，不一致才重投影）。子代理只拿到 `<task-context>`；`<session-context>` 只给主会话。

产出是一条 `display: false` 的 custom message，内容以 `<task-context>` 开头、`</task-context>` 结尾。

## 读什么，按什么顺序

| # | 内容 | 单份上限 | 谁拿得到 |
| --- | --- | --- | --- |
| 1 | `prd.md` | `max_artifact_bytes`（65536） | 所有进程 |
| 2 | `design.md` | 同上 | 所有进程 |
| 3 | `implement.md` | 同上 | 所有进程 |
| 4 | `info.md` | 同上 | 所有进程 |
| 5 | `implement.jsonl` 引用的文件 | `max_file_bytes`（32768） | 只有 `myflow-implement` |
| 6 | `check.jsonl` 引用的文件 | 同上 | 只有 `myflow-check` |

清单映射写死在 `taskContextJsonlNames`：其他名字的 agent（包括主会话）拿不到任何清单文件。清单本身读取上限 1 MiB；被两个清单同时引用的文件按 `realpath` 去重，只物化一次，所以别名和符号链接不能重复吃掉预算。

## 字节预算

| 上限 | 值 | 生效范围 |
| --- | --- | --- |
| `max_artifact_bytes` | 65536 | 四份 artifact 各一份 |
| `max_file_bytes` | 32768 | 清单引用的每个文件 |
| `max_total_bytes` | 131072 | 整段 `<task-context>` |

这三个值是 `DEFAULT_CONTEXT_INJECTION_LIMITS` 里的内置默认值。

前缀与后缀本身先占预算。降级只有三种文本，都是稳定的字面量：

```
[myflow: omitted <path> (<n> bytes) — <reason>]
[myflow: truncated at <N> bytes — read <path> for the full content]
[myflow: context limit reached; omitted entries remain authoritative on disk and require_read paths above.]
```

第三条只在预算耗尽时出现一次，出现之后整段结束。

## 信任边界

清单里的一行不是"读这个路径"，而是"指向项目内的这个文件"。`resolveProjectFile` 先做 `realpath`，再判断是否落在项目根或某个 trusted root 内；都不在就**静默跳过**，连 notice 都不留。

trusted roots 来自两处：一份可配置的白名单 `channel.trusted_context_dirs`（默认空集），以及自动信任被符号链接走的 `.myflow/tasks`（`AUTO_TRUST_ENTRIES`），除非显式写了 `channel.auto_trust_myflow_symlinks: false`。后者是为"任务目录被链接到另一个工作树"这种布局准备的。

二进制或非 UTF-8 的文件不内联，换成一条 omitted notice；磁盘上的文件存在但读不出来时，notice 说的是 `artifact is missing or unreadable`。

## 刻意反直觉的顺序

artifact 在前，curated 清单在后。算术很直白：三个 artifact 各吃到自己的 65536 上限就是 196608 字节，已经超过 131072 的总预算。也就是说，只要 `prd.md` + `design.md` + `implement.md` 都接近各自的上限，**第一条 curated 行能拿到的预算是零**，整段上下文以 artifact 加一条 terminal summary 结束。

这与设计动机正好相反：清单是规划阶段由人（或规划代理）逐行挑出来的，`start` 甚至拿"清单必须非空"当门，结果预算紧张时先被牺牲的就是它。

这处反转是记录在案的已知取舍。`.myflow/spec/harness/index.md` 的 "Ordering caveat" 写的就是这件事：artifact 先于 jsonl，压力下 curated 上下文先被丢弃或降级，而"这处反转是已知的，且故意没有在这里改"。为什么会接受它：artifact 描述的是这次任务的意图，模型至少能从 notice 里看到被省略文件的路径、自己用 `read` 去取；反过来，如果先塞清单，被丢掉的就是"要做什么"。

改它不是一个排序函数的局部改动：spec 明确要求同时更新 `context-injection.ts` 的顺序和 `.myflow/workflow.md` Dispatch Protocol 里写的读取顺序，否则文档立刻与代码不一致。

## 一个最小走查

目标任务是 `.myflow/tasks/portfolio-book`，派发一个 `myflow-implement`：

1. `prd.md` 约 4 KB → 全量内联，状态 `[inline]`。
2. `design.md` 约 3 KB → 全量内联。
3. `implement.md` 约 5 KB → 全量内联。
4. `info.md` 不存在 → **静默跳过**，没有 notice。
5. `implement.jsonl` 有 6 行：前 3 行指向 spec 与源码文件，逐个 `realpath` 校验后内联；第 4 行指向一个 200 KB 的文件 → 截断到 32768，末尾追加 `truncated` 提示；第 5 行预算已不够 → 换成 `omitted` 提示；第 6 行连同剩余内容被 terminal summary 取代。
6. 最后拼成 `<task-context>…</task-context>`，作为隐藏消息进入子进程的第一个请求。

子进程看到的开头是一段给模型的指令：被标成 `[truncated]` 或 `[omitted]` 的文件，磁盘上的那份才是权威，缺了什么要按路径自己去读。

## 常见误解

- **"注入等于读入。"** 注入的是文本；被截断或被省略的部分，模型必须自己去 `read`，否则会基于半份 `prd.md` 干活而不知道。
- **"清单里写了就会读到。"** 出了项目根又没有 trusted root 的行会被静默跳过——这是唯一一种不留痕迹的丢弃。
- **"缺 artifact 会报错。"** 不存在就跳过；只有存在但读不出来时才留一条 notice。
- **"预算是每个文件的上限。"** 三层上限同时生效，先撞上的通常是 `max_total_bytes`。
