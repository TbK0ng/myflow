# Implementation Plan

Six small edits and one test. No new files in the payload.

## 1. Canonical hook set — delete the extra copies

**`.pi/skills/myflow-meta/SKILL.md`**
- Frontmatter `description`: replace "the eight extension hooks" with "the
  extension hooks" (keep the rest of the sentence).
- Keep the hook table exactly as is (it is the canonical home).

**`.pi/skills/myflow-check/SKILL.md`**
- Line: `- [ ] No regression in the eight extension hooks or myflow_subagent.`
  → `- [ ] No regression in the extension hooks (the table in myflow-meta) or myflow_subagent.`

## 2. Hook set is tested, not just documented

**`tests/scaffold.test.ts`** — extend the test `copied payload extension
registers hooks, tool, and command` (it already builds `handlers` from the
copied payload). After the existing exhaustive-hook assertion, add:
- Read `${destination}/.pi/skills/myflow-meta/SKILL.md`.
- Extract the hook names from the rows of the "Hook | What it does" table
  (first cell inside backticks), i.e. every row whose first cell matches a
  registered handler name pattern.
- Assert both directions: (a) every key of `handlers` appears in the table,
  (b) every table row names a registered handler. Fail with the missing/extra
  name in the message.
- Also assert every registered hook name appears somewhere in
  `.pi/skills/myflow-meta/references/harness-conventions.md` (the "All eight
  hooks stay registered" bullet). One-way check is enough there.

Keep it a plain parse (`matchAll` over `^\| \`([a-z_]+)\` \|`), no markdown
dependency. Node builtins only.

## 3. Complete config table

**`.pi/skills/myflow-meta/references/harness-conventions.md`** — in
`## Config Keys`, add two rows after `channel.auto_trust_myflow_symlinks`:
- `channel.worker_guard.max_live_workers` | `3` | Cap on live workers; `spawn`
  refuses above it
- `channel.worker_guard.idle_timeout` | `900` | Seconds before the guard stops an
  idle worker

Match the existing `channel.py` defaults and the wording in `myflow-channel`.

## 4. Checklist line for config keys

**`.myflow/spec/harness/index.md`** — add one `## Quality Check` bullet: a new
config key read by `.pi/extensions/myflow/` or `.myflow/scripts/` must be added
to the Config Keys table in `harness-conventions.md` in the same change (a
`channel.worker_guard` key also updates `myflow-channel`).

## 5. `guides/` becomes optional and defined

**`.pi/skills/myflow-before-dev/SKILL.md`** — Step 2: change
`cat .myflow/spec/guides/index.md` to a tolerant read, e.g.
`cat .myflow/spec/guides/index.md 2>/dev/null || true`, and add "(optional;
skip when absent)".

**`.pi/skills/myflow-update-spec/SKILL.md`** — in "What Counts As Spec" and the
Minimal Tree, state that `guides/` is an optional sibling directory for thinking
questions, present only when the project has some.

**`.myflow/spec/index.md`** — add to `## Layout`: `guides/` is optional, holds
thinking questions rather than executable contracts, and this project has none.

Do not touch `myflow-break-loop`'s `guides/index.md` line beyond optional
wording if it reads as mandatory.

## 6. Complete lifecycle command list

**`.pi/skills/myflow-meta/SKILL.md`** — in the `## Task Lifecycle` bash block add:
- `task.py add-context <task> <implement|check> <path> "<why>"` — curate a
  manifest entry
- `task.py validate <task>` — check the manifests have curated entries
- `task.py finish` — clear the active-task pointer without changing status

Keep the block ordered as the workflow uses them.

## 7. Optional one-liner

**`tests/subagent.test.ts`** — retitle `all 6 hooks` to `all registered hooks`.
Do it: it is one word and it is the drift this change is about.

## Verify

```bash
npm run check
node --test tests/scaffold.test.ts
```

Then confirm by hand that `grep -rn "eight" .pi/skills` shows only the canonical
table row and the conventions bullet.

## Done criteria

- `npm run check` green; the new assertion was seen red before the table was
  edited (temporarily rename a table row, watch it fail, restore).
- No skill states a hook count outside `myflow-meta`'s table.
- Config Keys table names every key the code reads.
- `myflow-meta` lists all 12 `task.py` subcommands.
- `guides/` reads as optional in all three skills that mention it.
