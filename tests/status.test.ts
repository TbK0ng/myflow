import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildStatusReport,
  formatStatusReport,
  nextActionForPhase,
  phaseForStatus,
} from "../.pi/extensions/myflow/status.ts";

const ROOT = join(import.meta.dirname, "..");

function makeProject(status: string, blocks: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-status-"));
  mkdirSync(join(root, ".myflow", ".runtime", "sessions"), { recursive: true });
  mkdirSync(join(root, ".myflow", "tasks", "demo"), { recursive: true });
  writeFileSync(join(root, ".myflow", "tasks", "demo", "task.json"), JSON.stringify({ title: "Demo task", status }));
  writeFileSync(
    join(root, ".myflow", ".runtime", "sessions", "pi_ctx.json"),
    JSON.stringify({ current_task: ".myflow/tasks/demo" }),
  );
  const body = blocks
    .map((name) => `[workflow-state:${name}]\n${name} body\n[/workflow-state:${name}]`)
    .join("\n\n");
  writeFileSync(join(root, ".myflow", "workflow.md"), `${body}\n`);
  return root;
}

test("phaseForStatus maps task statuses to workflow-state keys", () => {
  assert.equal(phaseForStatus(null), "no_task");
  assert.equal(phaseForStatus("planning"), "planning");
  assert.equal(phaseForStatus("in_progress"), "in_progress");
  assert.equal(phaseForStatus("done"), "completed");
  assert.equal(phaseForStatus("completed"), "completed");
  assert.equal(phaseForStatus("custom"), "custom");
});

test("buildStatusReport: active task and matching block", () => {
  const root = makeProject("in_progress", ["no_task", "planning", "in_progress", "completed"]);
  try {
    const report = buildStatusReport(root, "pi_ctx");
    assert.equal(report.phase, "in_progress");
    assert.equal(report.phaseBlockFound, true);
    assert.equal(report.task?.path, ".myflow/tasks/demo");
    assert.equal(report.task?.title, "Demo task");
    assert.equal(report.git, null); // temp dir is not a git repository
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildStatusReport: missing workflow block is reported", () => {
  const root = makeProject("in_progress", ["no_task"]);
  try {
    const report = buildStatusReport(root, "pi_ctx");
    assert.equal(report.phase, "in_progress");
    assert.equal(report.phaseBlockFound, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildStatusReport: no active task", () => {
  const root = mkdtempSync(join(tmpdir(), "myflow-status-none-"));
  mkdirSync(join(root, ".myflow"), { recursive: true });
  writeFileSync(join(root, ".myflow", "workflow.md"), "[workflow-state:no_task]\nidle\n[/workflow-state:no_task]\n");
  try {
    const report = buildStatusReport(root, null);
    assert.equal(report.phase, "no_task");
    assert.equal(report.phaseBlockFound, true);
    assert.equal(report.task, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildStatusReport: reads real git state in this repository", () => {
  const report = buildStatusReport(ROOT, null);
  assert.ok(report.git, "this repo must expose git status");
  assert.equal(typeof report.git!.branch, "string");
  assert.ok(report.git!.dirty >= 0);
});

test("formatStatusReport renders phase, task, git, and next action", () => {
  const text = formatStatusReport({
    phase: "in_progress",
    phaseBlockFound: true,
    task: { path: ".myflow/tasks/demo", status: "in_progress", title: "Demo task" },
    git: { branch: "main", dirty: 2 },
  });
  assert.match(text, /^myflow: in_progress/);
  assert.match(text, /Task:   \.myflow\/tasks\/demo \(in_progress\) — Demo task/);
  assert.match(text, /Git:    main, 2 uncommitted change\(s\)/);
  assert.match(text, /Next:   myflow_subagent/);
});

test("formatStatusReport marks a missing block and no task", () => {
  const text = formatStatusReport({
    phase: "planning",
    phaseBlockFound: false,
    task: null,
    git: null,
  });
  assert.match(text, /no matching workflow-state block/);
  assert.match(text, /Task:   none/);
  assert.match(text, /Git:    unavailable/);
});

test("nextActionForPhase covers every phase with a non-empty hint", () => {
  for (const phase of ["no_task", "planning", "in_progress", "completed", "something-else"]) {
    assert.ok(nextActionForPhase(phase).length > 0);
  }
});
