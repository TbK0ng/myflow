import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseFrontmatter } from "../.pi/extensions/myflow/agents.ts";
import { parseWorkflowStateBlocks } from "../.pi/extensions/myflow/parse-workflow-state.ts";

const ROOT = join(import.meta.dirname, "..");

function filesUnder(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith(suffix))
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isFile());
}

function instructionFiles(): string[] {
  return [
    ...filesUnder(join(ROOT, ".pi", "skills"), ".md"),
    ...filesUnder(join(ROOT, ".pi", "prompts"), ".md"),
    ...filesUnder(join(ROOT, ".myflow", "spec"), ".md"),
    join(ROOT, ".myflow", "workflow.md"),
  ];
}


test("expected skills exist", () => {
  for (const name of [
    "myflow-meta",
    "myflow-brainstorm",
    "myflow-before-dev",
    "myflow-check",
    "myflow-update-spec",
    "myflow-break-loop",
    "myflow-spec-bootstrap",
    "myflow-channel",
  ]) {
    assert.ok(existsSync(join(ROOT, ".pi", "skills", name, "SKILL.md")), `missing skill ${name}`);
  }
  for (const reference of ["repository-analysis.md", "spec-task-planning.md", "spec-writing.md", "mcp-setup.md"]) {
    assert.ok(
      existsSync(join(ROOT, ".pi", "skills", "myflow-spec-bootstrap", "references", reference)),
      `missing spec-bootstrap reference ${reference}`,
    );
  }
  assert.ok(
    existsSync(join(ROOT, ".pi", "skills", "myflow-meta", "references", "harness-conventions.md")),
    "missing harness conventions reference",
  );
});

test("skill frontmatter is valid Pi skill frontmatter", () => {
  const skillFiles = filesUnder(join(ROOT, ".pi", "skills"), "SKILL.md");
  for (const file of skillFiles) {
    const { frontmatter } = parseFrontmatter(readFileSync(file, "utf-8"));
    const name = frontmatter.name;
    const description = frontmatter.description;
    assert.equal(typeof name, "string", `${file}: missing name`);
    assert.equal(typeof description, "string", `${file}: missing description`);
    assert.ok((description as string).length <= 1024, `${file}: description too long`);
    assert.ok(/^[a-z0-9-]+$/.test(name as string), `${file}: invalid skill name`);
  }
});

test("prompt templates declare descriptions", () => {
  for (const name of ["myflow-continue", "myflow-finish-work"]) {
    const file = join(ROOT, ".pi", "prompts", `${name}.md`);
    assert.ok(existsSync(file), `missing prompt ${name}`);
    assert.match(readFileSync(file, "utf-8"), /^---\r?\n[\s\S]*?description:/);
  }
});

