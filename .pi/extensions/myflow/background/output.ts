import { statSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { findProjectRoot } from "../find-project-root.ts";
import type { BackgroundTaskStatus, BackgroundEntry } from "./registry.ts";
import type { BgToolRegistration } from "./tools.ts";
import { backgroundDir, logPath, readEntry, readExitRecord, normalizeReason, normalizeExitShell, normalizeRetryCount, resolveStatus, cursorPath, readCursor, writeCursor } from "./registry.ts";
import { textResult, bgSubAgentRefusal } from "./tools.ts";

// ---------------------------------------------------------------------------
// `myflow_bg_output`
//
// Reads a task's output either as an increment from *this session's* cursor
// (`mode: "delta"`, the default) or as its last N lines (`mode: "tail"`). The
// cursor is what makes two sessions independent: each has its own, so neither
// consumes bytes the other has not seen (ADR-5 / PRD Q3). `tail` and `peek`
// never move a cursor; only `delta` without `peek` advances one.
//
// A bounded wait (`wait_ms`) replaces a separate `sleep` tool (ADR-3): it
// returns early as soon as there are new bytes to read or the task has ended,
// so the model cannot sleep past a finished task. The tool reads before it
// waits only to observe `statSync(size)`; it never reads the whole log just to
// decide whether there is more (large logs must not be slurped).
// ---------------------------------------------------------------------------

/** The `myflow_bg_output` tool name. */
export const BG_OUTPUT_TOOL_NAME = "myflow_bg_output";

/** `max_bytes` bounds, clamped rather than rejected (`design.md` §4.2). */
export const DEFAULT_MAX_BYTES = 32768;
export const MAX_MAX_BYTES = 65536;
export const MIN_MAX_BYTES = 1;

/** `lines` bounds, only consulted for `tail`; clamped rather than rejected. */
export const DEFAULT_TAIL_LINES = 200;
export const MAX_TAIL_LINES = 2000;
export const MIN_TAIL_LINES = 1;

/** `wait_ms` bounds; clamped rather than rejected, so a wait is always bounded. */
export const DEFAULT_WAIT_MS = 0;
export const MAX_WAIT_MS = 30000;
export const MIN_WAIT_MS = 0;

/** Poll interval for `wait_ms`; `design.md` §4.2 requires ≤ 200ms. */
export const WAIT_POLL_MS = 100;

/**
 * Cursor namespace used when the injected deriver returns no context key. Two
 * keyless sessions then share one cursor, which can over-consume; that is the
 * only honest fallback, and every real caller injects a deriver.
 */
export const FALLBACK_CONTEXT_KEY = "no-context";

/** How the output is framed: an increment from the cursor, or the last lines. */
export type BgOutputMode = "delta" | "tail";

/** The subset of Pi's `ExtensionContext` the output tool touches. */
export interface BgOutputContext {
  cwd: string;
}

/** The `myflow_bg_output` parameters (`design.md` §4.2). */
export interface BgOutputParams {
  task_id?: string;
  mode?: string;
  peek?: boolean;
  max_bytes?: number;
  lines?: number;
  wait_ms?: number;
}

/** The structured payload returned by `myflow_bg_output`. */
export interface BgOutputResult {
  task_id?: string;
  mode?: BgOutputMode;
  status: BackgroundTaskStatus;
  exit_code: number | null;
  bytes: number;
  next_offset: number;
  truncated: boolean;
  text: string;
  /**
   * Present and true only when the log was shorter than the stored cursor
   * (rotated/recreated) and the read restarted from 0. This field is an
   * addition to the `design.md` §4.2 return shape (recorded for F8); it exists
   * so a caller is told about the re-read instead of silently seeing nothing.
   */
  reset?: boolean;
  /**
   * Why the task could not be started, or ended abnormally: the `.exit` record's
   * `error`, falling back to the entry's `spawn_error`. Omitted when neither is
   * present. Makes a failed start diagnosable instead of looking like a normal
   * exit whose code happens to be unknown (F8/H1a).
   */
  failure?: string;
  /** The signal that terminated the task, from the `.exit` record. Omitted when absent. */
  signal?: string;
  /**
   * The shell that actually ran the command, from the `.exit` record. Present
   * only once a `.exit` record exists, because only the wrapper can say which
   * shell it resolved — a task still running (or never started) has no
   * authoritative value, and guessing one would be a lie.
   */
  shell?: string | null;
  /**
   * How many times the wrapper retried creation, from the `.exit` record.
   * Omitted when the record has no `retries` (no retry happened); the field is
   * never written as `undefined`, so `"retries" in details` stays meaningful.
   */
  retries?: number;
  /** Present only on a refusal/error result. */
  error?: string;
}

function bgOutputError(message: string) {
  return textResult(
    {
      status: "unknown",
      exit_code: null,
      bytes: 0,
      next_offset: 0,
      truncated: false,
      text: "",
      error: message,
    },
    message,
    true,
  );
}

/**
 * Coerce a parameter to an integer inside `[min, max]`, falling back to
 * `fallback` for a missing or non-finite value. Out-of-range input is clamped,
 * never rejected: the schemas document the bounds, and a clamp keeps the tool
 * usable when a model guesses a larger number.
 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  if (integer < min) return min;
  if (integer > max) return max;
  return integer;
}

/** The log's size in bytes, or 0 when it does not exist yet. */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Read `length` bytes starting at `start`. A missing or unreadable file yields
 * an empty buffer: output is best-effort, and the caller reports the task state
 * separately rather than turning a vanished log into a thrown error.
 */
function readRange(path: string, start: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* the descriptor is gone either way */
    }
  }
}

