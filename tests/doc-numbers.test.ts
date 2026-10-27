import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Numbers that a shipped doc states and the code defines are a silent drift
// risk: nothing fails when one side changes. These cases pin the cross-language
// pairs that have no other comparator. A number with one home needs no entry.

const ROOT = join(import.meta.dirname, "..");
const CONVENTIONS = ".pi/skills/myflow-meta/references/harness-conventions.md";
const SPEC = ".myflow/spec/harness/index.md";

function read(rel: string): string {
  return readFileSync(join(ROOT, ...rel.split("/")), "utf-8");
}

/** The `## Tuning constants` table as key -> default literal, backticks stripped. */
function configKeyDefaults(): Map<string, string> {
  const lines = read(CONVENTIONS).split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith("## Tuning constants"));
  assert.ok(start >= 0, `${CONVENTIONS} must carry the tuning-constants table`);
  const rows = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const row = /^\| `([^`]+)` \| ([^|]+) \|/.exec(line);
    if (row) rows.set(row[1]!, row[2]!.trim().replace(/^`|`$/g, ""));
  }
  // A parser that silently matched zero rows would make every `rows.get` below
  // compare against `undefined` and hide a reformatted table.
  assert.ok(rows.size > 0, `${CONVENTIONS} must parse at least one tuning-constants row`);
  return rows;
}

/** `NAME = 60_000;` -> 60000. */
function numericConstant(source: string, name: string): number {
  const match = new RegExp(`${name}\\s*=\\s*([0-9_]+)\\s*;?\\s*$`, "m").exec(source);
  assert.ok(match, `could not read ${name}`);
  return Number(match[1]!.replace(/_/g, ""));
}

/** `NAME = 24 * 60 * 60 * 1000;` -> 86400000, without eval. */
function productConstant(source: string, name: string): number {
  const match = new RegExp(`${name}\\s*=\\s*([0-9_*\\s]+?)\\s*;?\\s*$`, "m").exec(source);
  assert.ok(match, `could not read ${name}`);
  return match[1]!
    .split("*")
    .map((part) => Number(part.trim().replace(/_/g, "")))
    .reduce((left, right) => left * right, 1);
}

/** `max_file_bytes: 32768,` -> 32768. */
function objectNumber(source: string, key: string): number {
  const match = new RegExp(`${key}:\\s*([0-9_]+)`).exec(source);
  assert.ok(match, `could not read ${key}`);
  return Number(match[1]!.replace(/_/g, ""));
}

test("the tuning-constants table matches the defaults the code reads", () => {
  const rows = configKeyDefaults();

  const skip = /DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD = "([^"]+)"/.exec(
    read(".pi/extensions/myflow/escape-hatch.ts"),
  );
  assert.ok(skip, "escape-hatch.ts must define the default skip keyword");
  assert.equal(rows.get("DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD"), skip[1]);

  const injection = read(".pi/extensions/myflow/context-injection.ts");
  for (const key of ["max_file_bytes", "max_artifact_bytes", "max_total_bytes"]) {
    assert.equal(rows.get(key), String(objectNumber(injection, key)), key);
  }

  const channel = read(".myflow/scripts/channel.py");
  assert.equal(
    rows.get("DEFAULT_MAX_LIVE_WORKERS"),
    String(numericConstant(channel, "DEFAULT_MAX_LIVE_WORKERS")),
  );
  assert.equal(
    rows.get("DEFAULT_IDLE_TIMEOUT"),
    String(numericConstant(channel, "DEFAULT_IDLE_TIMEOUT")),
  );

  // `task.py validate` warns at its own literal; the table must agree.
  const taskPy = read(".myflow/scripts/task.py");
  const validateDefault = /CONTEXT_MAX_FILE_BYTES = (\d+)/.exec(taskPy);
  assert.ok(validateDefault, "task.py must define CONTEXT_MAX_FILE_BYTES");
  assert.equal(rows.get("CONTEXT_MAX_FILE_BYTES"), validateDefault[1]);
});

test("the background timeouts in the docs match the constants", () => {
  const registry = read(".pi/extensions/myflow/background/registry.ts");
  const startingSeconds = numericConstant(registry, "STARTING_TIMEOUT_MS") / 1000;
  const pruneHours = productConstant(registry, "PRUNE_AFTER_MS") / 3_600_000;

  assert.match(read(CONVENTIONS), new RegExp(`after ${startingSeconds}s`));
  assert.match(read(SPEC), new RegExp(`\\(${startingSeconds}s\\)`));
  assert.match(read(SPEC), new RegExp(`more than ${pruneHours} hours`));
});
