import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import extension from "../.pi/extensions/myflow/index.ts";
import type { ExtensionAPI, HookContext } from "../.pi/extensions/myflow/index.ts";
import { MYFLOW_AGENT_ENV } from "../.pi/extensions/myflow/subagent.ts";
import {
  backgroundDir,
  createBgListTool,
  createBgOutputTool,
  createBgStartTool,
  createBgStopTool,
  isAlive,
  logPath,
  readEntry,
  resolveStatus,
} from "../.pi/extensions/myflow/background/index.ts";

// F7 — 接线与生命周期（`.pi/extensions/myflow/index.ts` + `background/index.ts` 的注册面）。
//
// F1–F6 只导出了四个工具 builder，全仓没有第二个文件 import 它们，所以四个
// `myflow_bg_*` 工具在真实会话里**不存在**。本文件锁死三件事：
//
//   1. 注册真的发生（`extension(api)` 之后四个工具在 `registerTool` 里）；
//   2. 子代理三层守卫（白名单 / `tool_call` block / `execute` 自检）都在；
//   3. `session_shutdown` **不杀任务**、幂等、并且会提示本会话起的仍在跑的任务。
//
// 每个用例用独立的临时工程根（前缀 `myflow-bg-lifecycle-`，满足 leak-audit 的
// 审计 glob），并在 finally 里杀掉可能起来的进程树、删掉临时目录。
//
// 回退点（删掉即变红）：
//   -1：`index.ts` 删掉 `registerMyflowBackground(...)` → 工具列表缺四个名字；
//       删掉 BG 守卫 → 子代理语境四个工具全部 pass through。
//   -2：删掉 `bgSubAgentRefusal` 的调用 → `execute` 不再拒绝（且 spawn/confirm 被调）。
//   -3：任何 `.pi/agents/*.md` 的 `tools:` 加上一个 bg 工具名 → 断言变红。
//   -4：`session_shutdown` 里加 `terminateTree` / `taskkill` / `process.kill` →
//       `isAlive(pid)` 断言变红；删掉 `onStarted` → 提示不再出现。
//   -5：去掉 `shutdownDone` 幂等标志 → 第二次触发再发一条通知，计数断言变红。
//   -6：删掉递归守卫或 ASK 守卫 → 对应 block 断言变红。
//   -7：把通知判据里的 `hasUI !== false` 去掉（只留 `ui.notify` 存在性） →
//       `hasUI:false` 的 headless 语境反而发出 1 条通知，计数断言变红。

const ROOT = join(import.meta.dirname, "..");
const RUNNER = join(ROOT, ".myflow", "scripts", "bg_runner.mjs");
const AGENTS_DIR = join(ROOT, ".pi", "agents");

/** `index.ts` 里注册的四个工具名（本文件不 import 常量，避免测到同一份实现）。 */
const BG_TOOLS = ["myflow_bg_start", "myflow_bg_output", "myflow_bg_list", "myflow_bg_stop"];

/** 一个能通过 findProjectRoot 的临时工程根，且带一份**真实的** F1 wrapper。 */
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-bg-lifecycle-"));
  mkdirSync(join(root, ".myflow", "scripts"), { recursive: true });
  writeFileSync(
    join(root, ".myflow", "workflow.md"),
    "[workflow-state:in_progress]\nBackground.\n[/workflow-state:in_progress]\n",
  );
  // The registered start tool resolves the wrapper as `<root>/.myflow/scripts/
  // bg_runner.mjs` (no test-only injection), so a real copy is what makes `-4`
  // a real process rather than a failed spawn.
  copyFileSync(RUNNER, join(root, ".myflow", "scripts", "bg_runner.mjs"));
  mkdirSync(backgroundDir(root), { recursive: true });
  return root;
}