/**
 * Read at most `maxBytes` from the end of a file, plus where that chunk began.
 * Bounding the read from the end is what keeps `tail` from slurping a huge log:
 * only the window a caller could display is touched.
 *
 * The window is aligned to a UTF-8 character boundary before it is read, for the
 * same reason `delta` aligns its end: a window that opens mid-character decodes
 * to U+FFFD and corrupts the first character of the returned text.
 */
function readTailChunk(path: string, maxBytes: number): { buffer: Buffer; chunkStart: number; size: number } {
  const size = fileSize(path);
  if (size <= 0) return { buffer: Buffer.alloc(0), chunkStart: 0, size: 0 };
  let chunkStart = Math.max(0, size - maxBytes);
  if (chunkStart > 0) {
    chunkStart = alignTailStart(path, chunkStart, size);
  }
  // Degenerate case: aligning forward walked past the whole final character
  // (the byte budget is smaller than that character), leaving the start at EOF.
  // Returning nothing would make `tail` report empty output for a non-empty log,
  // so back up to the start of the last complete character instead. This
  // exceeds the caller's byte budget by at most three bytes — the same trade-off
  // `alignDeltaEnd` makes at the other end.
  if (chunkStart >= size) {
    chunkStart = lastCharacterStart(path, size);
  }
  return { buffer: readRange(path, chunkStart, size - chunkStart), chunkStart, size };
}

/** Read the single byte at `index`, or -1 when it cannot be read. */
function readByteAt(path: string, index: number): number {
  const buffer = readRange(path, index, 1);
  return buffer.length === 1 ? buffer[0] : -1;
}

/** Whether `byte` is a UTF-8 continuation byte (`0b10xxxxxx`). -1 is not. */
function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/**
 * The LF byte. A `tail` window whose preceding byte is LF starts on a line
 * boundary, so its first line is complete; otherwise the window opened mid-line.
 */
const NEWLINE_BYTE = 0x0a;

/**
 * Pull an exclusive delta `end` position back to the nearest UTF-8 character
 * boundary, so a multi-byte character is never split between two reads.
 *
 * `end` is exclusive, so it is a boundary when the byte *at* `end` is not a
 * continuation byte (`0b10xxxxxx`), or when it has reached the end of the file.
 * At most three bytes are skipped: no UTF-8 character is longer than four
 * bytes, so a run of continuation bytes at `end` cannot extend further.
 *
 * Degenerate case: if backing up would land on `offset` and return zero bytes
 * (the byte budget is smaller than the character at `offset`), the end is
 * pushed *forward* to the end of that character instead. Returning nothing
 * would leave the cursor in place forever, which is worse than exceeding the
 * caller's byte budget by at most three bytes. `offset` always stays a byte
 * position (`design.md` §3.3); only where the read ends moves.
 */
function alignDeltaEnd(path: string, offset: number, end: number, size: number): number {
  let aligned = end;
  let backed = 0;
  while (aligned > offset && backed < 3 && isContinuationByte(readByteAt(path, aligned))) {
    aligned -= 1;
    backed += 1;
  }
  if (aligned > offset) return aligned;
  let advanced = offset + 1;
  while (advanced < size && isContinuationByte(readByteAt(path, advanced))) {
    advanced += 1;
  }
  return advanced;
}

