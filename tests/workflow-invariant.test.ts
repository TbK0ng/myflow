import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOW = join(ROOT, ".myflow", "workflow.md");

/**
 * Breadcrumb invariant.
 *
 * `workflow.md` states this contract in its `WORKFLOW-STATE
 * BREADCRUMB CONTRACT` comment:
 *
 *   "Every workflow-walkthrough step marked `[required · once]` must have a
 *    matching enforcement line in its phase's [workflow-state:*] block. The
 *    breadcrumb is the only per-turn channel; if a mandatory step isn't
 *    mentioned there, the AI silently skips it (Phase 1 planning gate skip and
 *    Phase 3.4 commit skip both manifested via this gap)."
 *
 * The rule is pinned to that comment's text. myflow keeps its own four state
 * tags, so the step-number → phase-tag scoping is declared explicitly below
 * instead of copied.
 */

/** Step-number prefix → the phase's `[workflow-state:*]` tag. */
const PHASE_BLOCK: Record<string, string> = {
  "1": "planning",
  "2": "in_progress",
  "3": "completed",
};

/**
 * The enforcement line each `[required · once]` step must leave in its phase
 * block. One or more patterns; every pattern must match somewhere in the block
 * body. Deleting the line a step is carried by turns this test red.
 *
 * This is deliberately not reused from `skills-hygiene.test.ts`'s `required`
 * array: that is a payload-completeness manifest, a different invariant that
 * merely shares a word.
 */
const ENFORCEMENT: Record<string, RegExp[]> = {
  "1.1": [/myflow-brainstorm/],
  "1.3": [/implement\.jsonl/, /check\.jsonl/],
  "1.4": [/task\.py start/],
  "3.2": [/commit/i],
  "3.3": [/myflow-finish-work/],
};

function stateBlocks(markdown: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const pattern = /\[workflow-state:([A-Za-z0-9_-]+)\]([\s\S]*?)\[\/workflow-state:\1\]/g;
  for (const match of markdown.matchAll(pattern)) {
    blocks.set(match[1] as string, match[2] as string);
  }
  return blocks;
}

/** Step ids from the Phase Index table whose rule carries `[required · once]`. */
function requiredOnceSteps(markdown: string): string[] {
  const steps: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const row = line.match(/^\|\s*(\d+\.\d+)\s*\|[^|]*\|([^|]*)\|/);
    if (!row) continue;
    const rule = row[2] as string;
    if (/\[required\b[^\]]*\bonce\b[^\]]*\]/.test(rule)) steps.push(row[1] as string);
  }
  return steps;
}

test("every [required · once] step has an enforcement line in its phase's state block", () => {
  const markdown = readFileSync(WORKFLOW, "utf-8");
  const steps = requiredOnceSteps(markdown);
  const blocks = stateBlocks(markdown);

  // Guard the guard: if the table stops marking steps this test would pass
  // vacuously, so require the current set to be non-empty.
  assert.ok(steps.length > 0, "workflow.md must mark at least one [required · once] step");

  // A newly added mandatory step must be bound to an enforcement line here,
  // and a stale map entry must be removed, so the map cannot drift from the
  // table in either direction.
  assert.deepEqual(
    [...steps].sort(),
    Object.keys(ENFORCEMENT).sort(),
    "the enforcement map must cover exactly the [required · once] steps in workflow.md",
  );

  for (const step of steps) {
    const phase = (step.split(".")[0] as string);
    const blockName = PHASE_BLOCK[phase];
    assert.ok(blockName, `step ${step} has no phase-block mapping`);
    const block = blocks.get(blockName);
    assert.ok(block, `workflow.md is missing [workflow-state:${blockName}] for step ${step}`);
    for (const pattern of ENFORCEMENT[step] as RegExp[]) {
      assert.match(
        block,
        pattern,
        `step ${step} has no enforcement line in [workflow-state:${blockName}] (expected ${pattern})`,
      );
    }
  }
});
