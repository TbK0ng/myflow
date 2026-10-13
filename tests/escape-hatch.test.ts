import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD,
  readPromptInjectionSkipKeyword,
  shouldSkipWorkflowState,
} from "../src/escape-hatch.ts";

test("default skip keyword is no-myflow", () => {
  assert.equal(DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD, "no-myflow");
});

test("readPromptInjectionSkipKeyword returns default when config absent", () => {
  const root = mkdtempSync(join(tmpdir(), "myflow-eh-"));
  try {
    assert.equal(readPromptInjectionSkipKeyword(root), "no-myflow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readPromptInjectionSkipKeyword reads skip_keyword from config.yaml", () => {
  const root = mkdtempSync(join(tmpdir(), "myflow-eh-"));
  try {
    mkdirSync(join(root, ".myflow"), { recursive: true });
    writeFileSync(
      join(root, ".myflow", "config.yaml"),
      "prompt_injection:\n  skip_keyword: \"skip-flow\"\n",
      "utf-8",
    );
    assert.equal(readPromptInjectionSkipKeyword(root), "skip-flow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readPromptInjectionSkipKeyword ignores non-string scalars", () => {
  const root = mkdtempSync(join(tmpdir(), "myflow-eh-"));
  try {
    mkdirSync(join(root, ".myflow"), { recursive: true });
    writeFileSync(
      join(root, ".myflow", "config.yaml"),
      "prompt_injection:\n  skip_keyword: 123\n",
      "utf-8",
    );
    assert.equal(readPromptInjectionSkipKeyword(root), "no-myflow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readPromptInjectionSkipKeyword strips inline comments", () => {
  const root = mkdtempSync(join(tmpdir(), "myflow-eh-"));
  try {
    mkdirSync(join(root, ".myflow"), { recursive: true });
    writeFileSync(
      join(root, ".myflow", "config.yaml"),
      "prompt_injection:\n  skip_keyword: \"my-skip\" # the keyword\n",
      "utf-8",
    );
    assert.equal(readPromptInjectionSkipKeyword(root), "my-skip");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shouldSkipWorkflowState matches keyword at word boundary", () => {
  assert.equal(shouldSkipWorkflowState("please no-myflow today", "no-myflow"), true);
  assert.equal(shouldSkipWorkflowState("no-myflow", "no-myflow"), true);
  assert.equal(shouldSkipWorkflowState("(no-myflow)", "no-myflow"), true);
});

test("shouldSkipWorkflowState rejects keyword embedded in a word", () => {
  assert.equal(shouldSkipWorkflowState("no-myflowx", "no-myflow"), false);
  assert.equal(shouldSkipWorkflowState("xno-myflow", "no-myflow"), false);
  assert.equal(shouldSkipWorkflowState("foo-no-myflow", "no-myflow"), false);
});

test("shouldSkipWorkflowState is case-insensitive", () => {
  assert.equal(shouldSkipWorkflowState("NO-MYFLOW", "no-myflow"), true);
  assert.equal(shouldSkipWorkflowState("No-MyFlow", "no-myflow"), true);
});

test("shouldSkipWorkflowState never matches an empty keyword", () => {
  assert.equal(shouldSkipWorkflowState("anything", ""), false);
});
