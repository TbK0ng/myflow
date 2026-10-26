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
the spec tree (upstream Trellis `.trellis/spec/guides/`, ported in `a0e3525`,
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
drift, contract copies, hook/config counts). Keep it short; no upstream content
copied.

**New `.myflow/spec/guides/doc-drift-thinking-guide.md`** — the guide this
session actually earned:
- A sentence naming a path, a subcommand, a count, or a default is a claim
  about code.
- When a claim and the code disagree, work out which is older before editing
  either: `git log -S <token>`, `git blame`, then the upstream origin.
- Case study: `guides/` → Trellis layout → `a0e3525` → dropped by `97a0382`
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
