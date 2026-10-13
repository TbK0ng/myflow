import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findProjectRoot } from "../.pi/extensions/myflow/find-project-root.ts";
import { parseWorkflowStateBlocks } from "../.pi/extensions/myflow/parse-workflow-state.ts";

test("findProjectRoot: finds .myflow/ in cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "myflow-"));
  mkdirSync(join(dir, ".myflow"));
  try {
    assert.equal(findProjectRoot(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findProjectRoot: walks up to parent", () => {
  const dir = mkdtempSync(join(tmpdir(), "myflow-"));
  mkdirSync(join(dir, ".myflow"));
  const child = join(dir, "src", "deep");
  mkdirSync(child, { recursive: true });
  try {
    assert.equal(findProjectRoot(child), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findProjectRoot: returns null when no .myflow/", () => {
  const dir = mkdtempSync(join(tmpdir(), "myflow-"));
  try {
    assert.equal(findProjectRoot(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseWorkflowStateBlocks: extracts all blocks", () => {
  const md = [
    "[workflow-state:no_task]",
    "No active task.",
    "[/workflow-state:no_task]",
    "",
    "[workflow-state:planning]",
    "Load brainstorm; stay in planning.",
    "[/workflow-state:planning]",
    "",
    "[workflow-state:in_progress]",
    "Tools: implement / check.",
    "[/workflow-state:in_progress]",
    "",
    "[workflow-state:completed]",
    "Code committed.",
    "[/workflow-state:completed]",
  ].join("\n");
  const blocks = parseWorkflowStateBlocks(md);
  assert.equal(blocks.size, 4);
  assert.equal(blocks.get("no_task"), "No active task.");
  assert.equal(blocks.get("planning"), "Load brainstorm; stay in planning.");
  assert.equal(blocks.get("in_progress"), "Tools: implement / check.");
  assert.equal(blocks.get("completed"), "Code committed.");
});

test("parseWorkflowStateBlocks: empty file returns empty map", () => {
  const blocks = parseWorkflowStateBlocks("");
  assert.equal(blocks.size, 0);
});

test("parseWorkflowStateBlocks: no blocks returns empty map", () => {
  const blocks = parseWorkflowStateBlocks("just some text\nno blocks here");
  assert.equal(blocks.size, 0);
});

test("parseWorkflowStateBlocks: multiline content preserved", () => {
  const md = [
    "[workflow-state:planning]",
    "Line 1",
    "Line 2",
    "Line 3",
    "[/workflow-state:planning]",
  ].join("\n");
  const blocks = parseWorkflowStateBlocks(md);
  assert.equal(blocks.get("planning"), "Line 1\nLine 2\nLine 3");
});
