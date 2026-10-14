---
description: Resume work on the current task at the right workflow phase
---

Resume work on the current task. Load state from files — do not reconstruct the
workflow from memory.

## Step 1: Load Current Context

```bash
python3 ./.myflow/scripts/get_context.py
python3 ./.myflow/scripts/task.py current --source
```

This shows the workflow-state blocks, the active task (`path / status / title`)
and where the pointer came from, plus git branch and recent commits.

If there is no active task, decide with the user whether this turn should
create one (Phase 1.0), then load `myflow-brainstorm`.

## Step 2: Read The Phase Index

```bash
cat .myflow/workflow.md
```

The Phase Index at the top lists the numbered steps. Route by `status` +
artifact presence:

| `status` | Artifacts | Resume at |
| --- | --- | --- |
| `planning` | no `prd.md` | **1.1** requirements (`myflow-brainstorm`) |
| `planning` | `prd.md`, `implement.jsonl` not curated | **1.3** curate context |
| `planning` | `prd.md`, `implement.jsonl` curated | **1.4** review, approve the plan (`myflow_request_approval` / `task.py approve`), then `task.py start` |
| `in_progress` | implementation not started | **2.1** implement |
| `in_progress` | implementation done, not checked | **2.2** check |
| `in_progress` | check passed | **3.1** spec update |
| `completed` / `done` | still in `tasks/` | **3.3** finish and archive |

Phase rules:

1. Run steps in order within a phase; required steps are not skipped.
2. Steps marked `[once]` are done if their output exists (e.g. `prd.md`,
   curated `implement.jsonl`) — skip them.
3. Going back a phase is allowed when new information requires it.
4. `task.py start` also refuses until the plan is approved: `approval.json` must
   match the current plan hash and at least one choice question must have been
   answered (`myflow_ask_user`). Editing a plan file after approval makes it
   stale — re-run `myflow_request_approval` (or `task.py approve`).

## Step 3: Load The Guidance For That Step

Load exactly what the step names:

| Step | Load |
| --- | --- |
| 1.1 | `myflow-brainstorm` skill |
| 1.3 / 2.1 / 2.2 | `myflow_subagent` with `myflow-implement` / `myflow-check` |
| before any implementation | `myflow-before-dev` skill (`myflow-implement` does this itself) |
| 3.1 | `myflow-update-spec` skill |
| after a bug fix | `myflow-break-loop` skill |

## Step 4: Continue

Follow the loaded guidance, then re-check the Phase Index for the next step.
Run `/myflow-status` at any time for a one-line view of task, phase, and git
state.

---

Full workflow, routing, and required-step rules live in `.myflow/workflow.md`.
This command is only an entry point.