interface MockApi {
  api: ExtensionAPI;
  tools: Array<Record<string, unknown>>;
  handlers: Record<string, (event: unknown, ctx: HookContext) => Promise<unknown>>;
  notified: Array<{ message: string; level?: string }>;
  ctx: HookContext;
}

/**
 * A slim stand-in for Pi's API, in the shape `tests/extension.test.ts` uses:
 * it captures `pi.on` handlers, `registerTool` calls and `ui.notify` calls so a
 * test can drive the real extension factory.
 */
function makeMockAPI(root: string): MockApi {
  const tools: Array<Record<string, unknown>> = [];
  const handlers: Record<string, (event: unknown, ctx: HookContext) => Promise<unknown>> = {};
  const notified: Array<{ message: string; level?: string }> = [];
  const api = {
    on: (name: string, handler: (event: unknown, ctx: HookContext) => Promise<unknown>) => {
      handlers[name] = handler;
    },
    registerTool: (tool: Record<string, unknown>) => {
      tools.push(tool);
    },
    registerCommand: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    events: { emit: () => {}, on: () => () => {} },
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  // Same hand-off `tests/extension.test.ts` uses: handlers are reachable from
  // the API object so a test can drive the real factory's hooks.
  (api as unknown as Record<string, unknown>).__handlers = handlers;
  const ctx = {
    cwd: root,
    session: { id: "test", contextKey: "pi_bg_lifecycle" },
    ui: {
      notify: (message: string, level?: string) => {
        notified.push({ message, level });
      },
    },
  } as unknown as HookContext;
  return { api, tools, handlers, notified, ctx };
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

interface BgTool {
  name?: string;
  execute: (...args: unknown[]) => Promise<ToolResult>;
}

/** 注册后的某个工具（走真实的 `registerTool` 面）。 */
function registeredTool(tools: Array<Record<string, unknown>>, name: string): BgTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} must be registered by extension()`);
  return tool as unknown as BgTool;
}

/** 默认「TUI 有 UI 且用户同意」的桩 ctx。 */
function uiCtx(root: string, overrides: Record<string, unknown> = {}) {
  return {
    cwd: root,
    mode: "tui",
    hasUI: true,
    ui: { confirm: async () => true },
    ...overrides,
  };
}

/** 杀掉一个进程树。必须从 Node 用参数数组调 `taskkill`（Git Bash 会改写 `/F`）。 */
function killTree(pid: unknown): void {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;
  spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
}

/** 轮询直到 predicate 为真或超时。 */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

/** 统一清理：先杀进程树、等它真的消失，再删临时目录；删不掉就**让测试失败**。 */
async function cleanup(root: string, pids: unknown[]): Promise<void> {
  const live = () => pids.filter((pid) => isAlive(pid));
  for (const pid of pids) killTree(pid);
  // Windows 在进程消失后还会短暂持有日志文件句柄；而且 `/T` 打在 wrapper 上时，
  // 外壳可能**刚刚**才被创建而没进快照。所以等到 pid 真的不活，必要时再补杀。
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && live().length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const pid of live()) killTree(pid);
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (lastError) {
    throw new Error(`清理临时目录失败：${root}\n原始错误：${String(lastError)}`);
  }
  assert.ok(!existsSync(root), `临时目录必须已删除：${root}`);
}

const READY_MARKER = "bg-lifecycle-ready";
/** 长跑到收尸之前都不可能自然结束（60s 远长于用例时长）。 */
const LONG_COMMAND = `echo ${READY_MARKER}; sleep 60`;

/**
 * 通过**真实的注册面**起一个真长跑任务，并等它真的跑起来。
 *
 * 等日志里出现 marker 不是装饰：`taskkill /T` 只能杀掉快照里的进程。刚 spawn
 * 就收尸时，外壳可能还没创建，于是 `sleep` 的后代逃出 `/T` 并继续占着临时目录
 * （Windows 上表现为删目录 EPERM）。等外壳真的写出 marker 后再收尸，才是干净的。
 */
async function startRunningTask(
  root: string,
  tools: Array<Record<string, unknown>>,
): Promise<{ id: string; pid: number }> {
  const start = registeredTool(tools, "myflow_bg_start");
  const started = await start.execute(
    "t1",
    { command: LONG_COMMAND },
    undefined,
    undefined,
    uiCtx(root),
  );
  assert.equal(started.isError, undefined, `start failed: ${started.content[0]?.text}`);
  const id = started.details.id as string;
  const pid = started.details.pid as number;
  assert.ok(typeof id === "string" && id.startsWith("bg-"), "start must return a task id");
  assert.ok(typeof pid === "number" && pid > 0, "start must return a real pid");

  const dir = backgroundDir(root);
  const up = await waitFor(() => {
    const log = logPath(dir, id);
    return existsSync(log) && readFileSync(log, "utf-8").includes(READY_MARKER);
  }, 15_000);
  assert.ok(up, "the command's output must reach the log, proving the tree is up");
  return { id, pid };
}

/** 在子代理语境的进程里跑 `body`，结束后恢复环境变量。 */
async function asSubAgent(body: () => Promise<void>): Promise<void> {
  const previous = process.env[MYFLOW_AGENT_ENV];
  process.env[MYFLOW_AGENT_ENV] = "myflow-implement";
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env[MYFLOW_AGENT_ENV];
    else process.env[MYFLOW_AGENT_ENV] = previous;
  }
}

test("F7 -1 四个工具真的被注册；子代理被 tool_call 全部拦下，主会话放行", async () => {
  const root = makeProject();
  try {
    // Step 1: registration happens (the gap this batch closes).
    const main = makeMockAPI(root);
    extension(main.api);
    const registered = main.tools.map((tool) => tool.name as string);
    for (const name of BG_TOOLS) {
      assert.ok(registered.includes(name), `${name} must be registered by extension()`);
    }

    // Step 2: the main session is not blocked.
    for (const toolName of BG_TOOLS) {
      const result = (await main.handlers.tool_call({ toolName }, main.ctx)) as
        | { block?: boolean }
        | undefined;
      assert.equal(result, undefined, `${toolName} must pass through for the main session`);
    }

    // Step 3: a sub-agent is blocked by the tool_call guard.
    await asSubAgent(async () => {
      const sub = makeMockAPI(root);
      extension(sub.api);
      for (const toolName of BG_TOOLS) {
        const result = (await sub.handlers.tool_call({ toolName }, sub.ctx)) as
          | { block?: boolean; reason?: string }
          | undefined;
        assert.equal(result?.block, true, `${toolName} must be blocked for a sub-agent`);
        assert.match(result!.reason ?? "", /main session/);
      }
    });
  } finally {
    await cleanup(root, []);
  }
});

test("F7 -2 四个工具的 execute 自检拒绝：不 spawn、不弹窗、不写文件", async () => {
  const root = makeProject();
  try {
    let spawnCalls = 0;
    let confirmCalls = 0;
    const registration = {
      deriveContextKey: () => "pi_bg_lifecycle",
      isSubAgent: true,
      // Both of these THROW: reaching either one is the failure, not a count.
      spawnProcess: (() => {
        spawnCalls += 1;
        throw new Error("spawn must not be reached for a sub-agent");
      }) as never,
    };
    const start = createBgStartTool(registration) as unknown as BgTool;
    const output = createBgOutputTool(registration) as unknown as BgTool;
    const list = createBgListTool(registration) as unknown as BgTool;
    const stop = createBgStopTool(registration) as unknown as BgTool;
    const ctx = uiCtx(root, {
      ui: {
        confirm: async () => {
          confirmCalls += 1;
          return true;
        },
      },
    });

    // Revert point: delete the `bgSubAgentRefusal` call in any builder → that
    // builder stops returning `isError` (and start would reach spawn/confirm).
    const startResult = await start.execute("t1", { command: "sleep 60" }, undefined, undefined, ctx);
    assert.equal(startResult.isError, true);
    assert.match(startResult.content[0]?.text ?? "", /main session/);

    const outputResult = await output.execute("t2", { task_id: "bg-x" }, undefined, undefined, ctx);
    assert.equal(outputResult.isError, true);
    assert.match(outputResult.content[0]?.text ?? "", /main session/);

    const listResult = await list.execute("t3", {}, undefined, undefined, ctx);
    assert.equal(listResult.isError, true);
    assert.match(listResult.content[0]?.text ?? "", /main session/);

    const stopResult = await stop.execute("t4", { task_id: "bg-x" }, undefined, undefined, ctx);
    assert.equal(stopResult.isError, true);
    assert.match(stopResult.content[0]?.text ?? "", /main session/);

    assert.equal(spawnCalls, 0, "a refused start must not spawn");
    assert.equal(confirmCalls, 0, "a refused start must not prompt the user");
    // Nothing was recorded and no log/exit appeared.
    assert.deepEqual(readdirSync(backgroundDir(root)), [], "a refusal must write nothing");
  } finally {
    await cleanup(root, []);
  }
});

test("F7 -3 子代理白名单不含任何 bg 工具", () => {
  const agentFiles = readdirSync(AGENTS_DIR).filter((file) => file.endsWith(".md"));
  assert.ok(agentFiles.length > 0, "there must be agent definitions to check");

  let checked = 0;
  for (const file of agentFiles) {
    const text = readFileSync(join(AGENTS_DIR, file), "utf-8");
    const match = text.match(/^tools:[ \t]*(.*)$/m);
    if (!match) continue;
    checked += 1;
    const allowed = (match[1] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const name of BG_TOOLS) {
      assert.ok(
        !allowed.includes(name),
        `${file}'s tools: whitelist must not contain ${name} (sub-agents may not manage background tasks)`,
      );
    }
  }
  // A parse that silently matches nothing would make this test vacuous.
  assert.ok(checked > 0, "at least one agent must declare a tools: whitelist");
});

