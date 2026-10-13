import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD,
  readPromptInjectionSkipKeyword,
  shouldSkipWorkflowState,
} from "../src/escape-hatch.ts";

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "myflow-"));
  mkdirSync(join(dir, ".myflow"));
  return dir;
}

test("default keyword is no-myflow", () => {
  assert.equal(DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD, "no-myflow");
});

test("no config file returns default keyword", () => {
  const dir = makeProject();
  try {
    assert.equal(readPromptInjectionSkipKeyword(dir), "no-myflow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config with custom keyword", () => {
  const dir = makeProject();
  writeFileSync(
    join(dir, ".myflow", "config.yaml"),
    "prompt_injection:\n  skip_keyword: skip-flow\n",
  );
  try {
    assert.equal(readPromptInjectionSkipKeyword(dir), "skip-flow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config with quoted keyword", () => {
  const dir = makeProject();
  writeFileSync(
    join(dir, ".myflow", "config.yaml"),
    'prompt_injection:\n  skip_keyword: "my-skip"\n',
  );
  try {
    assert.equal(readPromptInjectionSkipKeyword(dir), "my-skip");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config with inline comment", () => {
  const dir = makeProject();
  writeFileSync(
    join(dir, ".myflow", "config.yaml"),
    "prompt_injection:\n  skip_keyword: flow-skip # the keyword\n",
  );
  try {
    assert.equal(readPromptInjectionSkipKeyword(dir), "flow-skip");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config with non-string scalar returns default", () => {
  const dir = makeProject();
  writeFileSync(
    join(dir, ".myflow", "config.yaml"),
    "prompt_injection:\n  skip_keyword: 123\n",
  );
  try {
    assert.equal(readPromptInjectionSkipKeyword(dir), "no-myflow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldSkipWorkflowState: keyword at word boundary", () => {
  assert.ok(shouldSkipWorkflowState("please no-myflow this", "no-myflow"));
  assert.ok(shouldSkipWorkflowState("no-myflow", "no-myflow"));
  assert.ok(shouldSkipWorkflowState("NO-MYFLOW", "no-myflow"));
});

test("shouldSkipWorkflowState: keyword not at word boundary", () => {
  assert.ok(!shouldSkipWorkflowState("xno-myflow", "no-myflow"));
  assert.ok(!shouldSkipWorkflowState("no-myflowx", "no-myflow"));
  assert.ok(!shouldSkipWorkflowState("no-myflow-2", "no-myflow"));
});

test("shouldSkipWorkflowState: empty keyword never matches", () => {
  assert.ok(!shouldSkipWorkflowState("anything", ""));
});
