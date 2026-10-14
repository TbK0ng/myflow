/**
 * `myflow_ask_user` — ask the user one multiple-choice question without ending
 * the turn.
 *
 * The model calls this tool, the handler awaits `ctx.ui.select`, and the chosen
 * option comes back as the tool result: the turn continues, exactly like a
 * host-provided `AskUserQuestion`. It is the first half of the plan-approval
 * gate: the approval tool refuses to run until at least one real answer is on
 * disk (see `.myflow/scripts/task.py` `_answered_question_count`).
 *
 * Two hard rules, both enforced here and both covered by `tests/ask-user.test.ts`:
 *
 *   1. **Never fabricate an answer.** When no interactive UI is available the
 *      tool returns `via: "no-ui"` plus an instruction telling the model to ask
 *      in prose and *end the turn*; it never returns a default, guessed, or
 *      empty answer.
 *   2. **Every call is audited.** Each invocation appends one row to
 *      `<active task>/questions.jsonl`. A row with `via: "ui-select"` and a
 *      non-empty `answer` is the *only* thing that counts as "the user was
 *      asked" for the approval gate. A row with `via: "none"` records "asked
 *      but no answer was delivered" — which is deliberately *not* an answer.
 *
 * Sub-agents may not call it: they run in a non-interactive child process and
 * must not express a user's intent on their behalf. That guard lives here
 * (first line) and in the `tool_call` hook (second line, wired in index.ts).
 *
 * Dependency injection, not an import of `./index.ts`: `index.ts` registers
 * this tool, so importing it back would create the `index.ts` -> `ask.ts` ->
 * `index.ts` cycle. The sub-agent flag and the context-key deriver are both
 * injected by the caller, exactly like `registerMyflowSubagent` receives
 * `deriveContextKey`.
 *
 * Runtime imports stay limited to Node builtins plus sibling modules that are
 * themselves dependency-free, so the module is importable under `node --test`.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot } from "./find-project-root.ts";
import { resolveActiveTaskStatus } from "./turn-cache.ts";

export const ASK_USER_TOOL_NAME = "myflow_ask_user";

/**
 * The append-only audit log, relative to the active task directory. It matches
 * `QUESTIONS_FILE` in `.myflow/scripts/task.py` byte for byte: that script reads
 * the rows this tool writes, so the filename and the `via` values below are a
 * cross-language contract, not a local choice.
 */
export const QUESTIONS_FILE = "questions.jsonl";

/** A choice question needs at least two options and reads poorly past four. */
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

/** `header` is a short label; longer input is truncated, not rejected. */
export const MAX_HEADER_CHARS = 24;

/** How a result was obtained. `no-ui` and `cancelled` are *not* answers. */
export type AskVia = "ui-select" | "cancelled" | "no-ui" | "error";

/**
 * The persisted `via` column. Deliberately coarser than `AskVia`: the approval
 * gate counts exactly `"ui-select"`, and everything else is `"none"`. Keeping
 * this mapping in one place is what stops a richer result shape from drifting
 * away from what `task.py` counts.
 */
export type PersistedVia = "ui-select" | "none";

export function persistVia(via: AskVia): PersistedVia {
  return via === "ui-select" ? "ui-select" : "none";
}

export interface AskUserResult {
  answer: string | null;
  via: AskVia;
  /** Present for `no-ui` (and error) results; the model must follow it verbatim. */
  instruction?: string;
}

/** The subset of Pi's `ExtensionContext` this tool touches. */
export interface AskContext {
  cwd: string;
  mode?: string;
  hasUI?: boolean;
  ui?: {
    select?: (title: string, options: string[]) => Promise<string | undefined>;
  };
}

export interface AskUserParams {
  header?: string;
  question?: string;
  options?: string[];
}

export interface AskRegistration {
  /** Derive the parent session's myflow context key, if any. */
  deriveContextKey?: (ctx: unknown) => string | null;
  /** Whether this process is a dispatched sub-agent. */
  isSubAgent?: boolean;
}

/** Minimal `pi` surface used by the registration function. */
export interface AskPi {
  registerTool(tool: Record<string, unknown>): void;
}

/**
 * The no-UI contract text (design.md §4.1, verbatim apart from the mode). It is
 * an instruction to degrade, not an error: the model must ask in prose and end
 * its turn rather than guess an answer and proceed.
 */
export function noUiInstruction(mode: string): string {
  return [
    `No interactive UI is available in this session (ctx.hasUI=false, mode=${mode}).`,
    "Pose this question in your reply as a numbered list, then END YOUR TURN and wait",
    "for the user's answer. Do not proceed and do not guess an answer.",
  ].join("\n");
}

/** The JSON-schema parameter object for the tool (plain JSON, no TypeBox). */
const ASK_USER_PARAMETERS = {
  type: "object",
  properties: {
    header: {
      type: "string",
      description: `Short label for the question (truncated to ${MAX_HEADER_CHARS} characters).`,
    },
    question: { type: "string", description: "The question to ask the user. Must be non-empty." },
    options: {
      type: "array",
      items: { type: "string" },
      minItems: MIN_OPTIONS,
      maxItems: MAX_OPTIONS,
      description: `${MIN_OPTIONS}-${MAX_OPTIONS} answer choices. The user picks exactly one.`,
    },
  },
  required: ["header", "question", "options"],
} as const;

