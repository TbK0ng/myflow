---
name: myflow-before-dev
description: "Load this project's coding guidelines from .myflow/spec/ before writing code. Reads the spec index, the harness Pre-Development Checklist, and shared thinking guides. Use when starting implementation, switching areas of the codebase, or refreshing project conventions before the first edit."
---

# Before Development

Read the project's coding guidelines **before the first edit**.

## Steps

1. **Read the spec entry point**:

   ```bash
   cat .myflow/spec/index.md
   cat .myflow/spec/guides/index.md
   ```

2. **Pick the area you are touching.** Read its index:

   ```bash
   cat .myflow/spec/harness/index.md        # this repository
   cat .myflow/spec/<area>/index.md         # if another area exists
   ```

   If several areas apply, read each. If none fits, use `harness/`.

3. **Work the Pre-Development Checklist** in that index. It names the
   load-bearing contracts (context key, statuses, hook set, config keys) that
   must stay consistent across files.

4. **Read the guideline files the checklist points to.** The index is a
   pointer, not the goal — the actual rules are in the files it names.

5. **Only then start implementing.**

## Rules

- This step is mandatory even for small changes: "looks small" is how contract
  drift starts.
- Specs are authoritative over memory. If the spec disagrees with the code,
  fix whichever is wrong before continuing, and say which one you changed.
- If the spec is silent on something you had to decide, capture the decision
  with `myflow-update-spec` when you finish.
