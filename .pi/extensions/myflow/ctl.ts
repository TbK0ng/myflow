/**
 * Control channel for a running front-run — `<runId>.ctl.jsonl`.
 *
 * A board can only *manage* a run if there is a way to reach it: the dispatcher
 * owns the child's stdin, the board does not, and the dispatcher may be blocked
 * inside its own turn (or be another session entirely). So the board writes a
 * line to a file under `.myflow/.runtime/subagents/` and the dispatcher polls
 * it once a second, forwarding `steer` / `abort` to the child.
 *
 * The file is append-only and read incrementally with a byte offset, which is
 * what makes two sessions steering the same run safe: no lock, no rewrite, and
 * both writers' lines survive in file order.
 *
 * Two tolerances are load-bearing:
 *   - A trailing line without a newline is **not** consumed. A writer can be
 *     interrupted mid-`appendFileSync`; consuming half a line would turn one
 *     command into a JSON parse error and lose it, so the offset stops after
 *     the last LF and the next read picks the line up once it is complete.
 *   - A line that does not parse (or is not a known command) is skipped and
 *     counted. A bad line must never stop the poll loop, and the count is what
 *     lets the board say "N lines ignored" instead of silently dropping input.
 *
 * Runtime imports are Node builtins only, so this module is importable under
 * `node --test`.
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/** Suffix that marks a control file, next to `<runId>.json`. */
export const CTL_SUFFIX = ".ctl.jsonl";

/** The two commands the dispatcher understands (`design.md` §4). */
export type ControlType = "steer" | "abort";

/** One parsed command line. */
export interface ControlCommand {
  /** Used by the dispatcher to forward a line exactly once; "" for a legacy line. */
  id: string;
  type: ControlType;
  message: string;
  at: string;
  by?: string;
}

/** What a writer supplies; `id` and `at` are minted by `appendControl`. */
export interface ControlInput {
  type: ControlType;
  message?: string;
  /** Which session/agent asked, for the log. Optional. */
  by?: string;
}

/** The result of one incremental read. */
export interface ControlBatch {
  commands: ControlCommand[];
  /** Byte offset to pass to the next `readNewControls` call. */
  offset: number;
  /** Lines that were complete but unusable. */
  skipped: number;
}

/** `<dir>/<runId>.ctl.jsonl`. */
export function ctlPath(dir: string, runId: string): string {
  return join(dir, `${runId}${CTL_SUFFIX}`);
}

/**
 * Append one command line and return it.
 *
 * `id` is random rather than a counter so two sessions appending to the same
 * file cannot mint the same id and make the dispatcher drop one of them.
 */
export function appendControl(path: string, command: ControlInput, now: number = Date.now()): ControlCommand {
  const record: ControlCommand = {
    id: `c-${Math.floor(now)}-${randomBytes(3).toString("hex")}`,
    type: command.type,
    message: command.message ?? "",
    at: new Date(now).toISOString(),
    ...(command.by ? { by: command.by } : {}),
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf-8" });
  return record;
}

/** Parse one complete line, or null when it is not a usable command. */
function parseControl(line: string): ControlCommand | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const type: ControlType | null =
    record.type === "steer" ? "steer" : record.type === "abort" ? "abort" : null;
  if (!type) return null;
  return {
    id: typeof record.id === "string" ? record.id : "",
    type,
    message: typeof record.message === "string" ? record.message : "",
    at: typeof record.at === "string" ? record.at : "",
    ...(typeof record.by === "string" && record.by ? { by: record.by } : {}),
  };
}

/**
 * Read the commands written after `offset`.
 *
 * The offset is a *byte* offset, so a message with multi-byte characters cannot
 * make a later read start mid-character. A missing file is "no commands yet",
 * not an error: the dispatcher polls this every second before anything is
 * steered.
 */
export function readNewControls(path: string, offset = 0): ControlBatch {
  let file: Buffer;
  try {
    file = readFileSync(path);
  } catch {
    return { commands: [], offset, skipped: 0 };
  }
  const start = Math.min(Math.max(Math.floor(offset), 0), file.length);
  const chunk = file.subarray(start);
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline < 0) return { commands: [], offset: start, skipped: 0 };
  const complete = chunk.subarray(0, lastNewline).toString("utf-8");
  const commands: ControlCommand[] = [];
  let skipped = 0;
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    const command = parseControl(line);
    if (command) commands.push(command);
    else skipped += 1;
  }
  return { commands, offset: start + lastNewline + 1, skipped };
}

/** Delete the control file. Called when a run settles, and before dispatch. */
export function clearControls(path: string): void {
  rmSync(path, { force: true });
}
