---
description: Finish the current task — verify, update spec, commit, wrap up
---

Finish the current task — verify, update spec, commit, wrap up.

## Step 1: Load Current Context

```bash
python3 ./.myflow/scripts/get_context.py
```

Confirms: current task, git state, recent commits.

## Step 2: Verify

Run the relevant lint, typecheck, and tests for the touched code.

## Step 3: Update Spec

If the implementation changed the spec, update the spec files.

## Step 4: Commit

Commit the changes with a descriptive message.

## Step 5: Wrap Up

Report the work done, files changed, and verification results.
