import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readPromptInjectionSkipKeyword,
  shouldSkipWorkflowState,
  DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD,
} from "../src/escape-hatch.ts";

test("readPromptInjectionSkipKeyword: default when no config", () => {
  const dir = mkdtempSync(join(tmpdir(), "myflow-"));
  mkdirSync(join(dir, ".myflow"));
  try {
    assert.equal(
      readPromptInjectionSkipKeyword(dir),
      DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPromptInjectionSkipKeyword: reads custom keyword from config", () => {
  const dir = mkdtempSync(join(tmpdir(), "myflow-"));
  mkdirSync(join(dir, ".myflow"));
  writeFileSync(
    join(dir, ".myflow", "config.yaml"),
    "prompt_injection:\n  skip_keyword: skip-myflow\n",
  );
  try {
    assert.equal(readPromptInjectionSkipKeyword(dir), "skip-myflow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPromptInjectionSkipKeyword: quoted keyword", () => {
  const dir = mkdtempSync(join(tmpdir(), "myflow-"));
  mkdirSync(join(dir, ".myflow"));
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

test("readPromptInjectionSkipKeyword: inline comment stripped", () => {
  const dir = mkdtempSync(join(tmpdir(), "myflow-"));
  mkdirSync(join(dir, ".myflow"));
  writeFileSync(
    join(dir, ".myflow", "config.yaml"),
    "prompt_injection:\n  skip_keyword: no-myflow # the default\n",
  );
  try {
    assert.equal(readPromptInjectionSkipKeyword(dir), "no-myflow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldSkipWorkflowState: keyword present", () => {
  assert.equal(shouldSkipWorkflowState("please no-myflow this", "no-myflow"), true);
});

test("shouldSkipWorkflowState: keyword absent", () => {
  assert.equal(shouldSkipWorkflowState("just a normal message", "no-myflow"), false);
});

test("shouldSkipWorkflowState: empty keyword never matches", () => {
  assert.equal(shouldSkipWorkflowState("any text", ""), false);
});

test("shouldSkipWorkflowState: word boundary — no partial match", () => {
  assert.equal(shouldSkipWorkflowState("no-myflow-extra", "no-myflow"), false);
  assert.equal(shouldSkipWorkflowState("xno-myflow", "no-myflow"), false);
});

test("shouldSkipWorkflowState: case insensitive", () => {
  assert.equal(shouldSkipWorkflowState("NO-MYFLOW", "no-myflow"), true);
});
