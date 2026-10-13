import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  taskContextJsonlNames,
  taskContextInputPaths,
  taskContextSignature,
  ContextBudget,
  materialize,
  readJsonlLines,
  DEFAULT_CONTEXT_INJECTION_LIMITS,
} from "../src/context-injection.ts";

test("taskContextJsonlNames returns correct files per agent type", () => {
  assert.deepEqual(taskContextJsonlNames("myflow-implement"), ["implement.jsonl"]);
  assert.deepEqual(taskContextJsonlNames("myflow-check"), ["check.jsonl"]);
  assert.deepEqual(taskContextJsonlNames("myflow-research"), []);
  assert.deepEqual(taskContextJsonlNames(null), ["implement.jsonl", "check.jsonl"]);
  assert.deepEqual(taskContextJsonlNames(), ["implement.jsonl", "check.jsonl"]);
});

test("taskContextInputPaths collects base paths", () => {
  const root = mkdtempSync(join(tmpdir(), "myflow-test-"));
  const taskDir = join(root, "tasks", "demo");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "prd.md"), "# PRD");
  writeFileSync(join(taskDir, "info.md"), "# Info");

  const paths = taskContextInputPaths(root, taskDir, "myflow-implement");
  assert.ok(paths.includes(join(taskDir, "prd.md")));
  assert.ok(paths.includes(join(taskDir, "info.md")));
  assert.ok(paths.includes(join(taskDir, "implement.jsonl")));
  assert.ok(paths.includes(join(root, ".myflow", "config.yaml")));

  rmSync(root, { recursive: true, force: true });
});

test("taskContextInputPaths includes jsonl-referenced files", () => {
  const root = mkdtempSync(join(tmpdir(), "myflow-test-"));
  const taskDir = join(root, "tasks", "demo");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "prd.md"), "# PRD");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "foo.ts"), "console.log(1);");
  writeFileSync(join(taskDir, "implement.jsonl"), '{"file": "src/foo.ts"}\n');

  const paths = taskContextInputPaths(root, taskDir, "myflow-implement");
  assert.ok(paths.includes(join(root, "src", "foo.ts")));

  rmSync(root, { recursive: true, force: true });
});

test("taskContextSignature changes when file changes", () => {
  const root = mkdtempSync(join(tmpdir(), "myflow-test-"));
  const taskDir = join(root, "tasks", "demo");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "prd.md"), "# PRD v1");

  const sig1 = taskContextSignature(root, taskDir, "myflow-implement");
  writeFileSync(join(taskDir, "prd.md"), "# PRD v2 with longer content");
  const sig2 = taskContextSignature(root, taskDir, "myflow-implement");
  assert.notEqual(sig1, sig2);

  rmSync(root, { recursive: true, force: true });
});

test("ContextBudget tracks usage and stops when full", () => {
  const budget = new ContextBudget(10);
  assert.ok(budget.hasRoom(5));
  assert.equal(budget.emit("hello"), "hello");
  assert.ok(budget.hasRoom(5));
  assert.equal(budget.emit("world"), "world");
  assert.ok(!budget.hasRoom(60));
  assert.equal(budget.emit("too long"), null);
});

test("ContextBudget emitCandidate falls back", () => {
  const budget = new ContextBudget(10);
  const result = budget.emitCandidate("primary text", "fallback");
  assert.equal(result, "fallback");
});

test("ContextBudget emitCandidate emits terminal summary when both fail", () => {
  const budget = new ContextBudget(5);
  const result = budget.emitCandidate("primary", "fallback");
  assert.ok(result !== null);
  assert.ok(result.includes("context limit reached"));
});

test("materialize reads file content", () => {
  const root = mkdtempSync(join(tmpdir(), "myflow-test-"));
  const filePath = join(root, "test.txt");
  writeFileSync(filePath, "hello world");

  const result = materialize(filePath, "test.txt", "test", 1024, "file");
  assert.ok(result.block !== null);
  assert.ok(result.block!.includes("hello world"));
  assert.ok(result.block!.includes("[inline]"));

  rmSync(root, { recursive: true, force: true });
});

test("materialize truncates large files", () => {
  const root = mkdtempSync(join(tmpdir(), "myflow-test-"));
  const filePath = join(root, "large.txt");
  writeFileSync(filePath, "a".repeat(1000));

  const result = materialize(filePath, "large.txt", "test", 100, "file");
  assert.ok(result.block !== null);
  assert.ok(result.block!.includes("[truncated]"));
  assert.ok(result.block!.includes("truncated at 100 bytes"));

  rmSync(root, { recursive: true, force: true });
});

test("materialize returns notice for missing files", () => {
  const result = materialize("/nonexistent/file.txt", "file.txt", "test", 1024, "file");
  assert.equal(result.block, null);
  assert.ok(result.notice !== null);
  assert.ok(result.notice!.includes("missing or unreadable"));
});

test("readJsonlLines parses jsonl content", () => {
  const root = mkdtempSync(join(tmpdir(), "myflow-test-"));
  const jsonlPath = join(root, "test.jsonl");
  writeFileSync(jsonlPath, '{"file": "a.ts"}\n{"file": "b.ts"}\n');

  const { lines, omitted } = readJsonlLines(jsonlPath, "test.jsonl");
  assert.equal(lines.length, 2);
  assert.equal(omitted, null);

  rmSync(root, { recursive: true, force: true });
});

test("DEFAULT_CONTEXT_INJECTION_LIMITS has expected values", () => {
  assert.equal(DEFAULT_CONTEXT_INJECTION_LIMITS.max_file_bytes, 32768);
  assert.equal(DEFAULT_CONTEXT_INJECTION_LIMITS.max_artifact_bytes, 65536);
  assert.equal(DEFAULT_CONTEXT_INJECTION_LIMITS.max_total_bytes, 131072);
});