test("F7 -4 session_shutdown 不杀任务，并提示本会话起的仍在跑的任务", async () => {
  const root = makeProject();
  const pids: unknown[] = [];
  try {
    const { api, tools, notified, ctx } = makeMockAPI(root);
    extension(api);
    const { id, pid: wrapperPid } = await startRunningTask(root, tools);
    pids.push(wrapperPid);

    const entry = readEntry(backgroundDir(root), id);
    assert.ok(entry, "the registry entry must exist after start");
    assert.equal(resolveStatus(backgroundDir(root), entry!).status, "running");
    assert.ok(isAlive(wrapperPid), "the task must be alive before shutdown");

    const handlers = (api as unknown as Record<string, unknown>).__handlers as Record<
      string,
      (event: unknown, c: HookContext) => Promise<unknown>
    >;
    assert.ok(handlers.session_shutdown, "session_shutdown must be registered");

    await handlers.session_shutdown({}, ctx);

    // Revert point: add terminateTree/taskkill/process.kill to the shutdown
    // handler → the task dies and this assertion turns red.
    assert.ok(isAlive(wrapperPid), "session_shutdown must NOT kill a background task");
    await waitFor(() => notified.length > 0, 2_000);
    assert.equal(notified.length, 1, "the shutdown notice must be sent exactly once");
    assert.match(notified[0]!.message, new RegExp(id));
    assert.match(notified[0]!.message, /bg-lifecycle-ready/);
    assert.equal(notified[0]!.level, "warning");
  } finally {
    await cleanup(root, pids);
  }
});

