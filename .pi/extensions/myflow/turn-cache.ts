import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseWorkflowStateBlocks } from "./parse-workflow-state.ts";

/** Session overview text injected into every turn. */
export const SESSION_OVERVIEW_TEXT =
  "You are operating inside the myflow harness. " +
  "Follow the active workflow state block for the current step.";

/** Resolve the active task status for a project and context key. */
export function resolveActiveTaskStatus(
  projectRoot: string,
  contextKey: string | null,
): { status: string; taskDir: string | null; taskTitle: string | null } {
  const sessionsDir = join(projectRoot, ".myflow", ".runtime", "sessions");
  if (!existsSync(sessionsDir)) {
    return { status: "no_task", taskDir: null, taskTitle: null };
  }

  let sessionFilePath: string | null = null;

  if (contextKey) {
    const candidate = join(sessionsDir, `${contextKey}.json`);
    if (existsSync(candidate)) {
      sessionFilePath = candidate;
    } else {
      return { status: "no_task", taskDir: null, taskTitle: null };
    }
  } else {
    let sessionFiles: string[];
    try {
      sessionFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
    } catch {
      return { status: "no_task", taskDir: null, taskTitle: null };
    }
    if (sessionFiles.length === 1) {
      sessionFilePath = join(sessionsDir, sessionFiles[0]);
    } else {
      return { status: "no_task", taskDir: null, taskTitle: null };
    }
  }

  let sessionData: Record<string, unknown>;
  try {
    sessionData = JSON.parse(readFileSync(sessionFilePath, "utf-8"));
  } catch {
    return { status: "no_task", taskDir: null, taskTitle: null };
  }

  const currentTask = sessionData.current_task;
  if (typeof currentTask !== "string" || !currentTask) {
    return { status: "no_task", taskDir: null, taskTitle: null };
  }

  const taskDir = resolve(projectRoot, currentTask);
  const taskJsonPath = join(taskDir, "task.json");
  if (!existsSync(taskJsonPath)) {
    return { status: "no_task", taskDir: null, taskTitle: null };
  }

  let taskData: Record<string, unknown>;
  try {
    taskData = JSON.parse(readFileSync(taskJsonPath, "utf-8"));
  } catch {
    return { status: "no_task", taskDir: null, taskTitle: null };
  }

  return {
    status: typeof taskData.status === "string" ? taskData.status : "planning",
    taskDir,
    taskTitle: typeof taskData.title === "string" ? taskData.title : null,
  };
}

/**
 * Per-turn cache that avoids re-parsing workflow state on every tool call.
 * The cache is invalidated at the start of each turn and expires after 1.5 s.
 */
export class TurnContextCache {
  private key: string | null = null;
  private timestamp = 0;
  private workflowMsg = "";
  private skipThisTurn = false;
  private static readonly TTL_MS = 1500;

  beginTurn(skipThisTurn: boolean): void {
    this.skipThisTurn = skipThisTurn;
    this.key = null;
  }

  get(projectRoot: string, contextKey: string | null): { workflowMsg: string } {
    const now = Date.now();
    const cacheKey = `${projectRoot}:${contextKey ?? ""}`;
    if (
      this.key === cacheKey &&
      now - this.timestamp < TurnContextCache.TTL_MS
    ) {
      return { workflowMsg: this.workflowMsg };
    }

    const { status } = resolveActiveTaskStatus(projectRoot, contextKey);

    const workflowPath = join(projectRoot, ".myflow", "workflow.md");
    let workflowMd = "";
    try {
      workflowMd = readFileSync(workflowPath, "utf-8");
    } catch {
      // No workflow file; fall through to the default message.
    }
    let workflowBody = "";
    if (workflowMd) {
      const blocks = parseWorkflowStateBlocks(workflowMd);
      const content = blocks.get(status);
      if (content) {
        workflowBody = `[workflow-state:${status}]\n${content}\n[/workflow-state:${status}]`;
      }
    }
    if (!workflowBody) {
      workflowBody = "Refer to workflow.md for current step.";
    }

    this.workflowMsg = this.skipThisTurn
      ? ""
      : `<workflow-state>\n${workflowBody}\n</workflow-state>\n\n<session-overview>\n${SESSION_OVERVIEW_TEXT}\n</session-overview>`;

    this.key = cacheKey;
    this.timestamp = now;
    return { workflowMsg: this.workflowMsg };
  }
}
