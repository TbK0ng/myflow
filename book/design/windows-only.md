---
title: 只支持 Windows + Git Bash
---

# 只支持 Windows + Git Bash

## 一句话结论

这不是一个没做完的缺陷，是「删掉你测不了的分支」这条原则被应用到平台维度上的结果。代码里没有第二条平台路径，因为它从来没有被跑过一次；留着它，等于用 `if` 把一句谎话写进源码。

## 别人怎么做

主流是「共享内核 + 平台 shim」：一处 `process.platform` 决定用 `taskkill /T /F /PID` 还是 `kill(-pid)`，一个 shell 解析器在 `bash` / `sh` / `pwsh` / `cmd.exe` 之间挑，一个路径层在 `path.win32` 与 `path.posix` 之间切、大小写与分隔符各自处理，再加一份三平台 CI 矩阵。它买到的是安装量：一个开发者工具的用户分布在三个平台上，多一条分支的成本小于失去三分之二用户。shim 层通常很薄——几处 `if`、一个 `execFile` 包装——而且关在一个小文件里，主逻辑看不见它。

第二种常见做法是**检测 WSL 并降级**：找不到原生 POSIX shell 就退到 `bash.exe`，用 WSL 里的 GNU 语义跑命令。它买到的是「Windows 上也能跑 bash」的表面兼容。

两条路的共同前提是同一件事：每条分支至少要在一个真实环境里被跑过一次。

## 这个项目怎么做

四个入口，四种拦截：

- `index.ts` 的扩展工厂在 `process.platform !== "win32"` 时**抛错**——加载即失败，不会有半个扩展被注册。
- `bg_runner.mjs` 把拒绝写进 `<taskId>.exit`，位置在 pid 握手之后、解析 shell 之前：拒绝因此是一条可观测记录，而不是让调用方干等到 `STARTING_TIMEOUT_MS` 超时。
- `channel.py` 与 `worktree.py` 直接 `exit 1`，打印 `myflow runs on Windows only (Git Bash required)`。

**没有拦截的还有两个**：`task.py` 与 `get_context.py` 里没有任何平台检查。

平台假设真正落在**语义**里，不落在 guard 里：`transport.ts` 的 `killChildTree` 只有 `execFileSync("taskkill", ["/T", "/F", "/PID", pid])` 一条路，没有「否则 `kill(-pid)`」；`background/stop.ts` 的 `terminateTree` 同样；`background/start.ts` 用 `{ detached: true }` 拉起 wrapper（在 Windows 上就是 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`）；`agents.ts` 的 `normalizeWriterPath` 恒折叠大小写，从不问平台；`bg_runner.mjs` 的 `resolveShellPath` 没有 `platform` 参数，`findOnPath` 按 `;` 切 `PATH` 并跳过 `system32` / `sysnative` / `syswow64` 三个目录（同一个 WSL 启动器的三种拼写），`shellRejectionReason` 拒绝 `cmd.exe`。CI 只有 `windows-latest`。

## 为什么换成这个

仓库把理由写在自己的文档里。`.myflow/spec/harness/index.md` 的「Platform: Windows only」条目：*"one code path. No `process.platform` / `os.name` branch survives outside those guards."* 以及 *"Breaks if: a cross-platform branch is reintroduced 'just in case'. It can never run here, so it is untested code that reads as a supported platform."* `CHANGELOG.md` 0.3.0：*"Every non-win32 code path is deleted rather than kept 'just in case'"*。`ci.yml` 的注释说，一次多平台矩阵会暗示一个代码已经不再做的承诺。

三条硬理由：

1. **一条分支只有在被真实执行时才算被支持。** 单平台 CI 让那四个入口的每条路径都在一个真实 Windows 上跑过、被断言过；shim 只能保证「编译过」，而「编译过」和「跑通」之间的距离，正是这个仓库其它所有决定想消灭的东西。
2. **没人跑的分支会无声腐烂。** `else` 里的 bug 不会被 CI 报出来，会被读者当成「这条路能走」。
3. **WSL 是拒绝，不是退路。** `findOnPath` 里那句注释写着 *"naming them here is a refusal, never a way to support WSL"*。WSL 的 bash 能跑命令，但进程树归属、路径映射、`taskkill` 可见性全都不同；一个「WSL 上有效一半」的 harness 比一个明确要求 Git Bash 的更难用，因为你会先相信它。

## 代价

**一、读者跑不起来。** 本书里每个机制都是读出来的，不是点出来的：评审没法克隆仓库、跑一句命令、看它工作。这是作品集项目最贵的成本，我用「每章给出 `path` 加符号名」部分补回，但补不回「它在我机器上跑起来了」。

**二、off-Windows 是「半跑」，不是干净失败。** 因为 `task.py` 的 12 个子命令与 `get_context.py` 没有 guard，在 Linux 上它们会正常工作，而扩展加载不了、`bg_runner.mjs` 记录拒绝、`channel.py` 与 `worktree.py` 直接退出。于是「这个仓库能不能用」取决于你调的是哪个脚本。一个全部拒绝的树，或一个全部工作的树，都比这个中间状态好解释。这一条我在诚实篇里登记为缺陷，不当成设计。

**三、平台债是语义级的，所以移植是重写。** 大小写折叠、`;` 切 `PATH`、`taskkill /T` 作为唯一的树杀、pty 让 `sys.stdin.isatty()` 返回 `true`，散在十几个文件里。它们不是 guard，是「事情本来就是这样」的默认假设。

**四、WSL 拒绝对下一个人是陷阱。** 一台只装了 WSL 的机器得到一句拒绝、没有 fallback。`CHANGELOG.md` 的「Fixed」里记着：`INSTALL.md` 一开始声称不需要额外配置，后来必须补上「装 Git for Windows」这条硬前置——因为拒绝发生得太晚，用户已经装完 Pi 了。

## 什么情况下我会改回去

1. **出现第二个真实用户**——不是我，一个会真的克隆、真的运行、真的报 issue 的人。
2. **需要在一个非 Windows 的 CI 上跑起来**——比如某次求职流程要求「在容器里跑一遍」，或要在一台 Unix 机器上做演示。这是外部约束，我不为它预先付账。
3. **那三条语义里有一条被抹平**：Pi 或 Node 提供了跨平台的进程树 kill、跨平台的路径比较、一个不依赖 pty 的 tty 判定。那时「Windows 假设」不再承重，第一条反对理由就消失了。

在那之前，我宁可让读者看到一句拒绝，也不想让他们看到一条永远跑不通的 `else`。
