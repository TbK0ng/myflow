# Add Project-Local Conventions

Often the user does not need to change myflow mechanics; they need local AI to understand their team's conventions. In that case, prefer `.myflow/spec/` or a project-local skill instead of editing `myflow-meta`.

## Where To Put Things

| Content type | Location |
| --- | --- |
| Rules code must follow | `.myflow/spec/<layer>/` |
| Cross-layer thinking methods | `.myflow/spec/guides/` |
| AI capability for a project-specific flow | Platform-local skill |
| One-off task material | `.myflow/tasks/<task>/` |
| Session summary | `.myflow/workspace/<developer>/journal-N.md` |

## Create A Project-Local Skill

If the user wants AI to know "how this project customizes myflow," create a local skill:

```text
.claude/skills/myflow-local/
└── SKILL.md
```

Example:

```md
---
name: myflow-local
description: "Project-local myflow customizations for this repository. Use when changing this project's myflow workflow, hooks, local agents, or team-specific conventions."
---

# myflow Local

## Local Scope

This skill documents this repository's myflow customizations only.

## Custom Workflow Rules

- ...

## Local Hook Changes

- ...

## Local Agent Changes

- ...
```

For multi-platform projects, place equivalent versions in other platform skill directories, or use `.agents/skills/` for platforms that support the shared layer.

## Write To `.myflow/spec/`

If the content is a coding convention, write it to spec. Examples:

```text
.myflow/spec/backend/error-handling.md
.myflow/spec/frontend/components.md
.myflow/spec/guides/cross-platform-thinking-guide.md
```

After writing it, update the corresponding `index.md` so AI can find the new rule from the entry point.

## Make The Current Task Use New Conventions

After writing a spec, add it to the current task context:

```bash
python3 ./.myflow/scripts/task.py add-context <task> implement ".myflow/spec/backend/error-handling.md" "Error handling conventions"
python3 ./.myflow/scripts/task.py add-context <task> check ".myflow/spec/backend/error-handling.md" "Review error handling"
```

## Do Not Store Project-Private Rules In `myflow-meta`

`myflow-meta` is a public skill for understanding myflow architecture and local customization entry points. Put project-private content in:

- `.myflow/spec/`
- a project-local skill
- the current task
- workspace journal

This prevents future updates to myflow's built-in `myflow-meta` from overwriting the team's own conventions.
