# Spec Writing

myflow specs are coding guidance for future agents. They should explain how to
work in this repository, not how a generic project might be organized.

## Write From Evidence

Each important rule should be backed by one of these:

- A source file that demonstrates the preferred pattern.
- A test file that shows expected behavior.
- A project document that defines the convention.
- A repeated pattern across multiple files.

Use short snippets only when they make the rule clearer. Prefer linking to the
file path and naming the symbol or behavior.

## File Structure

Keep the spec tree aligned with the project:

- Keep `index.md` as the navigation file for each spec directory.
- Always include `guides/index.md` alongside the layer directories. It holds
  thinking questions — how to decide what is true, which copy of a rule is
  canonical — not coding rules. Add guide files beside it as the project
  accumulates them.
- Split topics when developers would look for them independently.
- Merge topics when separate files would repeat the same rule.
- Delete files that do not apply.
- Add new files for important local patterns the template missed.

## Content Standards

Good spec sections include:

- When the rule applies.
- The local pattern to follow.
- The source or test files that prove the pattern.
- Common mistakes or anti-patterns.
- Verification commands or checks when they are specific and reliable.

Avoid:

- Placeholder prose.
- Generic framework advice.
- Tool instructions that only work in one agent host.
- Long copied code blocks.
- Rules based on a single accidental implementation detail.

## Example Shape

```markdown
## Session file naming

Session files live at `.myflow/.runtime/sessions/<contextKey>.json`. The local
pattern is:

- The context key is `pi_<sanitized session id>`.
- `task.py` and `get_context.py` derive the same key from `MYFLOW_CONTEXT_ID`
  or `PI_SESSION_ID`.
- `create` sets the pointer when none exists yet, and `start` sets it; `finish`
  and `archive` clear it.

Reference files:
- `.pi/extensions/myflow/turn-cache.ts`
- `.myflow/scripts/task.py`
- `tests/task-bridge.test.ts`

Avoid inventing a second naming scheme for session files.
```

## Final Pass

Before finishing:

```bash
grep -RIn "To be filled\|TODO: fill\|placeholder\|<package>\|<layer>" .myflow/spec
python3 .myflow/scripts/worktree.py verify
```

Also check links, `index.md` files, and whether any spec still describes a
template rather than this repository.
