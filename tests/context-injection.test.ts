import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  taskContextJsonlNames,
  taskContextInputPaths,
  taskContextSignature,
  readContextInjectionLimits,
  ContextBudget,
  materialize,
  readJsonlLines,
  DEFAULT_CONTEXT_INJECTION_LIMITS,
  buildTaskContext,
  resolveProjectFile,
  displayProjectPath,
} from "../.pi/extensions/myflow/context-injection.ts";

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "myflow-"));
  mkdirSync(join(dir, ".myflow"));
  return dir;
}

test("taskContextJsonlNames: implement agent", () => {
  assert.deepEqual(taskContextJsonlNames("myflow-implement"), ["implement.jsonl"]);
});

test("taskContextJsonlNames: check agent", () => {
  assert.deepEqual(taskContextJsonlNames("myflow-check"), ["check.jsonl"]);
});

test("taskContextJsonlNames: research agent", () => {
  assert.deepEqual(taskContextJsonlNames("myflow-research"), []);
});

test("taskContextJsonlNames: null agent gets no manifest", () => {
  assert.deepEqual(taskContextJsonlNames(null), []);
});

test("taskContextJsonlNames: custom agent gets no manifest", () => {
  assert.deepEqual(taskContextJsonlNames("my-custom-agent"), []);
});

