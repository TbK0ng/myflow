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
4. `.myflow/spec/guides/` is referenced by three skills but its definition was
   lost: it is a first-class layer of the spec tree (ported from the upstream
   Trellis layout, `spec-system.md` at `a0e3525`, and listed in
   `.myflow/spec/index.md` until `97a0382` rewrote that file), and the three
   skills are older than the rewrite. A first attempt declared it "optional,
   this project has none" and was wrong: the surviving references were evidence
   of intent, not stale text.
5. Drift proof: `tests/subagent.test.ts` still titles a test "all 6 hooks" while
   eight are registered.
6. `tools/release.py` can check, build and verify a release, but the step after
   that - bump the version, write the CHANGELOG entry, build, tag and push - is
   manual.

## Solution

Correct the real defects, delete duplicate prose instead of syncing it, and add
one assertion that ties the canonical hook table to the set the extension
actually registers.

For `guides/`: restore the required layer. `guides/` is part of the spec tree,
not an optional extra, so `myflow-before-dev`'s unconditional read comes back
and the tree this repo owns gets a real `guides/` entry, and the bootstrap that
generates trees creates it.

For releases: one command performs the whole release, with a dry run and without
pushing by default.

## User stories

1. As a maintainer adding a Pi hook, I want CI to fail while the skill table is
   stale, so a stale map cannot ship.
2. As a maintainer adding a config key, I want one complete list of every key
   the harness reads.
3. As an agent reading the skill map, I want every `task.py` subcommand the
   workflow uses to be listed there.
4. As an agent reading the spec tree, I want its `guides/` layer to exist and be
   described, so that the three skills that point at it are not pointing at air.
5. As a user installing the payload, I want the skills to describe only files
   the payload creates or that are clearly optional per project.
6. As a reviewer, I want a mechanism behind the fix, not just corrected
   paragraphs.
7. As a maintainer cutting a release, I want one command that bumps the version,
   writes the CHANGELOG entry, builds, verifies, commits, tags and pushes.
8. As a maintainer running that command by accident, I want it to refuse a dirty
   tree and to leave the push for an explicit flag.

## Out of scope

- Rewriting any skill's reasoning steps.
- `.pi/prompts/`, `.pi/agents/`, `.myflow/agents/`.
- Generating skills from code, or a prose linter.
- Porting the upstream thinking guides wholesale; this repo gets one guide with
  a real case behind it.

## Acceptance

- `npm run check` green, with the new assertion seen red first.
- No skill states a hook count outside the canonical table.
- Every config key read by code appears in the Config Keys table.
- `myflow-meta` lists all 12 `task.py` subcommands.
- `.myflow/spec/guides/` exists, is listed in `spec/index.md`, and every skill
  that mentions it describes it as part of the tree.
- `release.py --release patch --dry-run` prints the next version and the
  CHANGELOG heading without writing; `--release patch` without `--yes` stops
  before the push.
