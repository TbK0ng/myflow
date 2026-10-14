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
- [ ] If you change the approval gate, the plan hash, or either of the two new
      tools (`myflow_ask_user` / `myflow_request_approval`), keep the
      one-implementation rule: the hash and the "answered" count live only in
      `.myflow/scripts/task.py`, and every TS caller goes through
      `task.py gate-info`.

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

### Task context gate: empty `implement.jsonl` / `check.jsonl`

- **Producer**: `.myflow/scripts/task.py create` seeds empty `implement.jsonl`
  and `check.jsonl` in every task it creates.
- **Consumers**:
  - `task.py start` — refuses a task whose manifest exists but has 0 curated
    entries, unless `--allow-empty-context` is passed. The manifest gate is a
    second line of defense after the phase-1 review gate in `workflow.md`.
  - `task.py validate <task>` — reports the same condition (and invalid rows,
    missing referenced files) with a non-zero exit.
  - `task.py add-context <task> <implement|check> <path> [reason]` — the write
    side; appends `{file, reason}` (or `{file, type:"directory", reason}` for a
    directory) and refuses a duplicated path.
- **Value/shape**: a curated entry is a JSON object line carrying a truthy
  `file` (or legacy `path`) string. `create` seeds the file **empty** — a
  placeholder `_example` row is a hard validation error, not scaffolding.
- **Invariant**: an **absent** manifest is not gated; only a seeded-but-empty
  one is. Gating absence would strand every task created before seeding landed.
- **Breaks if**: the gate reads a missing file as 0 entries; `create` stops
  seeding (the gate then never fires); or a gate ships without `add-context` as
  its write side (an unsatisfiable gate).

### Task context: what the extension injects

- **Producer**: `.pi/extensions/myflow/context-injection.ts` `buildTaskContext`.
- **Consumers**: the `<task-context>` block `myflow_subagent` injects into
  every dispatched child, and `session_before_compact` re-injects.
- **Value/shape**: task artifacts in a fixed order — `prd.md` → `design.md` →
  `implement.md` → `info.md` — each materialized as an `artifact` and bounded
  by `context_injection.max_artifact_bytes`; then the files referenced by
  `implement.jsonl` / `check.jsonl`, each bounded by `max_file_bytes`; every
  block scored against `max_total_bytes`.
- **Invariant**: `design.md` and `implement.md` get exactly the treatment
  `prd.md` does — same `max_artifact_bytes` cap, same truncation/omitted
  fallback under `max_total_bytes`. A missing artifact is skipped silently,
  never an error. `info.md` is myflow's own artifact and stays in the list.
- **Ordering caveat**: artifacts are emitted **before** the curated jsonl
  files, so under total-budget pressure the jsonl context is dropped or
  degraded first. That inversion is known and
  deliberately **not** changed here (a budget-priority
  reorder is a separate change); if it is revisited, update the Dispatch
  Protocol read order in `.myflow/workflow.md` and this entry together.
- **Breaks if**: `design.md` / `implement.md` drop out of the injection list
  (the Dispatch Protocol promises sub-agents see them), or a missing artifact
  starts emitting an error instead of being skipped.

### Plan approval gate and plan hash

- **Producers**:
  - `.pi/extensions/myflow/ask.ts` (`myflow_ask_user`) — the only writer of
    `<active task>/questions.jsonl`. It appends one row per call; a row with
    `via: "ui-select"` and a non-empty `answer` is the only thing that counts as
    "the user was asked".
  - `.pi/extensions/myflow/approval.ts` (`myflow_request_approval`) and
    `task.py approve` — the two writers of `<active task>/approval.json`, the
    user's approval of one plan revision.
- **Consumers**:
  - `task.py start` — refuses to start until a plan file exists and
    `approval.json` parses with a `plan_hash` equal to the current plan hash;
    then admits the task only when at least one choice question was answered
    (the R2 backstop).
  - `task.py gate-info` — the single read path. It returns the plan hash, the
    present plan files, and the answered-question count **together**, so no
    caller re-derives either. The TS approval tool and `/myflow-status` read
    only this.
  - `task.py validate` — reports the answered count and the approval state; it
    is a reporter, `start` is the enforcing gate.
- **Value/shape**: `approval.json` carries `plan_hash` (`sha256:<hex>`), the
  ordered list of present plan files, `approved_by` (`ui-confirm` or `cli`),
  `questions_asked`, a timestamp, and the session id. **`approved_by` is NOT a
  trustworthy field**: a hand-written file can carry either value, so it must
  never be used to distinguish a real approval from a forged one. The plan hash is computed
  by `task.py`'s `_plan_digest` over the `prd.md` / `design.md` / `implement.md`
  that exist, in that fixed order, as `filename` + NUL + raw bytes + NUL.
- **Invariant**: **exactly one plan-hash implementation**
  (`.myflow/scripts/task.py`). The TypeScript side never hashes the plan and
  never counts `questions.jsonl`; it shells out to `task.py gate-info`. Editing
  any plan file after approval makes the approval stale and re-opens the gate;
  deleting `approval.json` revokes it. The gate is a **convention reinforcement
  against forgetting to ask or approve — it is NOT a security boundary.**
- **Breaks if**: a second hash implementation or a second "answered" predicate
  appears (then one side reports "approved" while `start` refuses, with no error
  naming the root cause); `start` checks only that `approval.json` exists
  without comparing the hash; or the R2 backstop stops re-checking the answered
  count at the admitting step.
- **Honest strength (measured)**: any agent that can run `bash` can write
  `approval.json` by hand or pass `--allow-unapproved`. `task.py approve`'s
  `sys.stdin.isatty()` check does **not** stop it in this environment: Pi's bash
  tool allocates a pty, and `sys.stdin.isatty()` was measured as `True` there.
  (On Windows the check is weaker still: redirecting `< /dev/null` maps to `NUL`
  and also reports `isatty() === true`; only a **pipe** counts as non-tty.)
  A forged `approval.json` — correct `plan_hash`, `approved_by: "ui-confirm"`,
  plus a fabricated `via:"ui-select"` row — was measured to pass `start`
  outright; there is **no technical countermeasure**, only after-the-fact
  inspection.
  The gate reliably blocks *forgetting* and *skipping*; it does not stop a
  deliberate bypass. `--allow-unapproved` leaves a trace
  (`task.json.started_without_approval: true`) and prints a warning, so a
  bypass is discoverable after the fact.

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
- [ ] The approval gate's contract copies agree: `.myflow/workflow.md`, the
      `myflow-meta` harness conventions, the `myflow-brainstorm` skill, and
      `.pi/prompts/myflow-continue.md`. No copy still describes `task.py start`
      as gated only on the context manifests.
- [ ] No agent gained `bash` without revisiting the Design Decision above.
