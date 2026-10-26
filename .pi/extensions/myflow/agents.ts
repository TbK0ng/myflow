/**
 * Agent definitions from `<project>/.pi/agents/*.md`.
 *
 * Frontmatter (YAML subset):
 *
 *     ---
 *     name: myflow-implement
 *     description: Implementation expert.
 *     tools: read, write, edit, bash, find, grep, ls
 *     model: provider/model        # optional
 *     thinking: high               # optional
 *     writesUnder: research        # optional; task-relative write scope
 *     ---
 *     System prompt for the agent goes here.
 *
 * Runtime imports are limited to Node builtins so the module stays importable
 * under `node --test` without installing the Pi package.
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { isAbsolute } from "node:path";
import { dirname, join, resolve } from "node:path";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  /**
   * Task-relative directory this agent's writes are confined to. A declared
   * scope lets a write-capable agent run in parallel: `subagent.ts` passes it
   * as `MYFLOW_WRITES_UNDER`, and the child's `tool_call` guard blocks any
   * write/edit outside `<active task>/<writesUnder>/`.
   */
  writesUnder?: string;
  systemPrompt: string;
  filePath: string;
}

/**
 * Whether a declared `writesUnder` scope is a safe, task-relative directory.
 *
 * An absolute path, a drive letter, or any `..` segment widens the boundary
 * silently (no test would notice), so all three fail closed. The scope is the
 * only thing standing between a parallel writer and the whole working tree, so
 * it is validated rather than trusted.
 */
export function isSafeWriteScope(scope: string): boolean {
  const value = scope.trim();
  if (!value) return false;
  if (isAbsolute(value)) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[\\/]+/).includes("..");
}

/**
 * Normalize a path for a containment check.
 *
 * `resolve` collapses `..` and normalizes separators; unifying to `/` keeps the
 * prefix check from being fooled by a `\` vs `/` difference, and lowercasing
 * makes the comparison case-insensitive, as NTFS itself is (Windows only). This is a
 * lexical check (it does not follow symlinks): the guarantee is a directory
 * boundary, not mutual exclusion.
 *
 * It lives here, next to `isSafeWriteScope`, because two callers need the same
 * rule and one of them (`background/`) must not import `index.ts`: the
 * `writesUnder` guard (`index.ts`, via `evaluateWriteScope`) and the
 * `myflow_bg_start` `cwd` test (R5/ADR-9). A second copy of this predicate is
 * exactly the kind of drift that lets one boundary be loosened alone.
 */
export function normalizeWriterPath(target: string, baseDir: string): string {
  return resolve(baseDir, target).split("\\").join("/").toLowerCase();
}

/** Whether `target` resolves to `root` or a path inside it. */
export function isWithinWriteScope(target: string, root: string, baseDir: string): boolean {
  const normalizedTarget = normalizeWriterPath(target, baseDir);
  let normalizedRoot = normalizeWriterPath(root, baseDir);
  while (normalizedRoot.length > 1 && normalizedRoot.endsWith("/")) {
    normalizedRoot = normalizedRoot.slice(0, -1);
  }
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  agentsDir: string | null;
}

/** Pi's project configuration directory name. */
export const CONFIG_DIR_NAME = ".pi";

/**
 * Parse frontmatter from a Markdown file.
 *
 * Supports the small YAML subset used by agent files: plain and quoted scalars,
 * comma-separated or inline lists, and `|` block scalars. Unsupported YAML is
 * preserved as text rather than throwing.
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) {
    return { frontmatter: {}, body: normalized };
  }
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: normalized };
  }
  const rawFrontmatter = normalized.slice(3, end).replace(/^\n/, "");
  const body = normalized.slice(end + 4).replace(/^\n/, "");
  return { frontmatter: parseSimpleYaml(rawFrontmatter), body };
}

/** Parse the restricted YAML used in agent frontmatter. */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i += 1;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];

    if (rawValue === "|" || rawValue === ">" || rawValue === "|-" || rawValue === ">-") {
      const block: string[] = [];
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim() && !/^\s/.test(next)) break;
        block.push(next.replace(/^ {2}/, ""));
        i += 1;
      }
      const value = rawValue.startsWith(">")
        ? block.join(" ").trim()
        : block.join("\n").replace(/\n+$/, "");
      result[key] = value.trim();
      continue;
    }

    result[key] = parseScalar(rawValue.trim());
  }
  return result;
}

function parseScalar(raw: string): unknown {
  const value = stripInlineComment(raw).trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitList(value.slice(1, -1));
  }
  return unquote(value);
}

function stripInlineComment(value: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      const prev = value[i - 1];
      if (i === 0 || prev === " " || prev === "\t") return value.slice(0, i);
    }
  }
  return value;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter(Boolean);
}

/** Normalize a frontmatter `tools` value into a list of tool names. */
export function parseToolList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = raw
    .filter((tool): tool is string => typeof tool === "string")
    .map((tool) => tool.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string): AgentConfig[] {
  const agents: AgentConfig[] = [];
  if (!existsSync(dir)) return agents;

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = join(dir, entry.name);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
      continue;
    }

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parseToolList(frontmatter.tools),
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
      writesUnder:
        typeof frontmatter.writesUnder === "string" && frontmatter.writesUnder.trim()
          ? frontmatter.writesUnder.trim()
          : undefined,
      systemPrompt: body,
      filePath,
    });
  }

  return agents;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Walk up from `cwd` looking for the nearest `.pi/agents` directory. */
export function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = resolve(cwd);
  for (;;) {
    const candidate = join(currentDir, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/** Discover the project's agents. */
export function discoverAgents(cwd: string): AgentDiscoveryResult {
  const agentsDir = findNearestProjectAgentsDir(cwd);
  return { agents: agentsDir ? loadAgentsFromDir(agentsDir) : [], agentsDir };
}
