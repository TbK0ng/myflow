---
name: myflow-check
description: "Comprehensive quality verification: project checks, spec compliance, cross-file contract consistency, test coverage, and reuse. Use when code is written and needs verification, before committing, or to catch context drift during long sessions."
---

# Code Quality Check

Verify recently written code before it is committed.

## Step 1: Identify What Changed

```bash
git status
git diff --stat
git diff
```

List each changed file and what it is responsible for.

## Step 2: Check Against The Spec (When One Exists)

```bash
cat .myflow/spec/index.md 2>/dev/null || echo "NO_SPEC"
```

- **Spec tree present**: read the `index.md` for the area you touched and
  follow its **Quality Check** section. If the change touches a load-bearing
  contract (context key, task statuses, hook set, `workflow.md` blocks, config
  keys), verify every file that mirrors it — not just the one you edited.
- **`NO_SPEC`**: say "no spec tree" and continue to Step 3. Do not invent
  conventions; if the change established one, note that `myflow-update-spec`
  can record it.

## Step 3: Run Project Checks

```bash
node --test tests/
```

Fix every failure before continuing. Also re-run any command the change
affects, for example:

```bash
python3 .myflow/scripts/get_context.py
python3 .myflow/scripts/task.py current --source
```

## Step 4: Review Against The Checklist

### Correctness

- [ ] Behavior matches the PRD / task requirements.
- [ ] No regression in the six extension hooks or `myflow_subagent`.
- [ ] Error paths fail loudly instead of returning misleading output.

### Contracts

- [ ] Context-key derivation matches between extension, `get_context.py`, and `task.py`.
- [ ] `workflow.md` state blocks still parse (matching open/close STATUS).
- [ ] `.myflow/spec/` and `workflow.md` describe only things that exist.

### Tests

- [ ] New behavior has a test that fails when reverted.
- [ ] Bug fix has a regression test.
- [ ] Changed behavior updated the existing tests that pinned the old behavior.
- [ ] Tests need no network, model, or installed dependencies.

### Hygiene

- [ ] No debug output left in.
- [ ] No suppressed errors or cast-through-`any` escapes without a comment.
- [ ] No duplicated constant that should be shared.

## Step 5: Cross-File Dimensions

Skip what does not apply.

### Data Flow (change touches 3+ files)

- [ ] Producer and every consumer updated together.
- [ ] Types/shapes passed across the boundary unchanged.
- [ ] Errors propagate instead of being swallowed.

### Reuse

- [ ] Searched for an existing helper before adding one (`src/`, extension).
- [ ] Two definitions of the same value collapsed into one place.

### Instruction Files

- [ ] Skills/prompts/`workflow.md` that describe the changed behavior updated.

## Step 6: Report And Fix

Report what you found and fix it directly. Re-run the project checks after the
fixes. If no issues remain, say so explicitly.