/**
 * Push an inclusive chunk start *forward* to the nearest UTF-8 character
 * boundary, so a `tail` read never opens in the middle of a multi-byte
 * character.
 *
 * `start` is inclusive (the first byte the chunk returns), so it is already a
 * boundary when the byte *at* `start` is not a continuation byte
 * (`0b10xxxxxx`). When it is a continuation byte the chunk would begin with the
 * tail of a character and decode to U+FFFD; advancing to the next lead byte
 * drops that fragment. At most three bytes are skipped: no UTF-8 character is
 * longer than four bytes.
 *
 * The direction is the opposite of `alignDeltaEnd`. `tail` wants the end of the
 * file, so the only way to avoid the broken opening character is to move the
 * start *toward* the end. Moving it back would pull in the very fragment that
 * decodes to U+FFFD. `start` always stays a byte position (`design.md` §3.3);
 * only where the read begins moves.
 */
function alignTailStart(path: string, start: number, size: number): number {
  let aligned = start;
  let advanced = 0;
  while (aligned < size && advanced < 3 && isContinuationByte(readByteAt(path, aligned))) {
    aligned += 1;
    advanced += 1;
  }
  return aligned;
}

/**
 * The byte offset where the file's final complete UTF-8 character begins: scan
 * back from the last byte over at most three continuation bytes (a character is
 * at most four bytes long), landing on its lead byte. Used only when aligning a
 * `tail` start forward would otherwise leave nothing to read.
 */
function lastCharacterStart(path: string, size: number): number {
  let start = Math.max(0, size - 1);
  let backed = 0;
  while (start > 0 && backed < 3 && isContinuationByte(readByteAt(path, start))) {
    start -= 1;
    backed += 1;
  }
  return start;
}

/** Whether a resolved status means the command is no longer running. */
export function isFinishedStatus(status: BackgroundTaskStatus): boolean {
  return status === "exited" || status === "stopped";
}

/** Bounded async sleep; the only timer lives inside one `execute` call. */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Wait up to `waitMs` for something to read, returning as soon as either there
 * are new bytes past `offset` or the task has ended (`design.md` §4.2, ADR-3).
 * Both checks are cheap: `statSync(size)` compares sizes without reading the
 * log, and `resolveStatus` is a fixed-precedence read. The loop is bounded by a
 * deadline and never waits forever.
 */
async function waitForReadable(
  dir: string,
  entry: BackgroundEntry,
  logFile: string,
  offset: number,
  waitMs: number,
): Promise<void> {
  if (waitMs <= 0) return;
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (isFinishedStatus(resolveStatus(dir, entry).status)) return;
    if (fileSize(logFile) > offset) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await sleep(Math.min(WAIT_POLL_MS, remaining));
  }
}

/** The JSON-schema parameter object for `myflow_bg_output`. */
const BG_OUTPUT_PARAMETERS = {
  type: "object",
  properties: {
    task_id: {
      type: "string",
      description: "The task id returned by myflow_bg_start (or listed by myflow_bg_list).",
    },
    mode: {
      type: "string",
      enum: ["delta", "tail"],
      description:
        'How to frame the output. "delta" (default) returns the bytes after this session\'s ' +
        'read cursor; "tail" returns the last `lines` lines and does not move the cursor.',
    },
    peek: {
      type: "boolean",
      description:
        "When true, read without advancing the delta cursor, so the same bytes can be read again. " +
        "Defaults to false.",
    },
    max_bytes: {
      type: "number",
      description: `Byte budget for the returned text (default ${DEFAULT_MAX_BYTES}, capped at ${MAX_MAX_BYTES}).`,
    },
    lines: {
      type: "number",
      description: `For mode "tail" only: how many trailing lines to return (default ${DEFAULT_TAIL_LINES}, capped at ${MAX_TAIL_LINES}).`,
    },
    wait_ms: {
      type: "number",
      description:
        `Wait up to this many milliseconds (0-${MAX_WAIT_MS}, default 0) for new output or the ` +
        "task to end, then return; it returns early as soon as either happens.",
    },
  },
  required: ["task_id"],
} as const;

/**
 * The human-readable output. It always names the task and its status, and it
 * annotates the two cases a reader could otherwise misread: a truncated read
 * (with the offset a follow-up delta will resume at) and a cursor reset.
 */
function outputHumanText(result: BgOutputResult): string {
  const code = result.exit_code === null ? "" : ` (exit_code ${result.exit_code})`;
  const signal = result.signal ? ` (signal ${result.signal})` : "";
  const parts = [`Task ${result.task_id ?? "?"} — ${result.status}${code}${signal}`];
  if (result.failure) {
    parts.push(`FAILURE: ${result.failure}`);
  }
  if (result.reset) {
    parts.push(
      "NOTE: the log is shorter than the read cursor (rotated or recreated); the cursor was " +
        "reset to 0 and the task was re-read from the start.",
    );
  }
  if (result.truncated) {
    parts.push(
      `NOTE: output was truncated at max_bytes; the next delta read resumes at offset ${result.next_offset}.`,
    );
  }
  parts.push("---");
  parts.push(result.text.length > 0 ? result.text : "(no new output)");
  return parts.join("\n");
}

