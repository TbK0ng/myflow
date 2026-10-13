import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

test("myflow-implement agent exists with frontmatter", () => {
  const path = join(ROOT, "agents", "myflow-implement.md");
  assert.ok(existsSync(path));
  const content = readFileSync(path, "utf-8");
  assert.ok(content.startsWith("---"));
  assert.ok(content.includes("name: myflow-implement"));
  assert.ok(content.includes("tools:"));
  assert.ok(content.includes("Recursion Guard"));
});

test("myflow-check agent exists with frontmatter", () => {
  const path = join(ROOT, "agents", "myflow-check.md");
  assert.ok(existsSync(path));
  const content = readFileSync(path, "utf-8");
  assert.ok(content.startsWith("---"));
  assert.ok(content.includes("name: myflow-check"));
  assert.ok(content.includes("tools:"));
  assert.ok(content.includes("Recursion Guard"));
});

test("myflow-research agent exists with frontmatter", () => {
  const path = join(ROOT, "agents", "myflow-research.md");
  assert.ok(existsSync(path));
  const content = readFileSync(path, "utf-8");
  assert.ok(content.startsWith("---"));
  assert.ok(content.includes("name: myflow-research"));
  assert.ok(content.includes("tools:"));
  assert.ok(content.includes("Recursion Guard"));
});

test("myflow-continue command exists", () => {
  const path = join(ROOT, "commands", "myflow-continue.md");
  assert.ok(existsSync(path));
  const content = readFileSync(path, "utf-8");
  assert.ok(content.startsWith("---"));
  assert.ok(content.includes("description:"));
  assert.ok(content.includes("get_context.py"));
});

test("myflow-finish-work command exists", () => {
  const path = join(ROOT, "commands", "myflow-finish-work.md");
  assert.ok(existsSync(path));
  const content = readFileSync(path, "utf-8");
  assert.ok(content.startsWith("---"));
  assert.ok(content.includes("description:"));
  assert.ok(content.includes("get_context.py"));
});
