# Thinking Guides

`.myflow/spec/guides/` is the cross-cutting layer of the spec tree. An area
index states what the code must do; a guide states how to decide what is true
before changing it. The index is part of every spec tree.

## Guides

| Guide | Use when |
| --- | --- |
| [doc-drift-thinking-guide.md](doc-drift-thinking-guide.md) | A sentence in a skill, spec, or changelog names a path, a subcommand, a count, a config key, or a default, and you are about to trust it |

## Triggers From This Repository

- **A document states a number.** How many hooks register, how many `task.py`
  subcommands the workflow calls, how many files mirror one contract. Counts
  drift silently because nothing fails when they do: find the canonical copy
  before editing any of them.
- **Two files restate one rule.** The dispatch contract appears in
  `.myflow/workflow.md`, `harness-conventions.md`, and a skill. Before editing
  one, list the others.
- **A file the docs name is missing.** Decide whether the doc is stale or the
  file was dropped by a rewrite, before deleting the reference or restoring the
  file. `guides/` itself was dropped by a rewrite of `spec/index.md`, and the
  three skills still naming it were the correct ones.