test("taskContextInputPaths: includes config, prd, design, implement, info", () => {
  const dir = makeProject();
  const taskDir = join(dir, ".myflow", "tasks", "test");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "prd.md"), "# PRD");
  writeFileSync(join(taskDir, "design.md"), "# Design");
  writeFileSync(join(taskDir, "implement.md"), "# Plan");
  writeFileSync(join(taskDir, "info.md"), "# Info");
  try {
    const paths = taskContextInputPaths(dir, taskDir);
    assert.ok(paths.includes(join(dir, ".myflow", "config.yaml")));
    assert.ok(paths.includes(join(taskDir, "prd.md")));
    assert.ok(paths.includes(join(taskDir, "design.md")));
    assert.ok(paths.includes(join(taskDir, "implement.md")));
    assert.ok(paths.includes(join(taskDir, "info.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("taskContextInputPaths: includes jsonl referenced files", () => {
  const dir = makeProject();
  const taskDir = join(dir, ".myflow", "tasks", "test");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "main.ts"), "console.log('hi');");
  writeFileSync(join(taskDir, "implement.jsonl"), '{"file": "src/main.ts"}\n');
  try {
    const paths = taskContextInputPaths(dir, taskDir, "myflow-implement");
    assert.ok(paths.includes(join(taskDir, "implement.jsonl")));
    assert.ok(paths.includes(join(dir, "src", "main.ts")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("taskContextSignature: includes file paths", () => {
  const dir = makeProject();
  const taskDir = join(dir, ".myflow", "tasks", "test");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "prd.md"), "# PRD v1");
  const sig = taskContextSignature(dir, taskDir);
  assert.ok(sig.includes(join(taskDir, "prd.md")));
  assert.ok(sig.includes("config.yaml"));
  rmSync(dir, { recursive: true, force: true });
});

test("readContextInjectionLimits: default when no config", () => {
  const dir = makeProject();
  try {
    const limits = readContextInjectionLimits(dir);
    assert.deepEqual(limits, DEFAULT_CONTEXT_INJECTION_LIMITS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readContextInjectionLimits: custom limits", () => {
  const dir = makeProject();
  writeFileSync(
    join(dir, ".myflow", "config.yaml"),
    "context_injection:\n  max_file_bytes: 1024\n  max_total_bytes: 2048\n",
  );
  try {
    const limits = readContextInjectionLimits(dir);
    assert.equal(limits.max_file_bytes, 1024);
    assert.equal(limits.max_total_bytes, 2048);
    assert.equal(limits.max_artifact_bytes, DEFAULT_CONTEXT_INJECTION_LIMITS.max_artifact_bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ContextBudget: hasRoom within limit", () => {
  const budget = new ContextBudget(100);
  assert.ok(budget.hasRoom(50));
  assert.ok(!budget.hasRoom(150));
});

test("ContextBudget: emit within limit", () => {
  const budget = new ContextBudget(100);
  assert.equal(budget.emit("hello"), "hello");
  assert.equal(budget.emit("world"), "world");
});

test("ContextBudget: emit exceeds limit returns null", () => {
  const budget = new ContextBudget(10);
  assert.equal(budget.emit("hello world"), null);
});

test("ContextBudget: emitCandidate falls back", () => {
  const budget = new ContextBudget(10);
  const result = budget.emitCandidate("too long text", "short");
  assert.equal(result, "short");
});

test("ContextBudget: emitCandidate terminal summary", () => {
  const budget = new ContextBudget(200);
  const longText = "x".repeat(500);
  const result = budget.emitCandidate(longText, longText);
  assert.ok(result !== null);
  assert.ok(result.includes("context limit reached"));
});

test("materialize: inline file", () => {
  const dir = makeProject();
  const filePath = join(dir, "test.txt");
  writeFileSync(filePath, "hello world");
  try {
    const result = materialize(filePath, "test.txt", "test", 1024, "file");
    assert.ok(result.block !== null);
    assert.ok(result.block!.includes("### test.txt [inline]"));
    assert.ok(result.block!.includes("hello world"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("materialize: truncated file", () => {
  const dir = makeProject();
  const filePath = join(dir, "test.txt");
  writeFileSync(filePath, "hello world this is a longer text");
  try {
    const result = materialize(filePath, "test.txt", "test", 11, "file");
    assert.ok(result.block !== null);
    assert.ok(result.block!.includes("[truncated]"));
    assert.ok(result.block!.includes("truncated at 11 bytes"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("materialize: missing file", () => {
  const dir = makeProject();
  try {
    const result = materialize(join(dir, "missing.txt"), "missing.txt", "test", 1024, "file");
    assert.equal(result.block, null);
    assert.ok(result.notice.includes("missing or unreadable"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJsonlLines: parses valid jsonl", () => {
  const dir = makeProject();
  const jsonlPath = join(dir, "test.jsonl");
  writeFileSync(jsonlPath, '{"file": "a.ts"}\n{"file": "b.ts"}\n');
  try {
    const { lines, omitted } = readJsonlLines(jsonlPath, "test.jsonl");
    assert.equal(lines.length, 2);
    assert.equal(omitted, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJsonlLines: missing file returns empty", () => {
  const dir = makeProject();
  try {
    const { lines, omitted } = readJsonlLines(join(dir, "missing.jsonl"), "missing.jsonl");
    assert.equal(lines.length, 0);
    assert.equal(omitted, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveProjectFile: inside project root", () => {
  const dir = makeProject();
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    const filePath = join(dir, "src", "foo.ts");
    writeFileSync(filePath, "console.log('hi');");
    const resolved = resolveProjectFile(dir, "src/foo.ts");
    assert.equal(resolved, realpathSync(filePath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveProjectFile: escaping project root returns null", () => {
  const dir = makeProject();
  try {
    const resolved = resolveProjectFile(dir, "../outside.ts");
    assert.equal(resolved, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveProjectFile: missing file returns null", () => {
  const dir = makeProject();
  try {
    const resolved = resolveProjectFile(dir, "missing.ts");
    assert.equal(resolved, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("displayProjectPath: relative to project root", () => {
  const dir = makeProject();
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    const filePath = join(dir, "src", "foo.ts");
    writeFileSync(filePath, "console.log('hi');");
    const display = displayProjectPath(dir, filePath);
    assert.equal(display, "src/foo.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("displayProjectPath: relative to task dir", () => {
  const dir = makeProject();
  try {
    const taskDir = join(dir, ".myflow", "tasks", "demo");
    mkdirSync(taskDir, { recursive: true });
    const filePath = join(taskDir, "prd.md");
    writeFileSync(filePath, "# PRD");
    const display = displayProjectPath(dir, filePath, taskDir);
    assert.equal(display, ".myflow/tasks/demo/prd.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildTaskContext: prd.md only", () => {
  const dir = makeProject();
  try {
    const taskDir = join(dir, ".myflow", "tasks", "demo");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "prd.md"), "# PRD\n\nBuild a widget.");
    const ctx = buildTaskContext(dir, taskDir, "myflow-implement");
    assert.ok(ctx.includes("<task-context>"));
    assert.ok(ctx.includes("Build a widget."));
    assert.ok(ctx.includes("prd.md"));
    assert.ok(ctx.includes("</task-context>"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildTaskContext: prd.md and info.md", () => {
  const dir = makeProject();
  try {
    const taskDir = join(dir, ".myflow", "tasks", "demo");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "prd.md"), "# PRD");
    writeFileSync(join(taskDir, "info.md"), "# Info\n\nSome details.");
    const ctx = buildTaskContext(dir, taskDir, "myflow-implement");
    assert.ok(ctx.includes("Some details."));
    assert.ok(ctx.includes("info.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildTaskContext: jsonl referenced files", () => {
  const dir = makeProject();
  try {
    const taskDir = join(dir, ".myflow", "tasks", "demo");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "prd.md"), "# PRD");
    const srcDir = join(dir, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "foo.ts"), "export const x = 1;");
    writeFileSync(
      join(taskDir, "implement.jsonl"),
      JSON.stringify({ file: "src/foo.ts", reason: "implementation" }) + "\n",
    );
    const ctx = buildTaskContext(dir, taskDir, "myflow-implement");
    assert.ok(ctx.includes("export const x = 1;"));
    assert.ok(ctx.includes("src/foo.ts"));
    assert.ok(ctx.includes("implement.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildTaskContext: empty task dir returns empty string", () => {
  const dir = makeProject();
  try {
    const taskDir = join(dir, ".myflow", "tasks", "empty");
    mkdirSync(taskDir, { recursive: true });
    const ctx = buildTaskContext(dir, taskDir, "myflow-implement");
    assert.equal(ctx, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildTaskContext: research agent skips jsonl", () => {
  const dir = makeProject();
  try {
    const taskDir = join(dir, ".myflow", "tasks", "demo");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "prd.md"), "# PRD");
    const srcDir = join(dir, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "foo.ts"), "export const x = 1;");
    writeFileSync(
      join(taskDir, "implement.jsonl"),
      JSON.stringify({ file: "src/foo.ts", reason: "implementation" }) + "\n",
    );
    const ctx = buildTaskContext(dir, taskDir, "myflow-research");
    assert.ok(!ctx.includes("export const x = 1;"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildTaskContext: design.md and implement.md are injected", () => {
  const dir = makeProject();
  try {
    const taskDir = join(dir, ".myflow", "tasks", "demo");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "prd.md"), "# PRD\n\nBuild a widget.");
    writeFileSync(join(taskDir, "design.md"), "# Design\n\nUse an event queue.");
    writeFileSync(join(taskDir, "implement.md"), "# Plan\n\nStep one: enqueue.");
    const ctx = buildTaskContext(dir, taskDir, "myflow-implement");
    assert.ok(ctx.includes("Use an event queue."));
    assert.ok(ctx.includes("Step one: enqueue."));
    assert.ok(ctx.includes("design.md"));
    assert.ok(ctx.includes("implement.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildTaskContext: absent design.md / implement.md are skipped silently", () => {
  const dir = makeProject();
  try {
    const taskDir = join(dir, ".myflow", "tasks", "demo");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "prd.md"), "# PRD\n\nOnly the PRD exists.");
    const ctx = buildTaskContext(dir, taskDir, "myflow-implement");
    // No error, no omitted/missing notice: a missing artifact is just absent.
    assert.ok(ctx.includes("Only the PRD exists."));
    assert.ok(!ctx.includes("design.md"));
    assert.ok(!ctx.includes("implement.md"));
    assert.ok(!ctx.includes("missing or unreadable"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildTaskContext: design/implement truncate like prd.md under max_artifact_bytes", () => {
  const dir = makeProject();
  writeFileSync(
    join(dir, ".myflow", "config.yaml"),
    "context_injection:\n  max_artifact_bytes: 40\n  max_total_bytes: 100000\n",
  );
  try {
    const taskDir = join(dir, ".myflow", "tasks", "demo");
    mkdirSync(taskDir, { recursive: true });
    const big = (label: string) => `# ${label}\n\n${"x".repeat(200)}`;
    writeFileSync(join(taskDir, "prd.md"), big("PRD"));
    writeFileSync(join(taskDir, "design.md"), big("Design"));
    writeFileSync(join(taskDir, "implement.md"), big("Plan"));
    writeFileSync(join(taskDir, "info.md"), big("Info"));
    const ctx = buildTaskContext(dir, taskDir, "myflow-implement");
    const truncations = ctx.match(/truncated at 40 bytes/g) ?? [];
    assert.equal(truncations.length, 4, "all four artifacts share the max_artifact_bytes cap");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildTaskContext: artifacts precede the curated jsonl files", () => {
  const dir = makeProject();
  try {
    const taskDir = join(dir, ".myflow", "tasks", "demo");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "prd.md"), "PRD_MARKER");
    writeFileSync(join(taskDir, "design.md"), "DESIGN_MARKER");
    writeFileSync(join(taskDir, "implement.md"), "PLAN_MARKER");
    writeFileSync(join(taskDir, "info.md"), "INFO_MARKER");
    mkdirSync(join(dir, "spec"), { recursive: true });
    writeFileSync(join(dir, "spec", "ref.md"), "JSONL_MARKER");
    writeFileSync(
      join(taskDir, "implement.jsonl"),
      JSON.stringify({ file: "spec/ref.md", reason: "curated" }) + "\n",
    );
    const ctx = buildTaskContext(dir, taskDir, "myflow-implement");
    const at = (marker: string) => ctx.indexOf(marker);
    assert.ok(at("PRD_MARKER") < at("DESIGN_MARKER"));
    assert.ok(at("DESIGN_MARKER") < at("PLAN_MARKER"));
    assert.ok(at("PLAN_MARKER") < at("INFO_MARKER"));
    // Artifacts are emitted first, so the curated jsonl is what degrades first
    // under total-budget pressure.
    assert.ok(at("INFO_MARKER") < at("JSONL_MARKER"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildTaskContext: total budget still holds after design/implement are added", () => {
  const dir = makeProject();
  writeFileSync(
    join(dir, ".myflow", "config.yaml"),
    "context_injection:\n  max_artifact_bytes: 300\n  max_total_bytes: 1200\n",
  );
  try {
    const taskDir = join(dir, ".myflow", "tasks", "demo");
    mkdirSync(taskDir, { recursive: true });
    const filler = "y".repeat(800);
    writeFileSync(join(taskDir, "prd.md"), `# PRD\n\nPRD_MARKER ${filler}`);
    writeFileSync(join(taskDir, "design.md"), `# Design\n\nDESIGN_MARKER ${filler}`);
    writeFileSync(join(taskDir, "implement.md"), `# Plan\n\nPLAN_MARKER ${filler}`);
    writeFileSync(join(taskDir, "info.md"), `# Info\n\nINFO_MARKER ${filler}`);
    mkdirSync(join(dir, "spec"), { recursive: true });
    writeFileSync(join(dir, "spec", "ref.md"), "JSONL_MARKER curated content");
    writeFileSync(
      join(taskDir, "implement.jsonl"),
      JSON.stringify({ file: "spec/ref.md", reason: "curated" }) + "\n",
    );
    const ctx = buildTaskContext(dir, taskDir, "myflow-implement");
    assert.ok(
      Buffer.byteLength(ctx, "utf-8") <= 1200,
      "context must stay within context_injection.max_total_bytes",
    );
    // Degradation is never silent: the budget gives way with a notice, and the
    // jsonl entry (emitted last) is the first thing dropped.
    assert.ok(ctx.includes("context limit reached") || ctx.includes("[myflow: omitted"));
    assert.ok(!ctx.includes("JSONL_MARKER"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the max_file_bytes default has one value across TypeScript and Python", () => {
  // `context-injection.ts` truncates at this number; `task.py validate` warns at
  // it. Two languages, two literals, so the pair is compared here rather than
  // trusted to stay in sync.
  const taskPy = readFileSync(join(import.meta.dirname, "..", ".myflow", "scripts", "task.py"), "utf-8");
  const match = /def _context_max_file_bytes\(\)[\s\S]*?default = (\d+)/.exec(taskPy);
  assert.ok(match, "task.py must keep the max_file_bytes default in _context_max_file_bytes");
  assert.equal(
    Number(match[1]),
    DEFAULT_CONTEXT_INJECTION_LIMITS.max_file_bytes,
    "task.py's max_file_bytes default must equal the extension's",
  );
});
