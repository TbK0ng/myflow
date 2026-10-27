# Implementation Plan

Sections 1–4, 6 and 7 already landed in commit `7eedda5`. What remains is the
`guides/` correction (section 5) and the release command (section 8).

## 1–4, 6, 7 — DONE in `7eedda5`

Canonical hook table + the scaffold assertion, the two `channel.worker_guard`
config rows, the config-key checklist line, the full `task.py` command list, and
the stale "6 hooks" test title. Do not redo them; verify they still hold at the
end.

## 5. Restore `guides/` as a first-class spec layer

The first attempt declared it optional. That was wrong: `guides/` is a layer of
the spec tree (`guides/` landed in `a0e3525`,
listed in `spec/index.md` until `97a0382` dropped it). Reverse the optional
wording, restore the unconditional read, and give the tree a real one.

**`.pi/skills/myflow-before-dev/SKILL.md`** — Step 2: restore exactly
`cat .myflow/spec/guides/index.md`, with no tolerance suffix and no qualifier
comment: the layer is part of the tree, as it was before the first attempt.

**`.pi/skills/myflow-update-spec/SKILL.md`** — "What Counts As Spec": a question
to ask yourself belongs in `.myflow/spec/guides/`, part of the tree rather than
a coding spec. Minimal Tree: add `guides/index.md` to the sample layout.

**`.pi/skills/myflow-break-loop/SKILL.md`** — Step 5: `guides/index.md` without
the "and the project has a guides/ directory; it is optional" clause.

**`.myflow/spec/index.md`** — Layout lists `guides/index.md` as the
cross-cutting layer: thinking questions, not executable contracts. Drop "this
project has none".

**`.pi/skills/myflow-spec-bootstrap/references/spec-writing.md`** — `## File
Structure`: state that a generated tree always includes `guides/index.md`
alongside the layer directories, and what belongs in it.

**`.pi/skills/myflow-spec-bootstrap/SKILL.md`** — Done Criteria: every
generated tree includes `guides/index.md`; guide files are added beside it as
questions accumulate.

**New `.myflow/spec/guides/index.md`** — purpose, the one guide this repo has,
and thinking triggers that point at real local situations (doc claim vs code
drift, contract copies, hook/config counts). Keep it short; no content copied
from elsewhere.

**New `.myflow/spec/guides/doc-drift-thinking-guide.md`** — the guide this
session actually earned:
- A sentence naming a path, a subcommand, a count, or a default is a claim
  about code.
- When a claim and the code disagree, work out which is older before editing
  either: `git log -S <token>`, `git blame`, then the origin.
- Case study: `guides/` → spec-tree layout → `a0e3525` → dropped by `97a0382`
  while three skills kept naming it. The first fix called it optional; the
  surviving references were evidence of intent.
- A short checklist per claim type: path (does it resolve?), subcommand (does
  argparse/AST have it?), count (how many copies, which is canonical?),
  config key (is it read?), default (does it match the code?).

## 8. `tools/release.py --release`

One command for the release that is currently manual. Keep the existing
`--check` / `--out` / `--verify` behaviour untouched.

```
python tools/release.py --release {patch|minor|major} [--yes] [--dry-run]
```

Order of operations, each one failing loudly:
1. Refuse a dirty working tree (`git status --porcelain` non-empty) and a
   detached HEAD. The release must be reproducible from a clean tree.
2. Compute the next version from `package.json` (`patch`/`minor`/`major`
   arithmetic; no dependency, no tags consulted). Refuse if `0.x` semantics are
   unclear — plain integer arithmetic is enough.
3. Rewrite the `"version"` value in `package.json` with a targeted regex so the
   file's formatting is unchanged.
4. `CHANGELOG.md`: rename the first `## Unreleased` heading to
   `## <version> — <YYYY-MM-DD>`, then insert a fresh empty `## Unreleased`
   above it. Fail when there is no `## Unreleased` section or it is empty.
5. `--check`, then build into `dist/`, then the existing `verify`.
6. `git add package.json CHANGELOG.md`, commit `Release <version>`, create an
   annotated tag `v<version>`.
7. Only with `--yes`: `git push --follow-tags`. Without it, print the exact
   push command and stop with exit 0.

