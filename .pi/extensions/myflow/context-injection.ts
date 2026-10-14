import { readFileSync, statSync, existsSync, openSync, readSync, fstatSync, closeSync, realpathSync, lstatSync } from "node:fs";
import { join, resolve, relative, basename, isAbsolute } from "node:path";
import { Buffer } from "node:buffer";

/**
 * A dispatched agent's name, or null when this process is the main session.
 *
 * Any name is accepted: `.pi/agents/*.md` may define custom agents. Only
 * `myflow-implement` and `myflow-check` have a curated JSONL manifest; every
 * other name, including the main session, gets none.
 */
export type AgentType = string | null;

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
  return [];
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
    join(taskDir, "design.md"),
    join(taskDir, "implement.md"),
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
  private readonly maxTotalBytes: number;
  private totalBytesUsed: number;
  private terminalSummaryEmitted = false;
  private stopped = false;

  constructor(maxTotalBytes: number, initialUsed = 0) {
    this.maxTotalBytes = maxTotalBytes;
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

/** Check whether a path is inside a root directory. */
function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// Trusted context roots: project-external files that JSONL context may reference.
// ---------------------------------------------------------------------------

const AUTO_TRUST_ENTRIES = ["tasks"];

function stripTrustValue(s: string): string {
  return s.trim().replace(/\s*#.*$/, "").trim().replace(/^['"]|['"]$/g, "");
}

function parseChannelTrustSection(content: string): { trustedDirs: string[]; autoTrustSymlinks?: boolean } {
  const lines = content.split("\n");
  const trustedDirs: string[] = [];
  let autoTrustSymlinks: boolean | undefined;
  let inChannel = false;
  let inList = false;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trimEnd();
    if (trimmed.trim().startsWith("#")) continue;

    if (/^channel:\s*$/.test(trimmed)) {
      inChannel = true;
      inList = false;
      continue;
    }
    if (!inChannel) continue;

    if (trimmed.trim() !== "" && /^\S/.test(line)) {
      inChannel = false;
      inList = false;
      continue;
    }
    if (trimmed.trim() === "") continue;

    if (inList) {
      const item = trimmed.match(/^ {4}-\s*(.+)$/);
      if (item) {
        const val = stripTrustValue(item[1]!);
        if (val) trustedDirs.push(val);
        continue;
      }
      inList = false;
    }

    if (/^ {2}trusted_context_dirs:\s*$/.test(trimmed)) {
      inList = true;
      continue;
    }

    const boolMatch = trimmed.match(/^ {2}auto_trust_myflow_symlinks:\s*(.+)$/);
    if (boolMatch) {
      const val = stripTrustValue(boolMatch[1]!).toLowerCase();
      if (val === "false") autoTrustSymlinks = false;
      else if (val === "true") autoTrustSymlinks = true;
      else process.stderr.write(`[channel] channel.auto_trust_myflow_symlinks: invalid value '${val}', ignoring\n`);
      continue;
    }
  }

  return { trustedDirs, autoTrustSymlinks };
}

export function resolveTrustedRoots(projectRoot: string): string[] {
  const configPath = join(projectRoot, ".myflow", "config.yaml");
  let config: { trustedDirs: string[]; autoTrustSymlinks?: boolean } = { trustedDirs: [] };
  if (existsSync(configPath)) {
    try {
      config = parseChannelTrustSection(readFileSync(configPath, "utf-8"));
    } catch {
      // ignore
    }
  }

  const roots: string[] = [];
  for (const entry of config.trustedDirs) {
    try {
      roots.push(realpathSync(resolve(projectRoot, entry)));
    } catch {
      // entry not found or invalid — skip
    }
  }

  if (config.autoTrustSymlinks !== false) {
    for (const entryName of AUTO_TRUST_ENTRIES) {
      const entryPath = join(projectRoot, ".myflow", entryName);
      try {
        if (lstatSync(entryPath).isSymbolicLink()) {
          roots.push(realpathSync(entryPath));
        }
      } catch {
        // missing / broken symlink — nothing to trust
      }
    }
  }

  return [...new Set(roots)];
}

/** Resolve a project file path, returning null if it escapes the project root and trusted roots. */
export function resolveProjectFile(projectRoot: string, file: string, trustedRoots: string[] = []): string | null {
  try {
    const rootReal = realpathSync(projectRoot);
    const targetReal = realpathSync(resolve(projectRoot, file));
    if (isInsideRoot(rootReal, targetReal)) return targetReal;
    if (trustedRoots.some((root) => isInsideRoot(root, targetReal))) return targetReal;
    return null;
  } catch {
    return null;
  }
}

/** Display a file path relative to the project root or task dir. */
export function displayProjectPath(projectRoot: string, filePath: string, taskDir?: string): string {
  const direct = relative(projectRoot, filePath).split("\\").join("/");
  if (direct && !direct.startsWith("../") && !isAbsolute(direct)) return direct;
  if (taskDir) {
    const taskRelative = relative(projectRoot, taskDir).split("\\").join("/");
    const taskLabel = taskRelative && !taskRelative.startsWith("../") && !isAbsolute(taskRelative)
      ? taskRelative
      : `.myflow/tasks/${basename(taskDir)}`;
    const withinTask = relative(taskDir, filePath).split("\\").join("/");
    if (withinTask && !withinTask.startsWith("../") && !isAbsolute(withinTask)) {
      return `${taskLabel}/${withinTask}`;
    }
  }
  try {
    return relative(realpathSync(projectRoot), realpathSync(filePath)).split("\\").join("/");
  } catch {
    return relative(projectRoot, filePath).split("\\").join("/");
  }
}

/** Build the budgeted task context. */
export function buildTaskContext(projectRoot: string, taskDir: string, agentType?: AgentType): string {
  const trustedRoots = resolveTrustedRoots(projectRoot);
  const parts: string[] = [];
  const limits = readContextInjectionLimits(projectRoot);
  const prefix = "<task-context>\nContext is bounded by .myflow/config.yaml. Files marked [truncated] or [omitted] remain authoritative on disk; use their required_read path before relying on missing detail.\n\n";
  const suffix = "\n</task-context>";
  const wrapperBytes = Buffer.byteLength(prefix + suffix, "utf-8");
  if (limits.max_total_bytes > 0 && limits.max_total_bytes < wrapperBytes) return "";
  const budget = new ContextBudget(limits.max_total_bytes, wrapperBytes);

  const appendCandidate = (primary: string | null, fallback: string | null = null): void => {
    const separator = parts.length > 0 ? "\n\n" : "";
    const output = budget.emitCandidate(
      primary === null ? null : separator + primary,
      fallback === null ? null : separator + fallback,
    );
    if (output !== null) parts.push(output);
  };

  // Task artifacts, injected in a fixed order and each bounded by
  // `max_artifact_bytes`: prd.md -> design.md -> implement.md -> info.md.
  // `design.md` / `implement.md` get exactly the treatment `prd.md` does,
  // which is what the Dispatch Protocol promises sub-agents. `info.md`
  // is myflow's own extra artifact. A missing document is skipped silently —
  // never an error — preserving the previous prd/info behavior.
  const artifactDocs: Array<{ name: string; reason: string }> = [
    { name: "prd.md", reason: "Requirements document" },
    { name: "design.md", reason: "Technical design document" },
    { name: "implement.md", reason: "Execution plan document" },
    { name: "info.md", reason: "Task information" },
  ];
  for (const artifactDoc of artifactDocs) {
    const artifactPath = join(taskDir, artifactDoc.name);
    if (!existsSync(artifactPath)) continue;
    const relativeArtifactPath = displayProjectPath(projectRoot, artifactPath, taskDir);
    const artifact = materialize(
      artifactPath,
      relativeArtifactPath,
      artifactDoc.reason,
      limits.max_artifact_bytes,
      "artifact",
    );
    appendCandidate(artifact.block, artifact.notice);
  }

  // Determine which jsonl files to read based on agent type
  const jsonlNames = taskContextJsonlNames(agentType);

  // A file may be referenced by both manifests. Use the resolved real path so
  // relative aliases and symlinked paths cannot consume the context budget twice.
  const includedPaths = new Set<string>();

  for (const jsonlName of jsonlNames) {
    const jsonlPath = join(taskDir, jsonlName);
    if (!existsSync(jsonlPath)) continue;

    const relativeJsonlPath = displayProjectPath(projectRoot, jsonlPath, taskDir);
    const manifest = readJsonlLines(jsonlPath, relativeJsonlPath);
    if (manifest.omitted) {
      appendCandidate(`## ${jsonlName}\n\n${manifest.omitted}`);
      continue;
    }

    const fileChunks: string[] = [];
    let sectionHeaderEmitted = false;
    for (const line of manifest.lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as Record<string, unknown>;
        const file = typeof row.file === "string" ? row.file.trim() : "";
        if (!file) continue;
        const targetPath = resolveProjectFile(projectRoot, file, trustedRoots);
        if (!targetPath) continue;
        if (includedPaths.has(targetPath)) continue;
        includedPaths.add(targetPath);
        const materialized = materialize(targetPath, file, typeof row.reason === "string" ? row.reason : "-", limits.max_file_bytes, "file");
        const sectionPrefix = sectionHeaderEmitted
          ? "\n\n---\n\n"
          : `${parts.length > 0 ? "\n\n" : ""}## ${jsonlName}\n\n`;
        const output = budget.emitCandidate(
          materialized.block === null ? null : `${sectionPrefix}${materialized.block}`,
          `${sectionPrefix}${materialized.notice}`,
        );
        if (output !== null) {
          fileChunks.push(output);
          sectionHeaderEmitted = true;
        }
      } catch {
        // seed rows and malformed lines are non-fatal
      }
    }

    if (fileChunks.length > 0) parts.push(fileChunks.join(""));
  }

  if (parts.length === 0) return "";
  const context = `${prefix}${parts.join("")}${suffix}`;
  if (limits.max_total_bytes <= 0 || Buffer.byteLength(context, "utf-8") <= limits.max_total_bytes) return context;
  const suffixBytes = Buffer.byteLength(suffix, "utf-8");
  const bodyLimit = Math.max(0, limits.max_total_bytes - suffixBytes);
  const body = truncateUtf8(Buffer.from(`${prefix}${parts.join("")}`, "utf-8"), bodyLimit).toString("utf-8");
  return `${body}${suffix}`;
}
