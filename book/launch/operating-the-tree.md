---
title: 三条真实事故的排障走查
---

# 三条真实事故的排障走查

**分类判断：** 事故复盘（维度 9 的后半）**存在，但它是事后补出来的**：没有 exception id、没有 trace、没有看板，能复盘全靠「每个动作都先落盘」。下面三条都真在这棵树里发生过——不是构造的教学例子——所以它们的共同点也是真的：失败的时候，没有任何一步报错。

留痕清单在[埋点就是运行留痕](./observability.md)；这一页只讲事故怎么被找到、怎么被修、以及下次怎么更早发现。

## 事故 1：面板的光标看起来是死的

**现象.** 打开 `/mysubagents`，按方向键，被标记的那一行不动。没有异常、没有卡顿、没有日志。每个键都被处理了——`handleInput` 收到了输入，`applyKey` 也返回了新状态，光标就是不动。人的第一反应是终端没把按键送进来，于是去试 `?` 和 `q`：它们都好使。

**从哪个 id 起手.** 没有 id。这条事故和注册表、日志都无关，它是 reducer 与一秒一次刷新之间的时序问题。唯一能用的证据是一个二值事实：按下方向键之后，被标记的那一行变了没有。

**沿哪个文件查.** `.pi/extensions/myflow/board/index.ts`，四个函数连起来读才露馅：`handleInput` → `applyKey` → `selectionAnchor` → `refresh`。`applyKey` 返回了**新**的 selection；`selectionAnchor(state, view)` 读的却是 `state.selection`，也就是光标**离开**的那一行。`refresh()` 每一拍都拿这个锚点重新定位光标，于是每一次移动都在下一拍被撤销。

**根因.** 锚点的语义是「光标现在在哪」，调用点传进去的是「光标刚在哪」。两者只差一次赋值，但这个差值被一秒一次的刷新放大成了「光标死了」。

**修复.** 先把新 selection 写回面板状态，再以 `{ ...state, selection }` 求锚点；代码里留了一行注释，解释为什么必须传新的 selection。

**现在怎么更早发现.** `tests/board-actions.test.ts` 里那条「the panel's cursor actually moves (down arrow is not undone by the refresh)」：按下方向键后断言**被标记的行变了**，而不是断言「键被处理了」。后者在事故期间一直是绿的。这条断言是能变红的——把传入的 `{ ...state, selection }` 换回 `state`，它立刻失败。

## 事故 2：`%TEMP%/myflow-*` 攒了 134 个目录

**现象.** 测试全绿，机器越来越脏。`%TEMP%` 下一堆 `myflow-*` 临时目录，每个里面都是一次已经结束的 run 的工程。没有一个用例失败，因为「删不掉目录」这件事被清理函数吞掉了。

**从哪个 id 起手.** 数目录。这是唯一一条从「量」而不是从 id 起手的事故：`ls %TEMP%` 筛出 `myflow-` 前缀数出 134 个。

**沿哪个文件查.** 三个测试文件的清理路径——`subagent.test.ts`、`bg-start.test.ts`、`subagent-rpc.test.ts`。它们各自用 `mkdtempSync(join(tmpdir(), "myflow-..."))` 建目录，在 `finally` 里删；删不掉的那一版只有一次 `rmSync`。

**根因.** 一次 run 在子进程退出之前就 settle 了。测试去 `rmSync` 的时候，被 `taskkill /T /F` 杀掉的那个子进程（还有它拉起的 Git Bash 外壳）仍握着日志句柄，Windows 报 `EPERM`。而 `rmSync` 的 `force: true` 只忽略 ENOENT——它**不重试占用**。中间还踩过一个更贵的坑：只加 `maxRetries` 而不等进程真的死，Node 的退避把超时烧完照样放弃，等于每个用例仍然留一个目录。

**修复.** 三步：`killTree(pid)` → 等 200 毫秒让句柄释放 → `rmSync(..., { maxRetries: 10, retryDelay: 100 })`；删完**显式断言目录已消失**，删不掉就抛错让测试红。理由写在注释里：一个泄漏的临时目录会伪装成「测试通过」。