`--dry-run` performs steps 1–4 in memory, prints the next version, the new
CHANGELOG heading and the tag name, writes nothing, and skips the build.

Keep the style of the file: stdlib only, small named functions, a `fail()`
exit, help text in `parse_args`.

**`tests/release.test.ts`** — two cases in the existing `-N:` style, using a
temp git repo fixture (init, commit the payload root, set
`GIT_AUTHOR_*`/`GIT_COMMITTER_*` in the spawn env so no global config is
needed):
- `--release patch --dry-run` prints the bumped version, the version and date
  heading, and leaves `package.json` / `CHANGELOG.md` byte-identical.
- `--release patch` on a clean fixture bumps, commits and tags; without `--yes`
  it prints the push command and does not push. A dirty tree is refused with a
  useful message.

## Verify

```bash
npm run check
node --test tests/scaffold.test.ts tests/release.test.ts
python3 tools/release.py --check
python3 tools/release.py --release patch --dry-run
```

`--dry-run` runs against this repo and therefore must not write; check
`git status` after it.

## Done criteria

- `npm run check` green.
- `guides/` exists in this repo, is listed in `spec/index.md`, and no skill calls
  it optional or absent.
- `release.py --release patch --dry-run` is side-effect free; `--release patch`
  without `--yes` stops before the push, with a clean `git status` apart from
  the release commit and tag.

---

# Batch 3 — fix every finding from the parallel audit

Evidence: `.myflow/tasks/skill-sync/research/audit-{meta,process-skills,brainstorm,spec-skills,channel,cross-cutting}.md`.
Each item below is confirmed against code; do not re-litigate the finding, implement the fix.

## A. Instructions that send an agent into a wall (docs)

**A1. `myflow-check` Step 3.** `npm run check` is run by a check *sub-agent*, where
`MYFLOW_AGENT_TYPE` leaks and the suite is not hermetic (~23 false failures).
Replace the command with the scrubbed one and one line of why:
`env -u MYFLOW_AGENT_TYPE -u MYFLOW_CONTEXT_ID -u MYFLOW_SKIP_BREADCRUMB -u MYFLOW_WRITES_UNDER npm run check`.
Then fix the rule at its source: `.myflow/spec/harness/index.md`'s Pre-Development
Checklist says "from the main session, not from inside a sub-agent" — change it to
"every process that runs the suite scrubs the `MYFLOW_*` vars first; a check
sub-agent must, because it is the one that has to run it."

**A2. `myflow-meta` platform claim.** "each entry point refuses to start on another
platform" is false for `task.py` and `get_context.py` (no check). Narrow the
sentence to the four that do refuse: the extension, `bg_runner.mjs`,
`channel.py`, `worktree.py`.

**A3. `myflow-meta` dispatch details.** State that `chain` stops at the first
failed run (it does), that the six-prompt cap applies to `chain` too, add
`<session-overview>` to the injected-block list, and note that the `context` hook
also rebuilds `session-context`.

**A4. `myflow-channel`.** (a) "Interrupt and redirect" — `--kind interrupt` is a
message kind; nothing reads it mid-run. Say: durable message the worker sees on
its next channel read; to stop it now, `kill <handle>`. (b) The `spawn review`
snippet must `create review` first, or it fails on `_require_channel`. (c) The
guard is **per channel**, not global. (d) Cleanup snippets for global channels
need `--scope global` (they are unlistable/unkillable without it).

**A5. `myflow-brainstorm`.** (a) The create snippet is not copyable: `--slug
<auto>` is a bash redirect and `$(...)` captures the `created: ` prefix — use a
concrete slug and `| sed 's/^created: //'`. (b) Drop the false claim that `create`
adds an `MM-DD-` prefix (`_task_dir_for` uses the slug verbatim). (c) Rewrite
"Integration with Start Workflow" to the current phases: 1.1 brainstorm, 1.2
research, 1.3 `add-context` (empty manifests hard-block `start`), 1.4
approval+start, 2.x, 3.1–3.3. (d) Step 8: complex work also writes `design.md`
and `implement.md` — the gate hashes every plan file and injection feeds them.
(e) Research: `myflow-research` is allowlisted `read, write, find, grep, ls`, so
delegate **repository** reading to it; external web/`gh` research happens in the
current session (keep the persisted-file contract).

