/**
 * `myflow_request_approval` — hand the current plan to the user for approval
 * and, only when they agree, write `approval.json`.
 *
 * It is the second half of the plan-approval gate. `myflow_ask_user` records
 * that the user was asked; this tool records that they approved. Planning is
 * not finished until `task.py start` finds an `approval.json` whose
 * `plan_hash` matches the *current* plan (see `.myflow/scripts/task.py`).
 *
 * Three hard rules, all covered by `tests/plan-approval-tool.test.ts`:
 *
 *   1. **Never fabricate consent.** No UI, a dismissed dialog, or a failed
 *      pre-check never writes `approval.json`. There is deliberately no
 *      default or auto-approve branch that produces the file.
 *   2. **One source for the gate's numbers.** The plan hash and the
 *      "answered question" count come from a single `task.py gate-info` call;
 *      this module neither hashes the plan nor reads `questions.jsonl` itself
 *      (design.md §3.3 / ADR-1 — a second copy of either would drift).
 *   3. **Pre-checks run before the dialog.** No active task, a task outside
 *      `.myflow/tasks/`, a task with no plan file, or a plan with zero
 *      answered questions is refused without prompting.
 *
 * Dependency injection, not an import of `./index.ts`: `index.ts` registers
 * this tool, so importing it back would create the `index.ts` -> `approval.ts`
 * -> `index.ts` cycle. The sub-agent flag and the context-key deriver are
 * injected by the caller, exactly like `registerMyflowSubagent` receives
 * `deriveContextKey`.
 *
 * Runtime imports stay limited to Node builtins plus sibling modules that are
 * themselves dependency-free, so the module is importable under `node --test`.
 */

