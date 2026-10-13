import { existsSync, statSync, readFileSync, openSync, closeSync, fstatSync, readSync } from "node:fs";
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

export function taskContextJsonlNames(agentType?: AgentType): string[] {
  if (agentType === "myflow-implement") return ["implement.jsonl"];
  if (agentType === "myflow-check") return ["check.jsonl"];
  if (agentType === "myflow-research") return [];
  return ["implement.jsonl", "check.jsonl"];
}

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
    try {
      const content = readFileSync(jsonlPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const row = JSON.parse(trimmed) as Record<string, unknown>;
          const file = typeof row.file === "string" ? row.file.trim() : "";
          if (file) {
            const candidatePath = resolve(projectRoot, file);
            paths.add(candidatePath);
          }
        } catch {
          // Malformed lines do not contribute referenced files.
        }
      }
    } catch {
      // Unreadable jsonl files are skipped.
    }
  }
  return [...paths];
}

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

export class ContextBudget {
  private totalBytesUsed: number;
  private terminalSummaryEmitted = false;
  private stopped = false;
  private readonly maxTotalBytes: number;

  constructor(maxTotalBytes: number, initialUsed = 0) {
    this.maxTotalBytes = maxTotalBytes;
    this.totalBytesUsed = initialUsed;
  }

  hasRoom(bytes: number): boolean {
    return (
      !this.stopped &&
      (this.maxTotalBytes <= 0 || this.totalBytesUsed + bytes <= this.maxTotalBytes)
    );
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
    this.stopped = true;
    return "[myflow: context limit reached; omitted entries remain authoritative on disk]";
  }
}

const MAX_JSONL_BYTES = 1024 * 1024;

export function readJsonlLines(
  jsonlPath: string,
  displayPath: string,
): { lines: string[]; omitted: string | null } {
  let fd: number | null = null;
  try {
    fd = openSync(jsonlPath, "r");
    const data = Buffer.allocUnsafe(MAX_JSONL_BYTES + 1);
    const bytesRead = readSync(fd, data, 0, data.length, null);
    const size = fstatSync(fd).size;
    const content = data.subarray(0, bytesRead).toString("utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    const omitted =
      size > MAX_JSONL_BYTES
        ? `[myflow: ${displayPath} truncated at ${MAX_JSONL_BYTES} bytes]`
        : null;
    return { lines, omitted };
  } catch {
    return { lines: [], omitted: null };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export interface MaterializedFile {
  block: string | null;
  notice: string | null;
}

export function materialize(
  targetPath: string,
  displayPath: string,
  reason: string,
  maxBytes: number,
  kind: "file" | "artifact",
): MaterializedFile {
  let data: Buffer;
  let size: number;
  try {
    const stat = statSync(targetPath);
    size = stat.size;
    const fd = openSync(targetPath, "r");
    data = Buffer.allocUnsafe(Math.min(size, maxBytes));
    readSync(fd, data, 0, data.length, null);
    closeSync(fd);
  } catch {
    return {
      block: null,
      notice: `[myflow: ${displayPath} omitted — ${kind} is missing or unreadable]`,
    };
  }

  if (data.includes(0)) {
    return {
      block: null,
      notice: `[myflow: ${displayPath} omitted — binary or non-UTF-8 ${kind}: ${reason}]`,
    };
  }

  let content = data.toString("utf-8");
  let status: "inline" | "truncated" = "inline";
  if (data.length < size) {
    status = "truncated";
    content += `\n[myflow: truncated at ${maxBytes} bytes — read ${displayPath} for the full content]`;
  }

  return {
    block: `### ${displayPath} [${status}]\n\n${content}`,
    notice: null,
  };
}
