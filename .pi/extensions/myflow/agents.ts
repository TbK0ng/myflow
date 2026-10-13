/**
 * Agent discovery and configuration for the myflow Pi harness.
 *
 * Agent definitions are Markdown files with YAML frontmatter:
 *
 *     ---
 *     name: myflow-implement
 *     description: Implementation expert.
 *     tools: read, write, edit, bash, find, grep, ls
 *     ---
 *     System prompt for the agent goes here.
 *
 * Locations:
 *   - `~/.pi/agent/agents/*.md`  (user level, always available)
 *   - `<project>/.pi/agents/*.md` (project level, used with scope "project"/"both")
 *
 * Runtime imports are limited to Node builtins so the module stays importable
 * under `node --test` without installing the Pi package.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

/** Pi's project configuration directory name. */
export const CONFIG_DIR_NAME = ".pi";

/** Resolve the Pi agent directory (honors `PI_CODING_AGENT_DIR`). */
export function getAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) return resolve(override);
  return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/**
 * Parse frontmatter from a Markdown file.
 *
 * Supports the small YAML subset used by myflow agent files: plain scalars,
 * quoted scalars, comma-separated lists, inline `[a, b]` lists, and `|` block
 * scalars. Unsupported YAML is preserved as text rather than throwing.
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
  const unquoted = unquote(value);
  return unquoted;
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

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  const agents: AgentConfig[] = [];
  if (!existsSync(dir)) return agents;

  let entries: ReturnType<typeof readdirSync>;
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
      systemPrompt: body,
      source,
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

/** Discover agents for the requested scope. */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userDir = join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
  const projectAgents =
    scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

  const agentMap = new Map<string, AgentConfig>();
  if (scope === "both") {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  } else if (scope === "user") {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
  } else {
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  }

  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
