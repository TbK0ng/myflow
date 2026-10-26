import { statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { spawn } from "node:child_process";
import { isWithinWriteScope } from "../agents.ts";

export interface BgToolRegistration {
  /** Derive the parent session's myflow context key, if any. */
  deriveContextKey?: (ctx: unknown) => string | null;
  /** Whether this process is a dispatched sub-agent. */
  isSubAgent?: boolean;
  /** Override the wrapper path recorded on the entry (tests). */
  runnerPath?: string;
  /** Override `node:child_process.spawn` (tests). */
  spawnProcess?: typeof spawn;
  /**
   * Called with the new task id **after** its registry entry is written.
   *
   * The session keeps this hook so `session_shutdown` can report the tasks it
   * started without scanning the whole project registry (which would pay
   * readdir+parse on every session start). It is a notification, not a
   * decision point: it runs after the entry is on disk, its return value is
   * ignored, and a throwing callback is swallowed — by then the process is
   * already running and no callback may turn a successful start into a
   * failure. Defaults to no-op.
   */
  onStarted?: (id: string) => void;
}

export function textResult(details: Record<string, unknown>, text: string, isError = false) {
  return {
    content: [{ type: "text", text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

export function errorResult(message: string, details: Record<string, unknown> = {}) {
  return textResult({ started: false, ...details, error: message }, message, true);
}

/**
 * The first line of the sub-agent guard shared by all four `myflow_bg_*`
 * tools, or null when the caller may proceed.
 *
 * The caller is already a sub-agent when `isSubAgent` is true. Background tasks
 * are worse than an ordinary write to place in a child: they register in the
 * shared, project-wide registry and keep running after the child exits, so a
 * sub-agent would leave processes nobody asked for and nobody can attribute.
 * `index.ts` also blocks these tools in its `tool_call` hook (the second line,
 * wired in F7), exactly as it does for `myflow_ask_user`; this check keeps the
 * tool safe even if it is ever registered without that hook. It answers before
 * any dialog, spawn, or file write, so a refusal has no side effects.
 */
export function bgSubAgentRefusal(registration: BgToolRegistration): ReturnType<typeof textResult> | null {
  if (registration.isSubAgent !== true) return null;
  return errorResult(
    "Only the main session may manage background tasks. Background tasks register in the " +
      "shared project registry and outlive this process, so a sub-agent must not create or " +
      "control them. Report the recommendation to the main session instead.",
    { via: "error" },
  );
}

/**
 * The no-UI contract text for `myflow_bg_start`. It is an instruction, not an
 * error: the command cannot be shown to anyone for confirmation, and a
 * background command cannot be interrupted with Ctrl-C, so the safe default is
 * to refuse and explain how to opt in explicitly (`design.md` §4.1 / R8).
 */
export function bgNoUiInstruction(mode: string): string {
  return [
    `No interactive UI is available in this session (ctx.hasUI=false, mode=${mode}), so the`,
    "command cannot be shown to the user for confirmation. A background command cannot be",
    "interrupted with Ctrl-C and outlives the session, so it is refused by default.",
    "To start it anyway, call this tool again with `unattended: true`. That is recorded as",
    '`confirmed_by: "no-ui-explicit"`, and the result will state that the user did not confirm it.',
  ].join("\n");
}

/**
 * Resolve and validate the optional `cwd` of a background command (R5/ADR-9).
 *
 * Three rules, all fail-closed and all checked **before** the confirmation
 * dialog is shown, so a refusal has no side effects:
 *
 *  1. A relative path resolves against the project root; an absolute path is
 *     taken as-is. `resolve` collapses `..` in both cases.
 *  2. The result must stay inside the project root. The containment test is the
 *     same `isWithinWriteScope` the `writesUnder` guard uses — by path
 *     segment, case-insensitive on Windows — imported rather than copied, so a
 *     later tightening cannot leave one of the two boundaries loose.
 *  3. It must already be a directory. The registry, the logs, and the cursors
 *     are all project-level, so a background task cannot meaningfully run
 *     outside the project; and a cwd that does not exist would fail inside the
 *     wrapper, where the user could no longer be told before it started.
 *
 * An absent (or blank) value means "the project root".
 */
export function resolveBgCwd(
  root: string,
  requested: unknown,
): { ok: true; cwd: string } | { ok: false; error: string } {
  const projectRoot = resolve(root);
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (!raw) return { ok: true, cwd: projectRoot };

  const target = resolve(projectRoot, raw);
  if (!isWithinWriteScope(target, projectRoot, projectRoot)) {
    return {
      ok: false,
      error:
        `\`cwd\` must stay inside the project root (${projectRoot}), but ${target} is outside it. ` +
        "Nothing was started.",
    };
  }

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(target);
  } catch {
    return {
      ok: false,
      error: `\`cwd\` must be an existing directory: ${target} does not exist. Nothing was started.`,
    };
  }
  if (!stats.isDirectory()) {
    return {
      ok: false,
      error: `\`cwd\` must be an existing directory: ${target} is not a directory. Nothing was started.`,
    };
  }

  return { ok: true, cwd: target };
}

/** The JSON-schema parameter object for `myflow_bg_start`. */