/**
 * Build the `myflow_bg_output` tool. Exported so tests can drive `execute` with
 * a stub context instead of a live Pi session; the registration function is the
 * production entry point (wired in F7).
 *
 * Read rules (`design.md` §4.2 / §3.3):
 *   - `delta` reads `[cursor, size)` and, unless `peek`, advances the cursor to
 *     the end of *the bytes it actually returned* — not to the file end when the
 *     read was cut short, or the unreturned bytes would be lost silently.
 *   - `tail` reads the last `lines` lines and moves nothing.
 *   - `peek` reads and moves nothing.
 *   - A cursor past the file end means the log was rotated/recreated: the read
 *     restarts at 0 and reports `reset: true` rather than returning nothing.
 *
 * Status is reported honestly but not persisted here; persisting a self-healed
 * `exited` is `myflow_bg_list`'s job (F5).
 */
export function createBgOutputTool(registration: BgToolRegistration = {}): Record<string, unknown> {
  return {
    name: BG_OUTPUT_TOOL_NAME,
    label: "Myflow Background Output",
    description: [
      "Read a background task's output, either an increment since this session's last delta read or its last lines.",
      "Returns the task status and, once it has finished, its exit code, the shell that ran it, and how many creation retries it took.",
      "tail and peek never advance the read cursor; delta does unless peek is set.",
      "wait_ms (bounded) returns early as soon as there is new output or the task has ended.",
    ].join(" "),
    promptSnippet: "Read a background task's output",
    parameters: BG_OUTPUT_PARAMETERS,

    async execute(
      _toolCallId: string,
      params: BgOutputParams,
      _signal: AbortSignal | undefined,
      _onUpdate: ((partial: unknown) => void) | undefined,
      ctx: BgOutputContext,
    ) {
      // First line of the sub-agent guard; the tool_call hook is the second.
      const refusal = bgSubAgentRefusal(registration);
      if (refusal) return refusal;

      const taskId = typeof params?.task_id === "string" ? params.task_id.trim() : "";
      if (!taskId) {
        return bgOutputError("`task_id` must be a non-empty string.");
      }

      const root = findProjectRoot(ctx?.cwd ?? process.cwd()) ?? ctx?.cwd ?? process.cwd();
      const dir = backgroundDir(root);
      const entry = readEntry(dir, taskId);
      if (!entry) {
        return bgOutputError(
          `No background task "${taskId}" is registered. Use myflow_bg_list to see known task ids.`,
        );
      }

      const mode: BgOutputMode = params?.mode === "tail" ? "tail" : "delta";
      const peek = params?.peek === true;
      const maxBytes = clampInt(params?.max_bytes, MIN_MAX_BYTES, MAX_MAX_BYTES, DEFAULT_MAX_BYTES);
      const lines = clampInt(params?.lines, MIN_TAIL_LINES, MAX_TAIL_LINES, DEFAULT_TAIL_LINES);
      const waitMs = clampInt(params?.wait_ms, MIN_WAIT_MS, MAX_WAIT_MS, DEFAULT_WAIT_MS);

      const contextKey = registration.deriveContextKey?.(ctx) ?? FALLBACK_CONTEXT_KEY;
      const cursorFile = cursorPath(root, contextKey, taskId);
      const logFile = logPath(dir, taskId);

      // A delta cursor past the file end is a rotated/recreated log, not "no
      // data": restart at 0 and tell the caller. `tail` never uses the cursor.
      let offset = readCursor(cursorFile);
      let reset = false;
      if (mode === "delta" && offset > fileSize(logFile)) {
        offset = 0;
        reset = true;
      }

      if (waitMs > 0) {
        await waitForReadable(dir, entry, logFile, offset, waitMs);
      }

      // Resolve after the wait so a task that ended while waiting is reported as
      // ended. Reading the status does not write it back (F5 owns persistence).
      const resolved = resolveStatus(dir, entry);
      const { status, exit_code } = resolved;
      // `failure` unifies the two ways a start can fail so a caller does not
      // have to know which layer noticed: the runner's `.exit.error` (the
      // command was never created, or its log could not be opened) and the
      // entry's `spawn_error` (the extension's own `'error'` listener). The
      // `.exit` record wins when both exist, because it is written by the
      // process that actually attempted the creation.
      const failure = resolved.failure ?? normalizeReason(entry.spawn_error) ?? undefined;
      const signal = resolved.signal;
      // R3: the shell that actually ran and the retry count are only knowable
      // from a `.exit` record, so they are attached only when one exists. A
      // still-running task (`running`) or a not-yet-confirmed one (`starting`)
      // has no authoritative value, and the entry's own fields are a cache that
      // the wrapper never updates. Built once and spread into both result
      // shapes below so `tail` and `delta` cannot disagree.
      const exitRecord = readExitRecord(dir, entry);
      const runnerFacts: { shell?: string | null; retries?: number } = {};
      if (exitRecord) {
        runnerFacts.shell = normalizeExitShell(exitRecord.shell);
        const retries = normalizeRetryCount(exitRecord.retries);
        if (retries !== null) runnerFacts.retries = retries;
      }

      if (mode === "tail") {
        const { buffer, chunkStart } = readTailChunk(logFile, maxBytes);
        const decoded = buffer.toString("utf-8");
        const split = decoded.split("\n");
        const hadTrailingNewline = decoded.endsWith("\n");
        if (hadTrailingNewline) split.pop();

        // A byte-budget window can open in the middle of a line. Unlike `delta`,
        // `tail` has no cursor, so a half-line at the front can never be
        // completed by a later read — the caller has no way to ask for the rest.
        // Drop that incomplete first line and start from the next complete one.
        //
        // The window opened mid-line exactly when the byte before it is not an
        // LF (and it is not the start of the file, where every line is
        // complete). When the window begins on an LF byte the decoded text
        // starts with "", which this also drops.
        //
        // Invariant: `tail` never returns a partial line. The one exception is
        // when dropping the partial first line would leave nothing at all (the
        // window covers a single line that is itself longer than `maxBytes`).
        // Returning an empty string would be less useful than the aligned tail
        // fragment, so in that case the fragment is kept and `truncated` stays
        // true. `readTailChunk` has already aligned it to a UTF-8 boundary.
        const partialFirstLine =
          chunkStart > 0 && readByteAt(logFile, chunkStart - 1) !== NEWLINE_BYTE;
        const completeLines = partialFirstLine && split.length > 1 ? split.slice(1) : split;
        const selected = completeLines.slice(-lines);
        let text = selected.join("\n");
        if (hadTrailingNewline && selected.length > 0) text += "\n";

        const result: BgOutputResult = {
          task_id: taskId,
          mode,
          status,
          exit_code,
          bytes: Buffer.byteLength(text, "utf-8"),
          // `tail` returns the cursor unchanged: next_offset is where a delta
          // would resume, and the cursor file is not touched.
          next_offset: offset,
          // Only a byte-budget cut counts as truncation. Dropping leading lines
          // to satisfy `lines` is the requested behavior, not a loss of output.
          truncated: chunkStart > 0,
          text,
          ...(failure ? { failure } : {}),
          ...(signal ? { signal } : {}),
          ...runnerFacts,
        };
        return textResult(result as unknown as Record<string, unknown>, outputHumanText(result));
      }

      const size = fileSize(logFile);
      const available = Math.max(0, size - offset);
      const take = Math.min(available, maxBytes);
      // The byte budget must not split a multi-byte UTF-8 character: a split
      // would emit U+FFFD now *and* leave the cursor inside a character, so the
      // next delta would corrupt the same character again and lose it. Align the
      // exclusive end down to a character boundary; the bytes past it stay for
      // the next read rather than being dropped. `alignDeltaEnd` handles the
      // degenerate budget-too-small case by taking one whole character.
      let end = offset + take;
      if (end < size) {
        end = alignDeltaEnd(logFile, offset, end, size);
      }
      const buffer = readRange(logFile, offset, end - offset);
      const text = buffer.toString("utf-8");
      // `truncated` is true only when the budget left bytes unread. `next_offset`
      // is the next cursor position: for a normal delta it is the end of what
      // was returned, so the remainder is read by the next delta rather than
      // dropped. `peek` does not move the cursor, so its next_offset stays where
      // the cursor is.
      const truncated = end < size;
      const nextOffset = peek ? offset : end;

      if (!peek) {
        writeCursor(cursorFile, nextOffset);
      }

      const result: BgOutputResult = {
        task_id: taskId,
        mode,
        status,
        exit_code,
        bytes: buffer.length,
        next_offset: nextOffset,
        truncated,
        text,
        ...(reset ? { reset: true } : {}),
        ...(failure ? { failure } : {}),
        ...(signal ? { signal } : {}),
        ...runnerFacts,
      };
      return textResult(result as unknown as Record<string, unknown>, outputHumanText(result));
    },
  };
}