import { writeFileSync } from "node:fs";
import { isAbsolute, join, relative, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { findProjectRoot } from "./find-project-root.ts";
import { resolveActiveTaskStatus } from "./turn-cache.ts";

export const APPROVAL_TOOL_NAME = "myflow_request_approval";

/**
 * The on-disk approval record, relative to the active task directory. It
 * matches `APPROVAL_FILE` in `.myflow/scripts/task.py` byte for byte: that
 * script reads the file this tool writes, so the filename and the field names
 * are a cross-language contract, not a local choice.
 */
export const APPROVAL_FILE = "approval.json";

/** `task.py`'s project-relative location, resolved against the project root. */
const TASK_PY_REL = join(".myflow", "scripts", "task.py");

/** The number of hex chars shown in the confirmation dialog. */
const SHORT_HASH_CHARS = 12;

/** `approved_by` value for a TUI approval (the CLI writes `"cli"`). */
export const APPROVED_BY = "ui-confirm";

/** How the approval attempt ended. `cancelled`, `no-ui`, `rejected` and
 * `error` are all *not* approvals. */
export type ApprovalVia = "ui-confirm" | "cancelled" | "no-ui" | "rejected" | "error";

export interface ApprovalResult {
  approved: boolean;
  via: ApprovalVia;
  plan_hash?: string;
  plan_files?: string[];
  /** Present for `no-ui` / `error` results; the model must follow it verbatim. */
  instruction?: string;
  /** Present for `rejected` results: which pre-check(s) failed. */
  reasons?: string[];
}

/** The subset of Pi's `ExtensionContext` this tool touches. */
export interface ApprovalContext {
  cwd: string;
  mode?: string;
  hasUI?: boolean;
  /** Pi's read-only session manager; supplies the id recorded in approval.json. */
  sessionManager?: {
    getSessionId?: () => string | undefined;
  };
  ui?: {
    confirm?: (title: string, message: string) => Promise<boolean>;
  };
}

/**
 * Capabilities injected by the caller. `isSubAgent` exists so this module does
 * not have to import `./index.ts` just to call `detectAgentType` (which would
 * close the registration cycle described at the top of the file).
 */
export interface ApprovalRegistration {
  /** Derive the parent session's myflow context key, if any. */
  deriveContextKey?: (ctx: unknown) => string | null;
  /** Whether this process is a dispatched sub-agent. */
  isSubAgent?: boolean;
}

/** Minimal `pi` surface used by the registration function. */
export interface ApprovalPi {
  registerTool(tool: Record<string, unknown>): void;
}

/** The parsed shape of `task.py gate-info`'s single-line JSON output. */
interface GateInfo {
  plan_hash: string | null;
  plan_files: string[];
  questions_answered: number;
  approval: { status: string; plan_hash: string | null };
}

const APPROVAL_PARAMETERS = {
  type: "object",
  properties: {},
  required: [],
} as const;

/**
 * The no-UI contract text. It is an instruction to degrade, not an error: the
 * model must not approve on the user's behalf, so it points the *human* at the
 * CLI half of the gate. The exact command uses the relative script path a
 * human would type.
 */
export function noUiInstruction(slug: string, mode: string): string {
  return [
    `No interactive UI is available in this session (ctx.hasUI=false, mode=${mode}).`,
    "Do not write approval.json and do not guess consent. Ask the human to run:",
    `  python3 .myflow/scripts/task.py approve ${slug}`,
    "then re-run task.py start.",
  ].join("\n");
}

function textResult(result: ApprovalResult, text: string, isError = false) {
  return {
    content: [{ type: "text", text }],
    details: result,
    ...(isError ? { isError: true } : {}),
  };
}

function rejectedResult(reasons: string[]) {
  return textResult(
    { approved: false, via: "rejected", reasons },
    ["Approval refused before asking the user:", ...reasons.map((reason) => `  - ${reason}`)].join("\n"),
    true,
  );
}

function errorResult(message: string) {
  return textResult({ approved: false, via: "error", instruction: message }, message, true);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** First 12 hex chars of a `sha256:<hex>` string, for the dialog. */
export function shortHash(value: string): string {
  const hexpart = value.includes(":") ? value.split(":", 2)[1] : value;
  return hexpart.slice(0, SHORT_HASH_CHARS);
}

/** UTC ISO-8601 to the second, matching `task.py`'s `_now()` format. */
function isoTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Resolve the active task directory, or null.
 *
 * Reuses the same session-pointer resolution the rest of the harness uses, so
 * "the active task" means the same thing here as it does in `myflow_subagent`.
 * `resolveActiveTaskStatus` already refuses a pointer that leaves
 * `.myflow/tasks/`, which is also what pre-check 2 relies on.
 */
function resolveActiveTaskDir(ctx: ApprovalContext, registration: ApprovalRegistration): string | null {
  const root = findProjectRoot(ctx.cwd) ?? ctx.cwd;
  const contextKey = registration.deriveContextKey?.(ctx) ?? null;
  return resolveActiveTaskStatus(root, contextKey).taskDir;
}

/**
 * Defensive containment re-assertion for pre-check 2. `resolveActiveTaskStatus`
 * already returns null for an escaping pointer, so this cannot fire today; it
 * is here so a future refactor that drops that guarantee still fails closed
 * instead of approving a directory outside the tasks tree.
 */
function isInsideTasks(root: string, taskDir: string): boolean {
  const tasksRoot = join(root, ".myflow", "tasks");
  const rel = relative(tasksRoot, taskDir);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Read the gate snapshot from `task.py gate-info`.
 *
 * This is the single cross-language read: the hash and the answered count come
 * back together, from the one implementation that owns them. A non-zero exit,
 * a spawn failure, or unparseable output yields null (fail closed — the caller
 * refuses rather than approving against a guessed hash).
 */
function readGateInfo(taskPy: string, taskDir: string, cwd: string): GateInfo | null {
  const result = spawnSync("python3", [taskPy, "gate-info", taskDir], { cwd, encoding: "utf-8" });
  if (result.error || result.status !== 0) return null;
  const stdout = (result.stdout ?? "").trim();
  if (!stdout) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const obj = asRecord(parsed);
  if (!obj) return null;
  const planFiles = Array.isArray(obj.plan_files)
    ? obj.plan_files.filter((entry): entry is string => typeof entry === "string")
    : [];
  const questionsAnswered = typeof obj.questions_answered === "number" ? obj.questions_answered : 0;
  const planHash = typeof obj.plan_hash === "string" ? obj.plan_hash : null;
  const approvalRaw = asRecord(obj.approval);
  const approvalStatus =
    approvalRaw && typeof approvalRaw.status === "string" ? approvalRaw.status : "missing";
  const approvalHash =
    approvalRaw && typeof approvalRaw.plan_hash === "string" ? approvalRaw.plan_hash : null;
  return {
    plan_hash: planHash,
    plan_files: planFiles,
    questions_answered: questionsAnswered,
    approval: { status: approvalStatus, plan_hash: approvalHash },
  };
}

/**
 * Build the `myflow_request_approval` tool. Exported so tests can drive
 * `execute` with a stub context instead of a live Pi session;
 * `registerMyflowApproval` is the production entry point.
 */
export function createApprovalTool(registration: ApprovalRegistration = {}): Record<string, unknown> {
  return {
    name: APPROVAL_TOOL_NAME,
    label: "Myflow Request Approval",
    description: [
      "Request the user's approval of the current plan; write approval.json only when they agree.",
      "Run this after writing prd.md/design.md/implement.md and after asking at least one choice question with myflow_ask_user.",
      "The approval binds to the plan content: editing a plan file afterwards makes it stale and re-opens the gate.",
      "Without an interactive UI it never writes approval.json; it returns an instruction for a human to run the CLI.",
    ].join(" "),
    promptSnippet: "Request the user's approval of the current plan",
    parameters: APPROVAL_PARAMETERS,

    async execute(
      _toolCallId: string,
      _params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: ((partial: unknown) => void) | undefined,
      ctx: ApprovalContext,
    ) {
      // First line of the sub-agent guard. A sub-agent must not express the
      // user's consent; the tool_call hook (index.ts) is the second line.
      if (registration.isSubAgent === true) {
        return errorResult(
          "Only the main session may ask the user a question or request approval; " +
            "report the recommendation to the main session instead.",
        );
      }

      const root = findProjectRoot(ctx.cwd) ?? ctx.cwd;

      // Pre-check 1: an active task must resolve.
      const taskDir = resolveActiveTaskDir(ctx, registration);
      if (!taskDir) {
        return rejectedResult(["no active myflow task is resolved"]);
      }
      // Pre-check 2: the active task must live under .myflow/tasks/.
      if (!isInsideTasks(root, taskDir)) {
        return rejectedResult([`the active task is not under .myflow/tasks/: ${taskDir}`]);
      }

      // One read gets both the hash (to write) and the answered count (to
      // check): never re-hash in TS, never count questions.jsonl in TS.
      const gate = readGateInfo(join(root, TASK_PY_REL), taskDir, root);
      if (!gate) {
        return errorResult(
          "Could not read the plan gate from task.py (gate-info failed). " +
            "Run `python3 .myflow/scripts/task.py gate-info <slug>` to inspect.",
        );
      }

      // Pre-check 3: at least one plan file must exist to approve.
      if (gate.plan_files.length < 1) {
        return rejectedResult(["no plan files (prd.md is missing) — nothing to approve"]);
      }
      // Pre-check 4: at least one choice question must have been answered. The
      // count comes from the same predicate task.py uses, so the two sides
      // cannot disagree about what "asked" means.
      if (gate.questions_answered < 1) {
        return rejectedResult([
          "no answered choice questions (questions.jsonl) — ask the user with myflow_ask_user first",
        ]);
      }
      if (!gate.plan_hash) {
        return errorResult("task.py could not hash the current plan files (unhashable).");
      }

      const slug = basename(taskDir);
      const confirm = ctx.ui?.confirm;

      if (ctx?.hasUI !== true || typeof confirm !== "function") {
        const instruction = noUiInstruction(slug, ctx?.mode ?? "unknown");
        return textResult({ approved: false, via: "no-ui", instruction }, instruction);
      }

      const hashLabel = shortHash(gate.plan_hash);
      const agreed = await confirm.call(
        ctx.ui,
        "Approve this plan?",
        `Plan files: ${gate.plan_files.join(", ")}\nPlan hash: ${hashLabel}`,
      );
      if (agreed !== true) {
        return textResult(
          { approved: false, via: "cancelled" },
          "The user did not approve the plan. Address their feedback and request approval again.",
        );
      }

      // Field-for-field the shape `task.py`'s `_write_approval` writes, so
      // either writer produces a record the reader accepts. The hash and the
      // file list are taken verbatim from gate-info, never recomputed here.
      // `PI_SESSION_ID` is only injected into shell tools, so prefer the id the
      // extension context exposes; keep the env fallback for hosts that set it.
      const sessionId = (ctx.sessionManager?.getSessionId?.() ?? process.env.PI_SESSION_ID ?? "").trim();
      const approval = {
        approved_at: isoTimestamp(),
        approved_by: APPROVED_BY,
        session_id: sessionId || null,
        plan_files: gate.plan_files,
        plan_hash: gate.plan_hash,
        questions_asked: gate.questions_answered,
      };
      writeFileSync(join(taskDir, APPROVAL_FILE), `${JSON.stringify(approval, null, 2)}\n`, {
        encoding: "utf-8",
      });

      return textResult(
        {
          approved: true,
          via: "ui-confirm",
          plan_hash: gate.plan_hash,
          plan_files: gate.plan_files,
        },
        `Plan approved (${hashLabel}). You may now run task.py start.`,
      );
    },
  };
}

/** Register `myflow_request_approval` on the Pi extension API. */
export function registerMyflowApproval(pi: ApprovalPi, registration: ApprovalRegistration = {}): void {
  pi.registerTool(createApprovalTool(registration));
}
