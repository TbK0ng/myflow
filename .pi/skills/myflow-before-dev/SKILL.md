---
name: myflow-before-dev
description: "Load this project's coding guidelines from .myflow/spec/ before writing code. Reads the spec index, the touched area's Pre-Development Checklist, and shared thinking guides when the tree exists. Use when starting implementation, switching areas of the codebase, or refreshing project conventions before the first edit."
---

# Before Development

Load the project's coding guidelines **before the first edit** — when the
project has recorded any.

## Step 1: Is There A Spec Tree?

```bash
cat .myflow/spec/index.md 2>/dev/null || echo "NO_SPEC"
```

- **`NO_SPEC`**: this project has not recorded conventions yet. Say so in one
  line, mention that `myflow-spec-bootstrap` (whole tree) or
  `myflow-update-spec` (first entry) can create it, then continue with the
  generic checklist in Step 3. A missing spec tree is not a reason to stop, and
  never a reason to invent conventions.
- **Content printed**: continue to step 2.

## Step 2: Read The Relevant Spec

```bash
cat .myflow/spec/index.md
cat .myflow/spec/guides/index.md
cat .myflow/spec/<area>/index.md    # the area you are touching (e.g. harness/)
```

If several areas apply, read each. If none fits, use the closest area the spec
tree lists.

## Step 3: Work The Checklist

Work the **Pre-Development Checklist** in the area index: it is the readiness
pass for the change you are about to make. The load-bearing contracts it points
at (context key, statuses, hook set, config keys) are spelled out in that
index's **Contracts** section, and the copies that must move with them are
listed in its **Quality Check**.

When there is no spec tree, use this generic checklist instead:

- [ ] Which contract or public behavior does this change touch, and which files
  mirror it?
- [ ] Can the change be tested without network, model, or installed
  dependencies?
- [ ] Which instruction file (skill, prompt, `workflow.md`) must change with it?
- [ ] Is there an existing helper for this instead of new code?

## Step 4: Read The Referenced Files

Read the guideline files the checklist points to. The index is a pointer, not
the goal — the actual rules are in the files it names.

## Step 5: Implement

Rules:

- Mandatory whenever a spec tree exists, even for small changes. "Looks small"
  is how contract drift starts.
- Specs are authoritative over memory. If the spec disagrees with the code, fix
  whichever is wrong before continuing, and say which one you changed.
- If the spec is silent on a decision you had to make, capture it with
  `myflow-update-spec` when you finish.