function textResult(result: AskUserResult, text: string, isError = false) {
  return {
    content: [{ type: "text", text }],
    details: result,
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(message: string) {
  return textResult({ answer: null, via: "error", instruction: message }, message, true);
}

/**
 * Resolve the active task directory, or null.
 *
 * Reuses the same session-pointer resolution the rest of the harness uses, so
 * "the active task" means the same thing here as it does in `myflow_subagent`.
 * A pointer that leaves `.myflow/tasks/` is refused inside `resolveActiveTaskStatus`.
 */
function resolveActiveTaskDir(ctx: AskContext, registration: AskRegistration): string | null {
  const root = findProjectRoot(ctx.cwd) ?? ctx.cwd;
  const contextKey = registration.deriveContextKey?.(ctx) ?? null;
  return resolveActiveTaskStatus(root, contextKey).taskDir;
}

/**
 * Append one audit row. The file is append-only and never re-read here, so a
 * pre-existing corrupt line cannot break a later append.
 */
function appendQuestionRow(taskDir: string, row: Record<string, unknown>): void {
  appendFileSync(join(taskDir, QUESTIONS_FILE), `${JSON.stringify(row)}\n`, { encoding: "utf-8" });
}

function humanText(result: AskUserResult): string {
  switch (result.via) {
    case "ui-select":
      return `The user chose: ${result.answer}`;
    case "cancelled":
      return "The user dismissed the question without choosing an option. Do not guess an answer; re-ask or end your turn.";
    case "no-ui":
      return result.instruction ?? noUiInstruction("unknown");
    default:
      return result.instruction ?? "The question could not be asked.";
  }
}

/**
 * Build the `myflow_ask_user` tool. Exported so tests can drive `execute` with a
 * stub context instead of a live Pi session; `registerMyflowAsk` is the
 * production entry point.
 */
export function createAskUserTool(registration: AskRegistration = {}): Record<string, unknown> {
  return {
    name: ASK_USER_TOOL_NAME,
    label: "Myflow Ask User",
    description: [
      "Ask the user one multiple-choice question and continue the turn with their answer.",
      `${MIN_OPTIONS}-${MAX_OPTIONS} options; the user picks exactly one (no multi-select).`,
      "Use this before writing a plan. It is the main session's tool: it records the exchange in questions.jsonl, which the approval gate requires.",
      "Without an interactive UI it returns an instruction to ask in prose and end the turn; it never invents an answer.",
    ].join(" "),
    promptSnippet: "Ask the user a multiple-choice question before planning",
    parameters: ASK_USER_PARAMETERS,

    async execute(
      _toolCallId: string,
      params: AskUserParams,
      _signal: AbortSignal | undefined,
      _onUpdate: ((partial: unknown) => void) | undefined,
      ctx: AskContext,
    ) {
      // First line of the sub-agent guard. A sub-agent must not answer for the
      // user; the tool_call hook (index.ts) is the second line.
      if (registration.isSubAgent === true) {
        return errorResult(
          "Only the main session may ask the user a question or request approval; " +
            "report the recommendation to the main session instead.",
        );
      }

      const header =
        typeof params?.header === "string" ? params.header.slice(0, MAX_HEADER_CHARS) : "";
      const question = typeof params?.question === "string" ? params.question.trim() : "";
      const rawOptions = params?.options;
      const options = Array.isArray(rawOptions)
        ? rawOptions.filter((option): option is string => typeof option === "string")
        : [];

      if (!question) {
        return errorResult("`question` must be a non-empty string.");
      }
      if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
        return errorResult(
          `\`options\` must contain between ${MIN_OPTIONS} and ${MAX_OPTIONS} choices (got ${options.length}).`,
        );
      }

      const taskDir = resolveActiveTaskDir(ctx, registration);
      if (!taskDir) {
        return errorResult(
          "No active myflow task is resolved, so there is nowhere to record the question. " +
            "Create or activate a task first.",
        );
      }

      const select = ctx.ui?.select;
      let via: AskVia;
      let answer: string | null = null;
      let instruction: string | undefined;

      if (ctx?.hasUI === true && typeof select === "function") {
        const selected = await select.call(ctx.ui, question, options);
        if (typeof selected === "string" && selected.length > 0) {
          via = "ui-select";
          answer = selected;
        } else {
          via = "cancelled";
        }
      } else {
        via = "no-ui";
        instruction = noUiInstruction(ctx?.mode ?? "unknown");
      }

      const result: AskUserResult = { answer, via, ...(instruction ? { instruction } : {}) };

      appendQuestionRow(taskDir, {
        at: new Date().toISOString(),
        tool: ASK_USER_TOOL_NAME,
        header,
        question,
        options,
        answer,
        via: persistVia(via),
      });

      return textResult(result, humanText(result));
    },
  };
}

/** Register `myflow_ask_user` on the Pi extension API. */
export function registerMyflowAsk(pi: AskPi, registration: AskRegistration = {}): void {
  pi.registerTool(createAskUserTool(registration));
}
