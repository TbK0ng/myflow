/**
 * Log → readable transcript for the `/mysubagents` viewer.
 *
 * A run's log is the child's **raw** stream: an optional `#` header written by
 * the transport, then rpc JSONL records, then whatever stderr produced. That is
 * the right file to keep (it is the only verbatim source), but the wrong thing to
 * show — so this module turns it into a short list of `{kind, text}` lines.
 *
 * Three decisions:
 *
 *   - **Only `message_end` carries content.** Every other record is protocol
 *     chatter the viewer has no use for, and an unrecognised one is skipped
 *     rather than shown: one unknown record must not break the viewer.
 *   - **Thinking folds to one line.** A thinking block can be dozens of lines
 *     long and always superseded by the text that follows it; folding keeps the
 *     viewer scannable while still showing that the model reasoned.
 *   - **Tool calls stay one line, results are clipped.** A tool result can be
 *     megabytes of file content; the log keeps all of it, the viewer shows the
 *     first `RESULT_CLIP` characters. The log path is the escape hatch.
 *
 * Runtime imports are Node builtins only, so `node --test` can import this.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";

/** What a transcript line is; the renderer maps each kind to a color. */
export type TranscriptKind = "text" | "thinking" | "tool" | "result" | "error";

/** One readable line. `text` never contains a newline. */
export interface TranscriptLine {
  kind: TranscriptKind;
  text: string;
}

/** How much of a tool result the viewer keeps. */
export const RESULT_CLIP = 200;

/** How much of a tool call's arguments the viewer keeps. */
const ARGS_CLIP = 120;

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

interface ContentPart {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
}

interface LogMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

interface LogRecord {
  type?: string;
  message?: LogMessage;
}

/** `bash {"command":"ls"}` — enough to recognise the call, never a wall of JSON. */
function toolLine(name: string, args: unknown): string {
  let rendered = "";
  try {
    rendered = args === undefined ? "" : JSON.stringify(args) ?? "";
  } catch {
    rendered = "";
  }
  const head = rendered ? ` ${clip(oneLine(rendered), ARGS_CLIP)}` : "";
  return `${name || "tool"}${head}`;
}

function pushMessage(lines: TranscriptLine[], message: LogMessage): void {
  const role = message.role ?? "";
  if (role === "assistant") {
    const content = Array.isArray(message.content) ? (message.content as ContentPart[]) : [];
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string") {
        const text = part.text.trim();
        if (text) lines.push({ kind: "text", text });
      } else if (part?.type === "thinking" && typeof part.thinking === "string") {
        const text = oneLine(part.thinking);
        if (text) lines.push({ kind: "thinking", text });
      } else if (part?.type === "toolCall") {
        lines.push({ kind: "tool", text: toolLine(part.name ?? "", part.arguments) });
      }
    }
    if (message.stopReason === "error") {
      lines.push({ kind: "error", text: oneLine(message.errorMessage ?? "the run reported an error") });
    }
    return;
  }
  if (role === "toolResult") {
    const content = Array.isArray(message.content) ? (message.content as ContentPart[]) : [];
    const text = content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join(" ");
    const normalized = oneLine(text);
    if (normalized) lines.push({ kind: "result", text: clip(normalized, RESULT_CLIP) });
  }
  // Any other role (user, system) is either an echo of the prompt or a section
  // instruction: neither is something the viewer should show as a turn.
}

/**
 * Parse log text into readable lines. Bad lines, non-JSON lines (the `#` header
 * and raw stderr), and unknown record types are skipped — a log is a stream of
 * best-effort diagnostics, not a document that can be validated up front.
 */
export function parseTranscript(logText: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const raw of logText.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.trim() || line.startsWith("#")) continue;
    let record: LogRecord;
    try {
      record = JSON.parse(line) as LogRecord;
    } catch {
      continue;
    }
    if (record === null || typeof record !== "object") continue;
    if (record.type !== "message_end" || !record.message) continue;
    pushMessage(lines, record.message);
  }
  return lines;
}

/**
 * Read at most `maxBytes` from the end of a file.
 *
 * A run's log can reach megabytes (every tool result is in it), and the viewer
 * refreshes once a second, so it reads the tail instead of the whole file. The
 * first line of the returned text is dropped: it is almost certainly a fragment
 * of the line that the byte cut landed inside.
 */
export function readTail(path: string, maxBytes: number): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return "";
  }
  if (size <= 0) return "";
  const start = Math.max(0, size - Math.max(0, Math.floor(maxBytes)));
  const length = size - start;
  const buffer = Buffer.allocUnsafe(length);
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, start);
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* the read result is what matters */
      }
    }
  }
  const text = buffer.toString("utf-8");
  if (start === 0) return text;
  const firstBreak = text.indexOf("\n");
  return firstBreak < 0 ? "" : text.slice(firstBreak + 1);
}

/** The tail window used by the board's one-line preview. */
export const LAST_LINE_WINDOW_BYTES = 32 * 1024;

/** How much of the preview line the board keeps. */
export const LAST_LINE_CLIP = 100;

/**
 * The last readable thing a run said, for the board's one-line preview.
 *
 * `null` (rather than "") when the log is missing, empty, or holds no message
 * yet — the renderer shows "—" and a caller cannot mistake "no log" for "said
 * nothing".
 *
 * shortcut: only the last LAST_LINE_WINDOW_BYTES are parsed, so a single record
 * bigger than that window yields no preview; the viewer still reads the log.
 */
export function lastLine(path: string, windowBytes: number = LAST_LINE_WINDOW_BYTES): string | null {
  if (!existsSync(path)) return null;
  const lines = parseTranscript(readTail(path, windowBytes));
  const last = lines.at(-1);
  if (!last) return null;
  return clip(last.text, LAST_LINE_CLIP);
}

/**
 * The whole log as readable lines, for the viewer.
 *
 * Reading the entire file is deliberate here (unlike `lastLine`): the user
 * opened the viewer to read one run, so a bounded read would silently hide the
 * beginning of the very thing they asked for.
 */
export function readTranscript(path: string): TranscriptLine[] {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  return parseTranscript(text);
}
