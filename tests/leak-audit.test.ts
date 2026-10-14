import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// 泄漏审计（S5）。
//
// 背景：S4（提交 85101ee）修掉了两处临时目录泄漏，但只有「读代码」能发现——既没有
// 一条会变红的测试守住它，也没有一条统一的审计 glob 能覆盖所有临时目录。本文件补上
// 这两件事：
//
//   用例 A（静态，便宜）：扫 `tests/**/*.ts`，要求每一处临时目录前缀都以 `myflow-`
//     开头，否则 `%TEMP%/myflow-*` 这条审计 glob 会漏检（S5 待办 1 就是一个真实
//     盲区：前缀写成 `myflow bg space-`，含空格、不以 `myflow-` 开头）。
//   用例 B（运行时，核心）：对明确指定的测试文件做一次真实审计——静态推出它声明的
//     前缀、在隔离子进程里跑该文件、统计隔离根下匹配这些前缀的目录，断言增量为 0。
//
// 前缀由源码静态提取，不写死清单，避免清单随代码漂移。

const TESTS_DIR = import.meta.dirname;
const ROOT = join(TESTS_DIR, "..");

/** 审计 glob 的前缀：`%TEMP%/<AUDIT_PREFIX>*`。 */
const AUDIT_PREFIX = "myflow-";

/**
 * 被审计的文件。它们的临时目录前缀由源码静态提取，不写死在这里。
 * 选这两个是因为它们正是 S4 修掉的两处泄漏点（`subagent.test.ts` 的空 PATH 目录、
 * `bg-start.test.ts` 的清理）。
 */
const AUDIT_FILES = ["subagent.test.ts", "bg-start.test.ts"];

