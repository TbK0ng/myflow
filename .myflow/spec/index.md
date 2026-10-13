# myflow Project Spec

`.myflow/spec/` is this project's coding-convention store. It is a plain
directory that agents read directly.

There is intentionally **no** `get_context.py --mode packages`, no spec
registry, and no refresh/conflict machinery — those exist to serve
many packages across many projects. Here, `index.md` files are the entry
points and everything is hand-maintained.

## Layout

```
.myflow/spec/
├── index.md          # this file: what specs exist and how to use them
├── harness/
│   └── index.md      # this repository's coding conventions + checklists
└── guides/
    └── index.md      # cross-cutting thinking checklists (not coding rules)
```

Add a new `<area>/index.md` directory when a distinct area of the codebase
grows conventions that do not belong in `harness/`.

## How To Use

1. Before writing code, read this file, then the `index.md` for the area you
   are touching.
2. Follow that area's **Pre-Development Checklist** before the first edit.
3. Before finishing, run that area's **Quality Check** and the project checks
   in `harness/index.md`.

## How To Grow

- One convention per section. Concrete rules with a short example beat prose.
- Record the *why* (what mistake it prevents), not just the *what*.
- Point at real files instead of describing them from memory.
- If a rule is only a question to ask yourself, it belongs in `guides/`, not
  in a coding spec.

## What Does NOT Belong Here

- Task state and PRDs → `.myflow/tasks/<task>/`
- Workflow phases, routing, and per-turn state blocks → `.myflow/workflow.md`
- One-off investigation notes → the task's `research/` directory
- Secrets, credentials, or machine-specific absolute paths
