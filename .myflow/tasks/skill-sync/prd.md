# Sync the shipped skills with the harness

## Goal

Make the eight shipped skills true to the current code, and make hook drift fail
CI instead of arriving silently in the next payload.

## Problem

`.pi/skills/` is shipped payload: its text is the only instruction a future
agent gets about this harness, and it is copied into every project that installs
myflow. No test fails when a skill describes something that no longer exists.

A full audit found the path layer already guarded (every `.pi/` / `.myflow/` /
`tools/` / `tests/` path resolves except genuinely optional runtime files, every
inline-code identifier exists in code, `tests/skills-hygiene.test.ts` green,
366 tests green). The drift is in prose: counts, command lists, config tables.

Found now:

1. `myflow-meta`'s command block lists 9 of 12 `task.py` subcommands; the
   omitted `add-context` is a mandatory workflow step (1.3).
2. `harness-conventions.md`'s "Config Keys (all optional)" table omits
   `channel.worker_guard.max_live_workers` (3) and
   `channel.worker_guard.idle_timeout` (900), both read by `channel.py` and
   documented in `myflow-channel`.
3. The hook count appears in prose in four places; `.myflow/spec/harness/index.md`
   enumerates only three, so `myflow-check`'s copy is unguarded.
4. `.myflow/spec/guides/` is referenced by three skills, defined by none, and
   `myflow-before-dev` reads it unconditionally.
5. Drift proof: `tests/subagent.test.ts` still titles a test "all 6 hooks" while
   eight are registered.

## Solution

Correct the four real defects, delete duplicate prose instead of syncing it, and
add one assertion that ties the canonical hook table to the set the extension
actually registers.

## User stories

1. As a maintainer adding a Pi hook, I want CI to fail while the skill table is
   stale, so a stale map cannot ship.
2. As a maintainer adding a config key, I want one complete list of every key
   the harness reads.
3. As an agent reading the skill map, I want every `task.py` subcommand the
   workflow uses to be listed there.
4. As an agent in a project without `guides/`, I want the optional read not to
   look like a broken spec.
5. As a user installing the payload, I want the skills to describe only files
   the payload creates or that are explicitly optional.
6. As a reviewer, I want a mechanism behind the fix, not just corrected
   paragraphs.

## Out of scope

- Rewriting any skill's reasoning steps.
- `.pi/prompts/`, `.pi/agents/`, `.myflow/agents/`.
- Adding a `guides/` tree or any guide content to this repo.
- Generating skills from code, or a prose linter.
- Re-auditing `channel.py` / `task.py` behavior.

## Acceptance

- `npm run check` green, with the new assertion seen red first.
- No skill states a hook count outside the canonical table.
- Every config key read by code appears in the Config Keys table.
- `myflow-meta` lists all 12 `task.py` subcommands.
- `guides/` is either optional-by-contract or gone from all three skills.
