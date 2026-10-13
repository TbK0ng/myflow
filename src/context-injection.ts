import { readFileSync, statSync, existsSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { Buffer } from "node:buffer";

export type AgentType = "myflow-implement" | "myflow-check" | "myflow-research" | null;

export interface ContextInjectionLimits {
  max_file_bytes: number;
  max_artifact_bytes: number;
  max_total_bytes: number;
}

export const DEFAULT_CONTEXT_INJECTION_LIMITS: ContextInjectionLimits = {
  max_file_bytes: 32768,
  max_artifact_bytes: 65536,
  max_total_bytes: 131072,
};

const MAX_JSONL_BYTES = 1024 * 1024;

/** Return the jsonl file names for the given agent type. */
export function taskContextJsonlNames(agentType?: AgentType): string[] {
  if (agentType === "myflow-implement") return ["implement.jsonl"];
  if (agentType === "myflow-check") return ["check.jsonl"];
  if (agentType === "myflow-research") return [];
  return ["implement.jsonl", "check.jsonl"];
}

/** Collect the input paths for task context. */
export function taskContextInputPaths(
  projectRoot: string,
  taskDir: string,
  agentType?: AgentType,
): string[] {
  const paths = new Set<string>([
    join(projectRoot, ".myflow", "config.yaml"),
    join(taskDir, "prd.md"),
    join(taskDir, "info.md"),
  ]);
  for (const jsonlName of taskContextJsonlNames(agentType)) {
    const jsonlPath = join(taskDir, jsonlName);
    paths.add(jsonlPath);
    if (!existsSync(jsonlPath)) continue;
    const { lines } = readJsonlLines(jsonlPath, jsonlName);
    for (const line of lines) {
      try {
        const row = JSON.parse(line.trim()) as Record<string, unknown>;
        const file = typeof row.file === "string" ? row.file.trim() : "";
        if (file) {
          const candidatePath = resolve(projectRoot, file);
          paths.add(candidatePath);
        }
      } catch {
        // Seed rows and malformed lines do not contribute referenced files.
      }
    }
  }
  return [...paths];
}

/** Compute the signature for change detection. */
export function taskContextSignature(
  projectRoot: string,
  taskDir: string,
  agentType?: AgentType,
): string {
  return taskContextInputPaths(projectRoot, taskDir, agentType)
    .map((filePath) => {
      try {
        const stat = statSync(filePath);
        return `${filePath}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      } catch {
        return `${filePath}:missing`;
      }
    })
    .join("\n");
}

/** Read the context injection limits from config.yaml. */
export function readContextInjectionLimits(projectRoot: string): ContextInjectionLimits {
  let config = "";
  try {
    config = readFileSync(join(projectRoot, ".myflow", "config.yaml"), "utf-8");
  } catch {
    return { ...DEFAULT_CONTEXT_INJECTION_LIMITS };
  }

  const limits = { ...DEFAULT_CONTEXT_INJECTION_LIMITS };
  let inSection = false;
  let sectionIndent = -1;
  for (const rawLine of config.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!inSection) {
      if (/^context_injection\s*:\s*(#.*)?$/.test(trimmed)) {
        inSection = true;
        sectionIndent = rawLine.length - rawLine.trimStart().length;
      }
      continue;
    }
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent <= sectionIndent) break;
    const match = trimmed.match(/^(\w+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    const value = parseInt(match[2]!.trim(), 10);
    if (Number.isFinite(value)) {
      if (key === "max_file_bytes") limits.max_file_bytes = value;
      else if (key === "max_artifact_bytes") limits.max_artifact_bytes = value;
      else if (key === "max_total_bytes") limits.max_total_bytes = value;
    }
  }
  return limits;
}

/** Context budget manager. */
export class ContextBudget {
  private totalBytesUsed: number;
  private terminalSummaryEmitted = false;
  private stopped = false;

  constructor(private readonly maxTotalBytes: number, initialUsed = 0) {
    this.totalBytesUsed = initialUsed;
  }

  hasRoom(bytes: number): boolean {
    return !this.stopped && (this.maxTotalBytes <= 0 || this.totalBytesUsed + bytes <= this.maxTotalBytes);
  }

  emit(text: string): string | null {
    const bytes = Buffer.byteLength(text, "utf-8");
    if (!this.hasRoom(bytes)) return null;
    this.totalBytesUsed += bytes;
    return text;
  }

  emitCandidate(primary: string | null, fallback: string | null): string | null {
    if (primary !== null) {
      const direct = this.emit(primary);
      if (direct !== null) return direct;
    }
    if (fallback !== null) {
      const notice = this.emit(fallback);
      if (notice !== null) return notice;
    }
    return this.emitTerminalSummary();
  }

  private emitTerminalSummary(): string | null {
    if (this.terminalSummaryEmitted) return null;
    this.terminalSummaryEmitted = true;
    const summary = "[myflow: context limit reached; omitted entries remain authoritative on disk and require_read paths above.]";
    const bytes = Buffer.byteLength(summary, "utf-8");
    if (this.maxTotalBytes <= 0 || this.totalBytesUsed + bytes <= this.maxTotalBytes) {
      this.totalBytesUsed += bytes;
      this.stopped = true;
      return summary;
    }
    this.stopped = true;
    return null;
  }
}

/** Read a file prefix up to maxBytes. */
function readFilePrefix(targetPath: string, maxBytes: number): { data: Buffer; size: number } | null {
  try {
    const fd = openSync(targetPath, "r");
    try {
      const size = fstatSync(fd).size;
      const readSize = Math.min(maxBytes, size);
      const data = Buffer.allocUnsafe(readSize);
      readSync(fd, data, 0, readSize, 0);
      return { data, size };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Check UTF-8 encoding status. */
function utf8Status(data: Buffer): "valid" | "invalid" | "incomplete" {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (decoded.length === 0 && data.length > 0) return "invalid";
    return "valid";
  } catch {
    return "invalid";
  }
}

/** Truncate a buffer at a UTF-8 boundary. */
function truncateUtf8(data: Buffer, maxBytes: number): Buffer {
  if (data.length <= maxBytes) return data;
  const truncated = data.subarray(0, maxBytes);
  // Find the last valid UTF-8 boundary
  let end = truncated.length;
  while (end > 0) {
    const byte = truncated[end - 1]!;
    if ((byte & 0xc0) !== 0x80) break;
    end--;
  }
  return truncated.subarray(0, end);
}

/** Omitted notice for a file. */
function omittedNotice(displayPath: string, size: number | null, reason: string): string {
  const sizeStr = size !== null ? ` (${size} bytes)` : "";
  return `[myflow: omitted ${displayPath}${sizeStr} — ${reason}]`;
}

export interface MaterializedFile {
  block: string | null;
  notice: string;
}

/** Materialize a file for context injection. */
export function materialize(
  targetPath: string,
  displayPath: string,
  reason: string,
  maxBytes: number,
  kind: "file" | "artifact",
): MaterializedFile {
  const file = readFilePrefix(targetPath, maxBytes);
  if (!file) {
    return { block: null, notice: omittedNotice(displayPath, null, `${kind} is missing or unreadable`) };
  }
  const { data, size } = file;
  const encodingStatus = utf8Status(data);
  if (data.includes(0) || encodingStatus === "invalid") {
    return { block: null, notice: omittedNotice(displayPath, size, `binary or non-UTF-8 ${kind}: ${reason}`) };
  }
  const truncated = truncateUtf8(data, maxBytes);
  let content = truncated.toString("utf-8");
  let status: "inline" | "truncated" = "inline";
  if (truncated.length < size) {
    status = "truncated";
    content += `\n[myflow: truncated at ${maxBytes} bytes — read ${displayPath} for the full content]`;
  }
  return {
    block: `### ${displayPath} [${status}]\n\n${content}`,
    notice: omittedNotice(displayPath, size, `total context limit reached: ${reason}`),
  };
}

/** Read jsonl lines from a file. */
export function readJsonlLines(jsonlPath: string, displayPath: string): { lines: string[]; omitted: string | null } {
  try {
    const fd = openSync(jsonlPath, "r");
    try {
      const size = fstatSync(fd).size;
      const readSize = Math.min(MAX_JSONL_BYTES, size);
      const data = Buffer.allocUnsafe(readSize);
      readSync(fd, data, 0, readSize, 0);
      const text = data.toString("utf-8");
      const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const omitted = size > MAX_JSONL_BYTES ? `[myflow: jsonl truncated at ${MAX_JSONL_BYTES} bytes]` : null;
      return { lines, omitted };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { lines: [], omitted: null };
  }
}
