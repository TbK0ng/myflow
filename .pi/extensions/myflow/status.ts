/**
 * `/myflow-status` report builder.
 *
 * Answers "where am I?" without a model call: active task, workflow phase,
 * git state, and plan-approval state. Kept free of Pi runtime imports so
 * `node --test` can exercise it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseWorkflowStateBlocks } from "./parse-workflow-state.ts";
import { resolveActiveTaskStatus } from "./turn-cache.ts";

export interface StatusTask {
  path: string;
  status: string;
  title: string;
}

export interface StatusGit {
  branch: string;
  dirty: number;
}

/**
 * Read-only snapshot of the plan-approval gate, taken verbatim from
 * `task.py gate-info`. `status` is passed through unchanged: this module must
 * not collapse the states into its own predicate (design.md §5.1), so a new
 * `task.py` state shows up here without a TS change.
 */
export interface StatusApproval {
  status: string;
  currentHash: string | null;
  approvedHash: string | null;
}

export interface StatusReport {
  /** Workflow-state block key that applies right now. */
  phase: string;
  /** Whether that block actually exists in `.myflow/workflow.md`. */
  phaseBlockFound: boolean;
  task: StatusTask | null;
  git: StatusGit | null;
  /** Approval state, or null when it cannot be read (no task.py / no task). */
  approval?: StatusApproval | null;
}

const GIT_TIMEOUT_MS = 5_000;
const GATE_TIMEOUT_MS = 5_000;
/** `task.py`'s project-relative location, resolved against the project root. */
const TASK_PY_REL = join(".myflow", "scripts", "task.py");

function toPosix(value: string): string {
  return value.split("\\").join("/");
}

function readGitStatus(projectRoot: string): StatusGit | null {
  try {
    const output = execFileSync("git", ["status", "--porcelain=v1", "-b"], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let branch = "";
    let dirty = 0;
    for (const line of output.split(/\r?\n/)) {
      if (line.startsWith("## ")) {
        branch = line.slice(3).split("...")[0]?.trim() ?? "";
      } else if (line.trim()) {
        dirty += 1;
      }
    }
    return { branch, dirty };
  } catch {
    return null;
  }
}

/** Map a task status to the workflow-state block key. */
export function phaseForStatus(status: string | null): string {
  if (!status) return "no_task";
  if (status === "done" || status === "completed") return "completed";
  return status;
}

/**
 * Read the approval snapshot for a task, or null when it cannot be read.
 *
 * The only read path is `task.py gate-info` (design.md §5.1): the plan hash and
 * the answered-question count have exactly one implementation, and duplicating
 * either in TS is the drift defect this avoids. Read-only: nothing is written.
 */
function readApprovalState(projectRoot: string, taskDir: string): StatusApproval | null {
  const script = join(projectRoot, TASK_PY_REL);
  if (!existsSync(script)) return null;
  try {
    const output = execFileSync("python3", [script, "gate-info", taskDir], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: GATE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
    const approval = parsed.approval as Record<string, unknown> | undefined;
    return {
      status: typeof approval?.status === "string" ? approval.status : "missing",
      currentHash: typeof parsed.plan_hash === "string" ? parsed.plan_hash : null,
      approvedHash: typeof approval?.plan_hash === "string" ? approval.plan_hash : null,
    };
  } catch {
    return null;
  }
}

/** First `count` hex chars of a `sha256:<hex>` string (or `(none)`). */
export function shortHash(value: string | null, count = 8): string {
  if (!value) return "(none)";
  const hexpart = value.includes(":") ? value.split(":", 2)[1] : value;
  return hexpart.slice(0, count);
}

/** Render the approval line for `/myflow-status`; `null` means unreadable. */
export function formatApproval(approval: StatusApproval | null | undefined): string {
  if (!approval) return "unavailable (no task.py or no active task)";
  if (approval.status === "stale") {
    return `stale (${shortHash(approval.approvedHash)} → ${shortHash(approval.currentHash)})`;
  }
  return approval.status;
}

/** Build the status report for a project and context key. */
export function buildStatusReport(projectRoot: string, contextKey: string | null): StatusReport {
  const { status, taskDir, taskTitle } = resolveActiveTaskStatus(projectRoot, contextKey);
  const phase = phaseForStatus(status === "no_task" ? null : status);

  let phaseBlockFound = false;
  const workflowPath = join(projectRoot, ".myflow", "workflow.md");
  if (existsSync(workflowPath)) {
    try {
      phaseBlockFound = parseWorkflowStateBlocks(readFileSync(workflowPath, "utf-8")).has(phase);
    } catch {
      phaseBlockFound = false;
    }
  }

  const task: StatusTask | null = taskDir
    ? {
        path: toPosix(relative(projectRoot, taskDir)),
        status,
        title: taskTitle ?? "",
      }
    : null;

  return {
    phase,
    phaseBlockFound,
    task,
    git: readGitStatus(projectRoot),
    approval: taskDir ? readApprovalState(projectRoot, taskDir) : null,
  };
}

/** Human-readable next action for a phase. */
export function nextActionForPhase(phase: string): string {
  switch (phase) {
    case "no_task":
      return "classify this turn; create a task only with user consent (before Phase 1)";
    case "planning":
      return "myflow-brainstorm -> prd.md -> curate jsonl -> task.py start (Phase 1)";
    case "in_progress":
      return "myflow_subagent myflow-implement -> myflow-check -> myflow-update-spec -> commit -> /myflow-finish-work (Phase 2-3)";
    case "completed":
      return "task.py archive <task> (Phase 3.3)";
    default:
      return "read .myflow/workflow.md for the block that matches this status";
  }
}

/** Render the report as the text shown by `/myflow-status`. */
export function formatStatusReport(report: StatusReport): string {
  const lines: string[] = [`myflow: ${report.phase}${report.phaseBlockFound ? "" : " (no matching workflow-state block)"}`];
  lines.push(
    report.task
      ? `Task:   ${report.task.path} (${report.task.status})${report.task.title ? ` — ${report.task.title}` : ""}`
      : "Task:   none",
  );
  lines.push(
    report.git
      ? `Git:    ${report.git.branch || "(detached)"}, ${report.git.dirty} uncommitted change(s)`
      : "Git:    unavailable",
  );
  lines.push(`Approval: ${formatApproval(report.approval)}`);
  lines.push(`Next:   ${nextActionForPhase(report.phase)}`);
  return lines.join("\n");
}