/** 匹配一处由 `tmpdir()` 提供前缀的临时目录调用，捕获其前缀。 */
const MKDTEMP_CALL = /mkdtempSync\(\s*join\(\s*tmpdir\(\)\s*,\s*["'`]([^"'`]*)["'`]\s*\)\s*\)/g;

/** 嵌套 `node --test` 的硬超时，避免套件被挂住。 */
const NESTED_TIMEOUT_MS = 300_000;

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTestFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

/** 提取一个文件里所有临时目录前缀，去重后排序。 */
function extractPrefixes(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(MKDTEMP_CALL)) found.add(match[1]);
  return [...found].sort();
}

function rel(file: string): string {
  return relative(ROOT, file).split("\\").join("/");
}

/** 隔离根下所有以任一前缀开头的目录名，排序。 */
function matchingDirNames(isolationRoot: string, prefixes: string[]): string[] {
  return readdirSync(isolationRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && prefixes.some((prefix) => entry.name.startsWith(prefix)),
    )
    .map((entry) => entry.name)
    .sort();
}

/** `after` 里出现、`before` 里没有的目录名。 */
function added(before: string[], after: string[]): string[] {
  const seen = new Set(before);
  return after.filter((name) => !seen.has(name));
}

/**
 * 建一个进程唯一的隔离根，并把嵌套运行的 `tmpdir()` 指到它。
 *
 * 为什么不直接数真正的 `%TEMP%`：被审计文件**自己**也会在外层全量套件里并行跑
 * （`node --test tests/` 并行执行测试文件），它的临时目录和嵌套运行的目录同名，
 * 直接数 `%TEMP%` 会把别的进程的目录算进来（已实测：外层套件下必然假红）。把嵌套
 * 运行的 `tmpdir()` 隔离开，才是可靠的归因方式。
 *
 * 必须放在真正的 OS 临时目录下、且不能放进仓库的 `.myflow/.runtime/`：被审计的
 * `subagent.test.ts` 会跑一个 CJS 子脚本；隔离根若落在仓库内，Node 会向上找到仓库的
 * `package.json` 的 `"type": "module"`，把那个 `.js` 当成 ESM 而崩（已实测）。放在
 * `%TEMP%` 下就没有这个继承。
 *
 * 前缀带 `myflow-`：万一审计自身的清理失败，`%TEMP%/myflow-*` 这条审计 glob 仍能
 * 看到它。它不等于任何被审计前缀，所以不会污染测量；用 `mkdirSync` 固定前缀建目录，
 * 也不会在用例 A 里多出一条 `mkdtempSync` 前缀。
 */
function makeIsolationRoot(): string {
  const root = join(tmpdir(), `myflow-leak-audit-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

/**
 * 清空 `MYFLOW_*`（与固定测试命令一致，见 harness spec 的 Checklist），并把
 * `TEMP`/`TMP`/`TMPDIR` 指向隔离根，让嵌套测试的 `tmpdir()` 落在隔离根里。
 *
 * `NODE_TEST_CONTEXT` 也必须删：外层套件会给每个测试文件设上它，子进程 `node --test`
 * 一旦继承就会触发 Node 自己的递归守卫，**跳过**嵌套运行而直接返回 0——审计会在什么都
 * 没跑的情况下假绿（已实测）。
 */
function nestedEnv(isolationRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.MYFLOW_AGENT_TYPE;
  delete env.MYFLOW_CONTEXT_ID;
  delete env.MYFLOW_SKIP_BREADCRUMB;
  delete env.MYFLOW_WRITES_UNDER;
  delete env.NODE_TEST_CONTEXT;
  env.TEMP = isolationRoot;
  env.TMP = isolationRoot;
  env.TMPDIR = isolationRoot;
  return env;
}

/** 嵌套进程的摘要，放进失败信息里方便定位（不因非零退出码直接判失败）。 */
function summary(result: ReturnType<typeof spawnSync>): string {
  const text = (value: unknown): string =>
    typeof value === "string" ? value : value == null ? "" : String(value);
  const trim = (value: string): string => {
    const lines = value.split("\n");
    const head = lines.slice(0, 40).join("\n");
    return lines.length > 40 ? `${head}\n… (${lines.length - 40} more lines)` : head;
  };
  return [
    `status=${String(result.status)} signal=${String(result.signal)} ` +
      `error=${result.error ? String((result.error as Error).message) : "none"}`,
    "--- stdout ---",
    trim(text(result.stdout)),
    "--- stderr ---",
    trim(text(result.stderr)),
  ].join("\n");
}

test("leak-audit A: 每个临时目录前缀都以 myflow- 开头", () => {
  // 回退点：把 tests/bg-runner.test.ts 里 S2 -3 的前缀改回 `myflow bg space-`
  //         （含空格、不以 `myflow-` 开头）→ 本用例变红并点名文件与前缀。
  const violations: string[] = [];
  for (const file of listTestFiles(TESTS_DIR)) {
    const prefixes = extractPrefixes(readFileSync(file, "utf-8"));
    for (const prefix of prefixes) {
      if (!prefix.startsWith(AUDIT_PREFIX)) {
        violations.push(`${rel(file)} 声明了前缀 ${JSON.stringify(prefix)}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `临时目录前缀必须以 ${JSON.stringify(AUDIT_PREFIX)} 开头，否则 %TEMP%/${AUDIT_PREFIX}* ` +
      `这条审计 glob 会漏检。违规：\n${violations.join("\n")}`,
  );
});

test("leak-audit B: 被审计的测试文件不再泄漏临时目录", async () => {
  // 回退点：删掉 tests/subagent.test.ts `finally` 里的
  //         `rmSync(emptyPathDir, …)` → 本轮下面的 delta 断言变红，且失败信息里
  //         能看到 `myflow-no-path-*` 的新增目录。
  for (const name of AUDIT_FILES) {
    const target = join(TESTS_DIR, name);
    const prefixes = extractPrefixes(readFileSync(target, "utf-8"));
    assert.ok(
      prefixes.length > 0,
      `${name} 必须至少声明一个临时目录前缀（提取正则失效？）`,
    );

    const isolation = makeIsolationRoot();
    let before: string[] = [];
    let after: string[] = [];
    let result: ReturnType<typeof spawnSync> | undefined;
    try {
      before = matchingDirNames(isolation, prefixes);
      // 嵌套跑：清空 MYFLOW_*、隔离 tmpdir、cwd 为仓库根，参数数组直接给 process.execPath。
      result = spawnSync(process.execPath, ["--test", rel(target)], {
        cwd: ROOT,
        env: nestedEnv(isolation),
        encoding: "utf-8",
        timeout: NESTED_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      });
      after = matchingDirNames(isolation, prefixes);
    } finally {
      // 审计自身的清理失败不改判定；隔离根带 `myflow-` 前缀，万一留下也会被标准
      // 审计 glob（`%TEMP%/myflow-*`）看见。
      try {
        rmSync(isolation, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* 见上 */
      }
    }

    // 先确认嵌套运行**真的执行了测试**：否则「增量为 0」可能只是因为子进程被 Node 的
    // 递归守卫跳过（继承 `NODE_TEST_CONTEXT` 时会发生，已实测），审计就成了假绿。
    // 这一步与退出码无关（spec/TAP 两种报告器都接受）；退出码非零不在这里判失败。
    const output = `${result?.stdout ?? ""}${result?.stderr ?? ""}`;
    const ranTests = /(?:^|\n)(?:ℹ|#)\s*tests\s+\d+/.test(output);
    assert.ok(
      ranTests,
      `嵌套运行 ${name} 没有执行任何测试，审计无效（子进程可能被跳过或未能启动）：\n` +
        `${result ? summary(result) : "(no result)"}`,
    );

    const leaked = added(before, after);
    assert.deepEqual(
      leaked,
      [],
      `跑 ${name} 后泄漏了临时目录（前缀 ${prefixes.join(", ")}）：\n${leaked.join("\n")}\n` +
        `这些目录会一直留在 %TEMP% 下。嵌套运行摘要：\n${result ? summary(result) : "(no result)"}`,
    );
  }
});