**现在怎么更早发现.** `tests/leak-audit.test.ts` 从源码里静态提取 `mkdtempSync` 的前缀，审计 `%TEMP%/<prefix>*`。新增一个临时目录前缀而不加进被审计的名单，这条就会红——它检查的是「失败留下的痕迹」，而不是「失败的那一次」。

## 事故 3：channel worker 绕过所有「仅主会话」守卫

**现象.** 这条与前两条不同：它不是一次现场，是顺着环境变量链读代码读出来的洞。一个由 `channel.py spawn` 拉起的 worker，从守卫的判据上说**就是主会话**——它可以递归派发子代理、可以 `myflow_ask_user` 弹确认框、可以起后台任务，`writesUnder` 的路径边界对它不生效。它自己不会这么做，因为 work order 里明说了「不要创建或管理 myflow 任务」；但那是指令，不是机制。

**从哪个 id 起手.** 环境变量。所有守卫共用同一个判据：`index.ts` 的 `detectAgentType()` 只读 `MYFLOW_AGENT_TYPE`。于是问题变成一句可以当场回答的话：这个 worker 的进程环境里有没有它。

**沿哪个文件查.** `.myflow/scripts/channel.py` 里构造 `worker_env` 的那几行：`{**os.environ, "MYFLOW_SKIP_BREADCRUMB": "1"}`，`reviewer` 另加 `MYFLOW_VERIFY_GATE`。**从不设 `MYFLOW_AGENT_TYPE`**，注释还把理由写在旁边：worker 是普通的 pi 进程，不是被派发的子代理，所以它没有 agent type。

**根因.** 身份被绑在「**怎么被拉起**」上，而不是「**它是什么**」上。`myflow_subagent` 拉起子进程时顺手设了环境变量，于是「子代理」这个身份就等于「那个变量」。第二种拉起方式（`channel.py` 自己 `Popen`）不设它，身份就是空，`isSubAgent` 为假，`tool_call` 里那五处守卫——递归派发、`myflow_ask_user`、`myflow_request_approval`、`myflow_bg_*`、`writesUnder`——全部提前 return。唯一被补过的入口是 verify gate：因为它恰好需要覆盖 worker，补法不是给 worker 一个身份，而是加了一个旁路开关 `MYFLOW_VERIFY_GATE`。这本身就说明了问题：**判据不够用的时候，补的是特例。**

**修复.** 只补了那一处。其余四处仍然是「没有 agent type 即主会话」，所以这条缺口现在写在 spec 里——`harness-conventions.md` 的「Subagent detection」与「Verify gate scope」两条相邻，写法是承认它，而不是假装代码拦住了。

**现在怎么更早发现.** 一个「设置 `MYFLOW_AGENT_TYPE` 之后五处守卫都拒绝」的测试只能证明子代理被拦住，它对这个洞是瞎的。要发现这类缺口得反过来问：**还有哪些进程进得来，而判据是空的？** 现在至少有两个答案——channel worker，和 `worktree.py start` 拉起的会话（它同样只设 `MYFLOW_SKIP_BREADCRUMB`）。凡是「环境变量里有没有 X」式的守卫，都要配一句「第二种拉起方式怎么算」。

## 这三条的共同点

失败是安静的。光标不动看起来像终端的问题；临时目录残留没有任何一步失败，因为清理函数的 `catch` 把失败吞了；worker 用主会话的权限跑完一件事，所有工具都返回成功。三条都没有 exception id 可查——这个项目也没有 exception id 这种东西。

所以能救你的不是一块埋点看板，而是两件更土的事：**每个动作都在磁盘上留痕**（第二条的现场就是磁盘上那 134 个目录，第三条是顺着写进 env 的字段读出来的），以及**一条会在失败时变红的断言**（第一条靠它锁定，第二条的回归也靠它）。后者更难写，因为它要求你先想清楚「失败长什么样」，而这三条的共同伪装恰好是「看起来正常」。
