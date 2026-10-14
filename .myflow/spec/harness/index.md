# Harness Spec

Rules for changing the myflow harness: `.pi/extensions/myflow/`, `.pi/agents/`,
`.pi/skills/`, `.myflow/scripts/`, and `.myflow/workflow.md`.

Payload tour and inventory:
`.pi/skills/myflow-meta/references/harness-conventions.md`.

## Pre-Development Checklist

- [ ] Run `node --test tests/` **from the main session**, not from inside a
      sub-agent. The suite is not hermetic w.r.t. `MYFLOW_AGENT_TYPE` /
      `MYFLOW_CONTEXT_ID`: when those leak in, ~14 unrelated tests fail because
      the extension sees itself as a sub-agent. Clear them before believing a
      failure:
      `env -u MYFLOW_AGENT_TYPE -u MYFLOW_CONTEXT_ID -u MYFLOW_SKIP_BREADCRUMB -u MYFLOW_WRITES_UNDER node --test tests/`
- [ ] Decide whether you are changing a **contract** (env key, frontmatter key,
      file format, tool schema) or only behavior inside one module. A contract
      change updates this file *and* every copy of the rule in the same change.
- [ ] If you touch dispatch, or anything that writes, read
      "Write scope: `writesUnder`" below first.

## Contracts

### Write scope: `writesUnder`

- **Producer**: `.pi/agents/<agent>.md` frontmatter — `writesUnder: <dir>`
  (relative to the active task dir), parsed in `.pi/extensions/myflow/agents.ts`.
- **Consumers**:
  - `.pi/extensions/myflow/subagent.ts` — injects the declaration as the
    `MYFLOW_WRITES_UNDER` env var into the child process, and gates
    `mode: "parallel"`.
  - `.pi/extensions/myflow/index.ts` — the child's `tool_call` handler blocks
    `write` / `edit` outside `<active task>/<writesUnder>/`.
- **Value/shape**: one relative directory path, e.g. `research`. Handed over as
  `MYFLOW_WRITES_UNDER`. Empty or absent means "no declared scope".
- **Invariant**: a sub-agent carrying `MYFLOW_WRITES_UNDER` may only write under
  `<active task>/<scope>/`. Every ambiguity blocks:
  - a blank declaration,
  - a declaration that is absolute, drive-lettered, or contains a `..` segment,
  - a `write` / `edit` input whose `path` is missing or not a string,
  - no resolvable active task.
- **Breaks if**: the containment test stops anchoring on `<dir>/` (so
  `researchX` would match `research`); `..` is not collapsed before the prefix
  comparison; or the comparison is not case-insensitive on Windows.

## Design Decisions

### Design Decision: bound the write scope, do not try to exclude writers

- Context: sub-agents share one working tree, so two concurrent writers are the
  one thing dispatch forbids. Parallel research needs each shard to persist its
  own `research/<topic>.md`.
- Options: **(A)** keep research read-only and route persistence through a
  serial writer; **(B)** give research `write` and relax the guard by agent
  capability; **(C)** give research `write` and confine each run to a declared
  directory.
- Chosen: **(C)**. The code cannot verify that parallel prompts write *disjoint*
  files, so it shrinks the blast radius to one directory and the agent contract
  requires one topic per file. This is a **boundary** guarantee, **not mutual
  exclusion** — do not describe it as a lock.
- Revisit if: a sub-agent gains `bash` (which would write around the guard), or
  dispatch grows a way to prove disjointness.

## Gotchas

> **Gotcha**: "no declaration" and "blank declaration" mean deliberately
> different things.
>
> Happens when: an agent omits `writesUnder` versus declares it empty. Handle it
> by: reading omission as "unbounded serial writer" — `myflow-implement` and
> `myflow-check` keep full-tree access — and a blank *present* value as
> fail-closed inside the child.

> **Gotcha**: the guard compares paths **lexically**, not through `realpath`.
>
> Happens when: a symlink already inside the scope points outside it. This is
> unreachable for the current agents (no `bash`, no symlink tool), but re-check
> if an agent ever gains either.

> **Gotcha**: `hasWriteScope` and `declaresWriteScope` are not interchangeable.
>
> Happens when: gating env injection on `hasWriteScope`. That would leave an
> *unsafe* scope's writes **unbounded** instead of blocked. Injection keys off
> `declaresWriteScope` (any non-blank value); only the parallel gate uses the
> stricter `hasWriteScope`.

## Quality Check

- [ ] `node --test tests/` green (from the main session, or with the `MYFLOW_*`
      env vars cleared).
- [ ] Every copy of a changed rule was updated together: the `subagent.ts` tool
      description and error text, `.myflow/workflow.md` Dispatch Protocol,
      `harness-conventions.md`, and the `myflow-meta` / `myflow-brainstorm`
      skills. A stale rule statement anywhere is a bug.
- [ ] A new refusal path has a test that fails when the guard is reverted.
- [ ] No agent gained `bash` without revisiting the Design Decision above.
