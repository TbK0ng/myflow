import { readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { parseWorkflowStateBlocks } from "./parse-workflow-state.ts";

/** Session overview text injected into every turn. */
export const SESSION_OVERVIEW_TEXT =
  "You are operating inside the myflow harness. " +
  "Follow the active workflow state block for the current step.";

/**
 * True when `candidate` resolves to a real directory strictly inside the
 * project's `.myflow/tasks/`.
 *
 * A session pointer is not always something the user typed: a stale or
 * poisoned `current_task` can name an absolute path, a `..` escape, or a
 * symlink that leaves the tasks tree. Both sides are resolved so a task
 * directory symlinked outside is refused too. The caller keeps its own
 * (unresolved) candidate on success, because the returned task dir is later
 * turned back into a display path with `relative()`; handing it a realpath
 * would misreport a project root that itself sits behind a symlink.
 */
function isTaskDirWithinTasks(projectRoot: string, candidate: string): boolean {
  try {
    const tasksRoot = realpathSync(join(projectRoot, ".myflow", "tasks"));
    const target = realpathSync(candidate);
    const rel = relative(tasksRoot, target);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

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
  if (!isTaskDirWithinTasks(projectRoot, taskDir)) {
    // A ref that leaves .myflow/tasks/ is not an active task: treat it as
    // no_task rather than resolving it and reporting it as stale.
    return { status: "no_task", taskDir: null, taskTitle: null };
  }
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
