import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD,
  shouldSkipWorkflowState,
} from "../.pi/extensions/myflow/escape-hatch.ts";

test("default keyword is no-myflow", () => {
  assert.equal(DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD, "no-myflow");
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