test("workflow.md exposes a Phase Index and all four state blocks", () => {
  const content = readFileSync(join(ROOT, ".myflow", "workflow.md"), "utf-8");
  assert.match(content, /## Phase Index/);
  assert.match(content, /## Routing/);

  const blocks = parseWorkflowStateBlocks(content);
  for (const status of ["no_task", "planning", "in_progress", "completed"]) {
    assert.ok(blocks.has(status), `missing workflow-state block: ${status}`);
    assert.ok((blocks.get(status) ?? "").trim().length > 0, `empty workflow-state block: ${status}`);
  }
});

test("spec-dependent skills link to files that exist", () => {
  const missing: string[] = [];
  for (const file of filesUnder(join(ROOT, ".pi", "skills"), "SKILL.md")) {
    const content = readFileSync(file, "utf-8");
    for (const match of content.matchAll(/\]\((references\/[^)]+)\)/g)) {
      const target = join(dirname(file), match[1]);
      if (!existsSync(target)) missing.push(`${file} -> ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("spec-dependent skills tolerate a missing spec tree", () => {
  const beforeDev = readFileSync(join(ROOT, ".pi", "skills", "myflow-before-dev", "SKILL.md"), "utf-8");
  assert.match(beforeDev, /NO_SPEC/);
  assert.match(beforeDev, /myflow-spec-bootstrap/);

  const check = readFileSync(join(ROOT, ".pi", "skills", "myflow-check", "SKILL.md"), "utf-8");
  assert.match(check, /NO_SPEC/);

  const updateSpec = readFileSync(join(ROOT, ".pi", "skills", "myflow-update-spec", "SKILL.md"), "utf-8");
  assert.match(updateSpec, /missing|none yet|not exist/i);
});

test("the harness conventions describe the payload and its contracts", () => {
  const file = join(ROOT, ".pi", "skills", "myflow-meta", "references", "harness-conventions.md");
  const content = readFileSync(file, "utf-8");
  assert.match(content, /## Payload vs Project Files/);
  assert.match(content, /## Load-Bearing Contracts/);
  assert.match(content, /\.myflow\/spec\//);
  assert.match(content, /never copy/i);
});

test("agents keep frontmatter and the recursion guard", () => {
  for (const name of ["myflow-implement", "myflow-check", "myflow-research"]) {
    const file = join(ROOT, ".pi", "agents", `${name}.md`);
    assert.ok(existsSync(file), `missing agent ${name}`);
    const content = readFileSync(file, "utf-8");
    const { frontmatter } = parseFrontmatter(content);
    assert.equal(frontmatter.name, name);
    assert.equal(typeof frontmatter.description, "string");
    assert.equal(typeof frontmatter.tools, "string");
    assert.match(content, /Recursion Guard/);
  }
});

test("myflow_subagent is not offered as an agent tool (recursion guard depends on it)", () => {
  for (const name of ["myflow-implement", "myflow-check", "myflow-research"]) {
    const { frontmatter } = parseFrontmatter(readFileSync(join(ROOT, ".pi", "agents", `${name}.md`), "utf-8"));
    assert.ok(!String(frontmatter.tools).includes("myflow_subagent"), `${name} must not list myflow_subagent`);
  }
});

const SCRIPTS = [
  ".myflow/scripts/task.py",
  ".myflow/scripts/get_context.py",
  ".myflow/scripts/worktree.py",
  ".myflow/scripts/channel.py",
];

/**
 * Paths under `.pi/` or `.myflow/` that the harness creates while it runs
 * rather than ships. Everything else an instruction file names must exist —
 * including `.myflow/spec/...`, because a project-owned spec tree is still a
 * tree the payload promises; an instruction that names a layer of it must not
 * point at air.
 */
const RUNTIME_PREFIXES = [".myflow/tasks/", ".myflow/archive/", ".myflow/.runtime/"];
const RUNTIME_FILES = [".myflow/worktree.yaml", ".pi/mcp.json"];

/** Instruction files as repository-relative paths. */
function payloadInstructionFiles(): string[] {
  const files: string[] = [".myflow/workflow.md"];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) files.push(path);
    }
  };
  walk(".pi/skills");
  walk(".pi/prompts");
  walk(".pi/agents");
  walk(".myflow/agents");
  return files;
}

function payloadTokens(content: string): Set<string> {
  const tokens = new Set<string>();
  const pattern = /(\.pi|\.myflow)\/[A-Za-z0-9._/@-]+/g;
  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    const before = content.slice(Math.max(0, index - 2), index);
    // Skip machine-level locations (`~/.pi/agent/...`) and absolute paths: this
    // test is about what the project ships.
    if (before === "~/") continue;
    if (before.endsWith("/") && !before.endsWith("./")) continue;
    const token = match[0].replace(/[.,;:]+$/, "");
    if (token.includes("<") || token.includes("*")) continue;
    tokens.add(token);
  }
  return tokens;
}

test("instruction files only reference paths that exist or are created at runtime", () => {
  const files = payloadInstructionFiles();
  assert.ok(files.length >= 15, `expected instruction files, found ${files.length}`);
  // A project without a spec tree cannot satisfy a `.myflow/spec/...` reference,
  // so only hold the skills to it once this repository has one.
  const specTreeExists = existsSync(join(ROOT, ".myflow", "spec", "index.md"));
  const broken: string[] = [];
  for (const file of files) {
    const content = readFileSync(join(ROOT, file), "utf-8");
    for (const token of payloadTokens(content)) {
      if (RUNTIME_FILES.includes(token)) continue;
      if (RUNTIME_PREFIXES.some((prefix) => token === prefix.replace(/\/$/, "") || token.startsWith(prefix))) continue;
      if (!specTreeExists && token.startsWith(".myflow/spec/")) continue;
      if (!existsSync(join(ROOT, token))) broken.push(`${file} -> ${token}`);
    }
  }
  assert.deepEqual(broken, []);
});

test("instruction files only reference script subcommands that exist", () => {
  const subcommands = new Map<string, Set<string>>();
  for (const script of SCRIPTS) {
    const content = readFileSync(join(ROOT, script), "utf-8");
    // `add_parser(` may sit on its own line (task.py registers `gate-info`
    // that way), so allow whitespace between the call and its quoted name.
    // Missing a real subcommand here reads as a false "does not exist" for any
    // doc that names it — the exact drift this test hunts.
    subcommands.set(
      script,
      new Set(Array.from(content.matchAll(/add_parser\(\s*"([a-z_-]+)"/g), (m) => m[1] as string)),
    );
  }

  const broken: string[] = [];
  for (const file of payloadInstructionFiles()) {
    const content = readFileSync(join(ROOT, file), "utf-8");
    for (const [script, known] of subcommands) {
      const name = script.split("/").pop() as string;
      for (const match of content.matchAll(new RegExp(`${name.replace(".", "\\.")}[ \\t]+([a-z_-]+)`, "g"))) {
        const subcommand = match[1];
        if (subcommand === "") continue;
        if (!known.has(subcommand)) broken.push(`${file} -> ${name} ${subcommand}`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

test("the shipped payload is complete and imports nothing outside itself", () => {
  const required = [
    ".pi/extensions/myflow/index.ts",
    ".pi/extensions/myflow/subagent.ts",
    ".pi/agents/myflow-implement.md",
    ".pi/agents/myflow-check.md",
    ".pi/agents/myflow-research.md",
    ".pi/prompts/myflow-continue.md",
    ".pi/prompts/myflow-finish-work.md",
    ".pi/prompts/myflow-parallel.md",
    ".myflow/workflow.md",
    ".myflow/scripts/task.py",
    ".myflow/scripts/get_context.py",
    ".myflow/scripts/worktree.py",
    ".myflow/scripts/channel.py",
    ".myflow/agents/architect.md",
    ".myflow/agents/reviewer.md",
  ];
  for (const path of required) {
    assert.ok(existsSync(join(ROOT, path)), `payload is missing ${path}`);
  }

  // The extension is the one part Pi loads by path; it must stay self-contained.
  const extensionDir = join(ROOT, ".pi", "extensions", "myflow");
  const imports = readdirSync(extensionDir).flatMap((entry) => {
    if (!entry.endsWith(".ts")) return [];
    const content = readFileSync(join(extensionDir, entry), "utf-8");
    return [...content.matchAll(/from\s+"([^"]+)"/g)]
      .map((m) => m[1])
      .filter((specifier) => specifier.startsWith(".") || specifier.startsWith("/"))
      .map((specifier) => ({ file: entry, specifier }));
  });
  const outside = imports.filter(({ specifier }) => specifier.split("/").includes(".."));
  assert.deepEqual(outside, [], "extension files must not import outside .pi/extensions/myflow/");
});
