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
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { parseFrontmatter } from "../.pi/extensions/myflow/agents.ts";

const ROOT = join(import.meta.dirname, "..");

/**
 * The copyable payload manifest: the single source of truth for what may leave
 * this repository. `tools/release.py` reads the same file — never duplicate the
 * list here, or the two consumers drift apart.
 *
 * `dirs` and `trees` are both whole-tree copies; they are listed apart only so a
 * reader can tell root-level directories from nested ones.
 */
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "tools", "release-payload.json"), "utf-8")) as {
  version: number;
  dirs: string[];
  trees: string[];
  files: string[];
  exclude: string[];
};
const PAYLOAD_TREES = [...MANIFEST.dirs, ...MANIFEST.trees];
const PAYLOAD_FILES = [...MANIFEST.files];
const PAYLOAD_ROOTS = PAYLOAD_TREES.map((tree) => join(ROOT, tree));

/** One segment of an `exclude` pattern: `*` and `?` match inside a segment only. */
function segmentMatches(pattern: string, segment: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${source}$`).test(segment);
}

/** Segment-wise fnmatch: a `**` segment matches any number of path segments. */
function pathMatches(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...rest] = pattern;
  if (head === "**") {
    for (let take = 0; take <= path.length; take += 1) {
      if (pathMatches(rest, path.slice(take))) return true;
    }
    return false;
  }
  return path.length > 0 && segmentMatches(head, path[0]) && pathMatches(rest, path.slice(1));
}

/**
 * Whether a project-relative path (always `/`-separated) is filtered out by the
 * manifest's `exclude` rules. Directories are matched as the path itself, so
 * `**\/__pycache__/**` drops the directory before its contents are visited.
 */
function matchesExclude(relPath: string): boolean {
  const segments = relPath.split("/");
  return MANIFEST.exclude.some((rule) => pathMatches(rule.split("/"), segments));
}

function isExcluded(path: string, root: string = ROOT): boolean {
  const relPath = relative(root, path).split(sep).join("/");
  return relPath !== "" && !relPath.startsWith("..") && matchesExclude(relPath);
}

const SKILLS = [
  "myflow-meta",
  "myflow-brainstorm",
  "myflow-before-dev",
  "myflow-check",
  "myflow-update-spec",
  "myflow-break-loop",
  "myflow-spec-bootstrap",
  "myflow-channel",
];
const AGENTS = ["myflow-implement", "myflow-check", "myflow-research"];
const RUNTIME_AGENTS = ["architect", "reviewer"];
const PROMPTS = ["myflow-continue", "myflow-finish-work", "myflow-parallel"];

/** Copy the payload described by the manifest, applying its `exclude` rules. */
function copyPayload(destination: string, source: string = ROOT): void {
  const filter = (path: string): boolean => !isExcluded(path, source);
  for (const tree of PAYLOAD_TREES) {
    cpSync(join(source, tree), join(destination, tree), { recursive: true, filter });
  }
  for (const file of PAYLOAD_FILES) {
    mkdirSync(dirname(join(destination, file)), { recursive: true });
    cpSync(join(source, file), join(destination, file), { filter });
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
  assert.ok(existsSync(join(ROOT, ".myflow", "scripts", "worktree.py")));
  assert.ok(existsSync(join(ROOT, ".myflow", "scripts", "channel.py")));
  assert.ok(existsSync(join(ROOT, ".myflow", "workflow.md")));
  for (const name of RUNTIME_AGENTS) {
    const file = join(ROOT, ".myflow", "agents", `${name}.md`);
    assert.ok(existsSync(file), `missing runtime agent ${name}`);
    const { frontmatter } = parseFrontmatter(readFileSync(file, "utf-8"));
    assert.equal(frontmatter.name, name);
    assert.equal(typeof frontmatter.description, "string");
  }
});

test("copied payload mirrors the manifest, and nothing machine-generated rides along", () => {
  const destination = mkdtempSync(join(tmpdir(), "myflow-payload-"));
  try {
    copyPayload(destination);
    // The expectation below is not a second manifest: it only reuses the
    // harness's own inventory constants to prove the copy followed the manifest,
    // so dropping an entry from `tools/release-payload.json` turns this red.
    const expected = [
      ...AGENTS.map((name) => `.pi/agents/${name}.md`),
      ...PROMPTS.map((name) => `.pi/prompts/${name}.md`),
      ...SKILLS.map((name) => `.pi/skills/${name}/SKILL.md`),
      ".myflow/workflow.md",
      ...["get_context.py", "task.py", "worktree.py", "channel.py"].map((name) => `.myflow/scripts/${name}`),
      ...RUNTIME_AGENTS.map((name) => `.myflow/agents/${name}.md`),
    ];
    const copied = readdirSync(destination, { recursive: true })
      .map((entry) => String(entry).split(sep).join("/"))
      .sort();
    assert.deepEqual(
      expected.filter((path) => !copied.includes(path)),
      [],
      "the copied payload is missing manifest entries",
    );
    assert.deepEqual(
      copied.filter((path) => path.includes("__pycache__") || path.endsWith(".pyc")),
      [],
      "machine-generated files must not be copied",
    );
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});

test("copyPayload applies the manifest exclude rules to a seeded tree", () => {
  const source = mkdtempSync(join(tmpdir(), "myflow-source-"));
  const destination = mkdtempSync(join(tmpdir(), "myflow-payload-"));
  try {
    const seed = (relPath: string, content = "x"): void => {
      mkdirSync(dirname(join(source, relPath)), { recursive: true });
      writeFileSync(join(source, relPath), content);
    };
    seed(".pi/extensions/myflow/index.ts", "export default () => {};\n");
    seed(".myflow/scripts/task.py", "print('x')\n");
    seed(".myflow/scripts/__pycache__/task.cpython-310.pyc", "pyc");
    seed(".myflow/scripts/debug.log", "log");
    seed(".myflow/scripts/scratch.tmp", "tmp");
    seed(".myflow/agents/architect.md", "---\nname: architect\n---\n");
    seed(".myflow/workflow.md", "# workflow\n");

    copyPayload(destination, source);

    const copied = readdirSync(destination, { recursive: true })
      .map((entry) => String(entry).split(sep).join("/"))
      .sort();
    assert.deepEqual(copied.filter((path) => /__pycache__|\.pyc$|\.log$|\.tmp$/.test(path)), []);
    for (const kept of [
      ".pi/extensions/myflow/index.ts",
      ".myflow/scripts/task.py",
      ".myflow/agents/architect.md",
      ".myflow/workflow.md",
    ]) {
      assert.ok(copied.includes(kept), `expected ${kept} to be copied`);
    }
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
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
      "session_shutdown",
      "session_start",
      "tool_call",
    ]);

    // The hook table in the shipped myflow-meta skill is the canonical hook set;
    // the conventions list restates the names. Both must match what registered.
    const registered = Object.keys(handlers);
    const metaSkill = readFileSync(join(destination, ".pi", "skills", "myflow-meta", "SKILL.md"), "utf-8");
    const metaLines = metaSkill.split(/\r?\n/);
    const tableStart = metaLines.findIndex((line) => line.startsWith("| Hook | What it does |"));
    assert.ok(tableStart >= 0, "myflow-meta must carry the canonical hook table");
    const tableHooks: string[] = [];
    for (const line of metaLines.slice(tableStart + 1)) {
      if (!line.startsWith("|")) break;
      const row = /^\| `([a-z_]+)` \|/.exec(line);
      if (row) tableHooks.push(row[1]);
    }
    const untabled = registered.filter((name) => !tableHooks.includes(name));
    assert.deepEqual(untabled, [], `hook table in myflow-meta is missing: ${untabled.join(", ")}`);
    const unregistered = tableHooks.filter((name) => !registered.includes(name));
    assert.deepEqual(unregistered, [], `hook table in myflow-meta names unregistered hooks: ${unregistered.join(", ")}`);
    const conventions = readFileSync(
      join(destination, ".pi", "skills", "myflow-meta", "references", "harness-conventions.md"),
      "utf-8",
    );
    const unconventioned = registered.filter((name) => !conventions.includes(`\`${name}\``));
    assert.deepEqual(
      unconventioned,
      [],
      `harness-conventions.md does not name these hooks: ${unconventioned.join(", ")}`,
    );
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
    execFileSync("python3", [task, "start", ".myflow/tasks/scaffold", "--allow-empty-context", "--allow-unapproved"], { cwd: destination, encoding: "utf-8", env });
    const current = execFileSync("python3", [task, "current", "--source"], { cwd: destination, encoding: "utf-8", env });
    assert.match(current, /\.myflow\/tasks\/scaffold\tin_progress\tScaffold task/);
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});
