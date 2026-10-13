# Spec Task Planning

Use a single agent as the default execution model. The agent may create myflow
tasks for traceability, but this skill must not require a parallel worker
model.

## Decomposition

Create spec work units around real ownership boundaries:

- One package when a package has its own conventions.
- One layer when the same package has distinct frontend, backend, CLI, worker,
  or shared-library rules.
- One cross-cutting guide when a pattern spans packages and is not owned by one
  layer.

Avoid artificial decomposition. A small library usually needs one focused spec
pass, not several tasks. This repository, for example, has exactly one area
(`harness/`).

## Task Shape

When a myflow task is useful, create it and write a concise PRD:

```bash
python3 ./.myflow/scripts/task.py create "Fill <area> myflow specs" --slug spec-<area>
```

```markdown
# Fill <package-or-layer> myflow Specs

## Goal
Write project-specific `.myflow/spec/` guidance for <scope>.

## Scope
- Spec directory:
- Source directories to inspect:
- Tests to inspect:
- Out of scope:

## Architecture Context
Summarize the concrete findings from repository analysis.

## Files To Create Or Update
- `.myflow/spec/index.md`
- `.myflow/spec/<area>/index.md`
- `.myflow/spec/<area>/<topic>.md`

## Rules
- Adapt the spec file set to the real codebase.
- Use real source examples with file paths.
- Remove template-only sections that do not apply.
- Do not modify product source code unless the task explicitly asks for it.

## Acceptance Criteria
- [ ] Specs contain concrete examples and anti-patterns from the repository.
- [ ] No placeholder text remains.
- [ ] Index files match the final spec files.
- [ ] Claims are backed by source files, tests, or project docs.
```

## Optional Helper Agents

Helpers are optional. The main agent still owns integration and final quality.
In this harness, helpers are dispatched with `myflow_subagent` (`single`, or
`parallel` prompts for independent scopes). Their tasks must have clear
ownership:

- Read-only research tasks may inspect any source needed for the assigned scope.
- Write tasks must own disjoint spec directories.
- Verification tasks check placeholder removal, broken links, and consistency.

Put only the required work and acceptance criteria in a helper task; the agent
already knows how to read and report.

## Sequencing

```
analyze (codebase-memory + source reads)
  → decide spec boundaries
  → write/reshape spec files
  → verify (placeholders, links, index)
  → task.py archive when done
```