test("F7 -5 session_shutdown 可重复触发（幂等，不抛、不重复通知）", async () => {
  const root = makeProject();
  const pids: unknown[] = [];
  try {
    const { api, tools, notified, ctx } = makeMockAPI(root);
    extension(api);
    const { pid: wrapperPid } = await startRunningTask(root, tools);
    pids.push(wrapperPid);

    const handlers = (api as unknown as Record<string, unknown>).__handlers as Record<
      string,
      (event: unknown, c: HookContext) => Promise<unknown>
    >;
    // Revert point: drop the `shutdownDone` short-circuit → the second call
    // re-notifies, and the count assertion turns red.
    await handlers.session_shutdown({}, ctx);
    await handlers.session_shutdown({}, ctx);
    await handlers.session_shutdown({}, ctx);
    assert.equal(notified.length, 1, "later shutdowns must be no-ops");
  } finally {
    await cleanup(root, pids);
  }
});

test("F7 -6 既有守卫未回归：递归守卫与 ASK 守卫照旧", async () => {
  const root = makeProject();
  try {
    await asSubAgent(async () => {
      const { api, ctx } = makeMockAPI(root);
      extension(api);
      const handlers = (api as unknown as Record<string, unknown>).__handlers as Record<
        string,
        (event: unknown, c: HookContext) => Promise<unknown>
      >;

      const recursion = (await handlers.tool_call({ toolName: "myflow_subagent" }, ctx)) as
        | { block?: boolean; reason?: string }
        | undefined;
      assert.equal(recursion?.block, true);
      assert.match(recursion!.reason ?? "", /Recursion guard/);

      for (const toolName of ["myflow_ask_user", "myflow_request_approval"]) {
        const blocked = (await handlers.tool_call({ toolName }, ctx)) as
          | { block?: boolean; reason?: string }
          | undefined;
        assert.equal(blocked?.block, true, `${toolName} must stay blocked for a sub-agent`);
        assert.match(blocked!.reason ?? "", /main session/);
      }
    });

    // Main session: neither guard fires.
    const main = makeMockAPI(root);
    extension(main.api);
    for (const toolName of ["myflow_subagent", "myflow_ask_user", "myflow_request_approval"]) {
      const result = (await main.handlers.tool_call({ toolName }, main.ctx)) as
        | { block?: boolean }
        | undefined;
      assert.equal(result, undefined, `${toolName} must pass through for the main session`);
    }
  } finally {
    await cleanup(root, []);
  }
});