**A6. `myflow-update-spec` Related.** "capture harness lessons in
harness-conventions, not the project spec" contradicts this repo, whose project
spec *is* the harness spec. Say: harness-wide contracts go to
`harness-conventions.md`; project-local decisions go to the project spec — and in
this repo both apply.

**A7. `myflow-before-dev` Step 3.** It promises the Pre-Development Checklist names
the contracts; they live in Contracts / Quality Check. Reword.

**A8. `done` is not a status.** Remove it from `myflow-meta`, `harness-conventions.md`
and `.pi/prompts/myflow-continue.md`. `task.py` writes only `planning` /
`in_progress`, and `archive` rewrites to `completed`; no `done` block exists.

**A9. `myflow-spec-bootstrap`.** (a) `SKILL.md` says the codebase-memory MCP is
"already configured" — nothing configures it and no agent allowlist has MCP
tools. Say "if this Pi install exposes the graph tools (see
`references/mcp-setup.md`), otherwise use source reads". (b) `mcp-setup.md`
attributes the bare tool names to the MCP server; they come from an extension
that spawns the CLI. Say: inspect the names your backend actually exposes; do not
hardcode. (c) `spec-writing.md`'s worked example names `src/turn-cache.ts`
(the real file is `.pi/extensions/myflow/turn-cache.ts`) and claims `create`
returns only the dir — it also writes the session pointer when none exists.
Correct both.

## B. Code

**B1. Verify gate inherits the sub-agent env.** `runVerifyCommands` in
`.pi/extensions/myflow/index.ts` spawns `python3 worktree.py verify` with the
parent env, so a `verify: npm run check` command inside a check agent runs the
non-hermetic suite. Strip every `MYFLOW_*` key from the child env (same rule as
`child_env()` in `tools/release.py`). Test that fails when the strip is reverted.

**B2. `channel.py` docstring.** It teaches `~/.myflow/channels`; `HOME_STORE` is
`~/.pi/myflow/channels`. Fix the docstring (the skill already warns correctly).

## C. Make the verify gate real

**C1. Add `.myflow/worktree.yaml`** with `verify: [npm run check]` (the file is
project-owned and absent today, so the settle gate runs zero commands and always
passes). Confirm `python3 .myflow/scripts/worktree.py verify` passes after B1.

**C2. `.myflow/spec/harness/index.md` bash premise.** The gotcha says the
`writesUnder` guard is "unreachable for the current agents (no `bash`)" —
`myflow-check` and `myflow-implement` both declare `bash`. Rewrite: the guard
bounds `write`/`edit` lexically; `bash` can write around it by design, so scope
is a blast-radius boundary, not a sandbox. Fix the matching "Revisit if" line.

## D. Guards for the class we keep fixing

**D1. `tests/skills-hygiene.test.ts`** exempts every `.myflow/spec/` path, which
is why `guides/` could vanish unnoticed. Add: when `.myflow/spec/index.md`
exists, every `.myflow/spec/...` token in an instruction file that contains no
`<` or `*` must exist on disk.

**D2. `32768` has two code homes** (`context-injection.ts:21` and `task.py:220`).
Add a test (in `tests/context-injection.test.ts`) that reads both literals and
asserts they are equal, so the cross-language pair cannot drift silently.

## Verify

```bash
env -u MYFLOW_AGENT_TYPE -u MYFLOW_CONTEXT_ID -u MYFLOW_SKIP_BREADCRUMB -u MYFLOW_WRITES_UNDER npm run check
python3 .myflow/scripts/worktree.py verify
node --test tests/skills-hygiene.test.ts tests/context-injection.test.ts
```

Also re-run the audit greps: no `done` status claim, no "no `bash`" premise, no
`~/.myflow/channels` in `channel.py`, `myflow-check`'s command scrubbed.

## Done criteria

- Every A/B/C/D item above is applied, and `npm run check` is green.
- The new guards are seen red once (D1: temporarily delete `guides/index.md`;
  D2: change one literal) and restored.
- `worktree.py verify` runs the suite and passes.
