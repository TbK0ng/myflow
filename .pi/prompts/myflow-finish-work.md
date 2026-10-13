---
description: Finish the current task — verify, update spec, commit, archive
---

Finish the current task.

## Step 1: Load Current Context

```bash
python3 ./.myflow/scripts/task.py current --source
python3 ./.myflow/scripts/get_context.py
```

Confirm you are finishing the task you think you are, and note the dirty files.

## Step 2: Verify

```bash
node --test tests/
```

Then run any check the change affects:

```bash
python3 ./.myflow/scripts/get_context.py
python3 ./.myflow/scripts/task.py current --source
```

Fix failures before continuing. Do not commit on a red test run.

## Step 3: Update Spec

If the work changed a contract, convention, or non-obvious behavior, capture it
with the `myflow-update-spec` skill (`.myflow/spec/`). If a file in
`.myflow/spec/` or `.myflow/workflow.md` now describes something untrue, fix it
now.

## Step 4: Commit

Review the diff, then commit with a message that says what changed and why.
The working tree must be clean after this step.

## Step 5: Archive

```bash
python3 ./.myflow/scripts/task.py archive .myflow/tasks/<slug>
```

This rewrites `task.json` to `completed`, moves the task to
`.myflow/archive/<YYYY-MM>/`, and clears any session pointer that still
reference it. If the task should stay active, stop here instead.

## Step 6: Report

Report the work done, files changed, verification results, and the archive
path. If anything was skipped (for example, no spec update because nothing
contractual changed), say so explicitly.
