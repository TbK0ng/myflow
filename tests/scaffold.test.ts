import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { parseFrontmatter } from "../.pi/extensions/myflow/agents.ts";

const ROOT = join(import.meta.dirname, "..");

/**
 * The copyable payload. Everything a project needs to run the harness, and
 * nothing that belongs to the project itself (spec, tasks, runtime, config).
 */
const PAYLOAD_DIRS = [".pi"];
const PAYLOAD_TREES = [".myflow/scripts"];
const PAYLOAD_FILES = [".myflow/workflow.md"];
const PAYLOAD_ROOTS = [join(ROOT, ".pi"), join(ROOT, ".myflow", "scripts")];

const SKILLS = [
  "myflow-meta",
  "myflow-brainstorm",
  "myflow-before-dev",
  "myflow-check",
  "myflow-update-spec",
  "myflow-break-loop",
  "myflow-spec-bootstrap",
];
const AGENTS = ["myflow-implement", "myflow-check", "myflow-research"];
const PROMPTS = ["myflow-continue", "myflow-finish-work"];

function copyPayload(destination: string): void {
  for (const dir of PAYLOAD_DIRS) {
    cpSync(join(ROOT, dir), join(destination, dir), { recursive: true });
  }
  for (const tree of PAYLOAD_TREES) {
    cpSync(join(ROOT, tree), join(destination, tree), { recursive: true });
  }
  for (const file of PAYLOAD_FILES) {
    mkdirSync(dirname(join(destination, file)), { recursive: true });
    cpSync(join(ROOT, file), join(destination, file));
  }
}

function filesUnder(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith(suffix))
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isFile());
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

test("payload is self-contained: every relative import stays inside it", () => {
  const offenders: string[] = [];
  for (const file of filesUnder(join(ROOT, ".pi"), ".ts")) {
    const content = readFileSync(file, "utf-8");
    for (const match of content.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const specifier = match[1];
      const target = resolve(dirname(file), specifier);
      if (!existsSync(target)) offenders.push(`${relative(ROOT, file)} -> ${specifier} (missing)`);
      else if (!PAYLOAD_ROOTS.some((root) => isInside(root, target))) {
        offenders.push(`${relative(ROOT, file)} -> ${specifier} (escapes the payload)`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("payload carries agents, prompts, skills, and scripts", () => {
  for (const name of AGENTS) {
    const file = join(ROOT, ".pi", "agents", `${name}.md`);
    assert.ok(existsSync(file), `missing agent ${name}`);
    const { frontmatter } = parseFrontmatter(readFileSync(file, "utf-8"));
    assert.equal(frontmatter.name, name);
    assert.equal(typeof frontmatter.description, "string");
  }
  for (const name of PROMPTS) {
    assert.ok(existsSync(join(ROOT, ".pi", "prompts", `${name}.md`)), `missing prompt ${name}`);
  }
  for (const name of SKILLS) {
    const file = join(ROOT, ".pi", "skills", name, "SKILL.md");
    assert.ok(existsSync(file), `missing skill ${name}`);
    const { frontmatter } = parseFrontmatter(readFileSync(file, "utf-8"));
    assert.equal(frontmatter.name, name);
    assert.equal(typeof frontmatter.description, "string");
  }
  assert.ok(existsSync(join(ROOT, ".myflow", "scripts", "get_context.py")));
  assert.ok(existsSync(join(ROOT, ".myflow", "scripts", "task.py")));
  assert.ok(existsSync(join(ROOT, ".myflow", "workflow.md")));
});

test("copied payload extension registers hooks, tool, and command", async () => {
  const destination = mkdtempSync(join(tmpdir(), "myflow-payload-"));
  try {
    copyPayload(destination);
    const module = await import(pathToFileURL(join(destination, ".pi", "extensions", "myflow", "index.ts")).href);

    const handlers: Record<string, unknown> = {};
    const tools: Array<Record<string, unknown>> = [];
    const commands: Record<string, unknown> = {};
    const api = {
      on: (name: string, handler: unknown) => {
        handlers[name] = handler;
      },
      registerTool: (tool: Record<string, unknown>) => {
        tools.push(tool);
      },
      registerCommand: (name: string, options: unknown) => {
        commands[name] = options;
      },
      sendMessage: () => {},
      sendUserMessage: () => {},
      appendEntry: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      events: { emit: () => {}, on: () => () => {} },
    };

    module.default(api);

    assert.deepEqual(Object.keys(handlers).sort(), [
      "agent_before_settle",
      "before_agent_start",
      "context",
      "input",
      "session_before_compact",
      "session_start",
      "tool_call",
    ]);
    assert.ok(tools.some((tool) => tool.name === "myflow_subagent"), "myflow_subagent must register");
    assert.ok(commands["myflow-status"], "myflow-status must register");
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});

test("copied payload scripts run from the new project root", () => {
  const destination = mkdtempSync(join(tmpdir(), "myflow-payload-"));
  try {
    copyPayload(destination);
    const env = { ...process.env };
    const getContext = join(destination, ".myflow", "scripts", "get_context.py");
    const task = join(destination, ".myflow", "scripts", "task.py");

    const context = execFileSync("python3", [getContext], { cwd: destination, encoding: "utf-8", env });
    assert.match(context, /\[workflow-state:no_task\]/);
    assert.match(context, /## Session Runtime Context/);
    assert.match(context, /CURRENT TASK: none/);

    execFileSync("python3", [task, "create", "Scaffold task", "--slug", "scaffold"], {
      cwd: destination,
      encoding: "utf-8",
      env,
    });
    execFileSync("python3", [task, "start", ".myflow/tasks/scaffold"], { cwd: destination, encoding: "utf-8", env });
    const current = execFileSync("python3", [task, "current", "--source"], { cwd: destination, encoding: "utf-8", env });
    assert.match(current, /\.myflow\/tasks\/scaffold\tin_progress\tScaffold task/);
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});