test("F7 -7 hasUI:false 时静默：即使宿主仍然提供 ui.notify", async () => {
  const root = makeProject();
  const pids: unknown[] = [];
  try {
    const { api, tools, notified, ctx } = makeMockAPI(root);
    extension(api);
    const { id, pid: wrapperPid } = await startRunningTask(root, tools);
    pids.push(wrapperPid);

    const entry = readEntry(backgroundDir(root), id);
    assert.ok(entry, "the registry entry must exist after start");
    assert.equal(resolveStatus(backgroundDir(root), entry!).status, "running");
    assert.ok(isAlive(wrapperPid), "the task must be alive before shutdown");

    // A headless host: `hasUI` is explicitly false, yet `ui.notify` is still
    // installed — and it counts every call, so "silent" is observable.
    const headlessCtx = {
      ...(ctx as unknown as Record<string, unknown>),
      hasUI: false,
    } as unknown as HookContext;

    // Revert point: drop the `hasUI === false` clause from the shutdown
    // predicate (leaving only "is a notify function present") → this headless
    // context still has `ui.notify`, so one notice is sent and the count
    // assertion below turns red.
    const handlers = (api as unknown as Record<string, unknown>).__handlers as Record<
      string,
      (event: unknown, c: HookContext) => Promise<unknown>
    >;
    await handlers.session_shutdown!({}, headlessCtx);

    assert.equal(notified.length, 0, "hasUI:false must stay silent even when ui.notify exists");
    // Silence is not killing: the whole point of the feature still holds.
    assert.ok(isAlive(wrapperPid), "session_shutdown must NOT kill a background task");
  } finally {
    await cleanup(root, pids);
  }
});
