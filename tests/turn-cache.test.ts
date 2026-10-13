import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnContextCache, SESSION_OVERVIEW_TEXT } from "../src/turn-cache.ts";

function makeProject(workflowMd: string): string {
  const dir = mkdtempSync(join(tmpdir(), "myflow-turn-cache-"));
  mkdirSync(join(dir, ".myflow"), { recursive: true });
  if (workflowMd) {
    writeFileSync(join(dir, ".myflow", "workflow.md"), workflowMd, "utf-8");
  }
  return dir;
}

test("TurnContextCache injects workflow state block", () => {
  const dir = makeProject(
    "[workflow-state:implement]\nDo the thing.\n[/workflow-state:implement]",
  );
  try {
    const cache = new TurnContextCache();
    cache.beginTurn(false);
    const { workflowMsg } = cache.get(dir, null);
    assert.ok(workflowMsg.includes("[workflow-state:implement]"));
    assert.ok(workflowMsg.includes("Do the thing."));
    assert.ok(workflowMsg.includes(SESSION_OVERVIEW_TEXT));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TurnContextCache returns empty when skipping", () => {
  const dir = makeProject(
    "[workflow-state:implement]\nDo the thing.\n[/workflow-state:implement]",
  );
  try {
    const cache = new TurnContextCache();
    cache.beginTurn(true);
    const { workflowMsg } = cache.get(dir, null);
    assert.equal(workflowMsg, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TurnContextCache falls back to default message", () => {
  const dir = makeProject("");
  try {
    const cache = new TurnContextCache();
    cache.beginTurn(false);
    const { workflowMsg } = cache.get(dir, null);
    assert.ok(workflowMsg.includes("Refer to workflow.md for current step."));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TurnContextCache caches within TTL", () => {
  const dir = makeProject(
    "[workflow-state:implement]\nDo the thing.\n[/workflow-state:implement]",
  );
  try {
    const cache = new TurnContextCache();
    cache.beginTurn(false);
    const first = cache.get(dir, null);
    const second = cache.get(dir, null);
    assert.equal(first.workflowMsg, second.workflowMsg);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TurnContextCache invalidates on beginTurn", () => {
  const dir = makeProject(
    "[workflow-state:implement]\nDo the thing.\n[/workflow-state:implement]",
  );
  try {
    const cache = new TurnContextCache();
    cache.beginTurn(false);
    const first = cache.get(dir, null);
    assert.ok(first.workflowMsg.includes("Do the thing."));
    cache.beginTurn(true);
    const second = cache.get(dir, null);
    assert.equal(second.workflowMsg, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
