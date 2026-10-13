# myflow Workflow

Single source of truth for how work moves forward. The per-turn
`[workflow-state:STATUS]` blocks at the bottom are injected verbatim by the
extension; everything above is orientation for the model and the human.

## Phase Index

```
Phase 1: Plan    → clarify before code: prd.md, optional research, curated jsonl
Phase 2: Execute → implement only when status is in_progress, then check
Phase 3: Finish  → verify, capture spec, commit, archive
```

| Step | Name | Rule |
| --- | --- | --- |
| 1.1 | Requirement exploration | `[required · once]` `myflow-brainstorm` → `prd.md` (complex work also `design.md` + `implement.md`) |
| 1.2 | Research | `[optional · repeatable]` `myflow_subagent` with `myflow-research` → `research/<topic>.md` |
| 1.3 | Configure context | `[required · once]` curate `implement.jsonl` / `check.jsonl` (sub-agent platforms) |
| 1.4 | Activate | `[required · once]` review gate, then `task.py start` → status `in_progress` |
| 2.1 | Implement | `[required · repeatable]` `myflow_subagent` with `myflow-implement` |
| 2.2 | Check | `[required · repeatable]` `myflow-check`; fix findings |
| 2.3 | Rollback | `[on demand]` revert and re-plan |
| 3.1 | Spec update | `[required]` capture new contracts with `myflow-update-spec` |
| 3.2 | Commit | `[required · once]` working tree clean after this |
| 3.3 | Finish | `[required · once]` `/myflow-finish-work` → `task.py archive` |

Rules: run steps in order; a `[once]` step is already done if its output exists
(`prd.md`, curated `implement.jsonl`); going back a phase is allowed when new
information requires it. `/myflow-status` shows task, phase, and git state
without a model call.

## Routing

| Intent | Use |
| --- | --- |
| Requirements unclear / new feature | `myflow-brainstorm` skill |
| Before writing code | `myflow-before-dev` skill |
| Implementation | `myflow_subagent` → `myflow-implement` |
| Verification after code changes | `myflow_subagent` → `myflow-check` (or `myflow-check` skill) |
| Preserve a lesson or contract | `myflow-update-spec` skill |
| Discuss with a peer agent / spawn a worker | `myflow-channel` skill (`channel.py`) |
| Bootstrap or refresh specs from the codebase | `myflow-spec-bootstrap` skill |
| After fixing a bug | `myflow-break-loop` skill |
| Resume a task | `/myflow-continue` |
| Wrap up a task | `/myflow-finish-work` |
| Work on a second task in parallel | `/myflow-parallel` (`worktree.py`) |

## Task Artifacts

- `prd.md` — requirements, constraints, acceptance criteria.
- `design.md` / `implement.md` — technical design and ordered execution plan for complex work.
- `implement.jsonl` / `check.jsonl` — the spec and research files injected into sub-agents.
- `research/<topic>.md` — persisted research findings.

`tasks/` and `archive/` are deliverables and are committed with the code they
describe. `.myflow/.runtime/` (sessions, worktree registry, worker logs) is
machine state: put it in `.gitignore`, never commit it.

## Dispatch Protocol

- Only the main session may dispatch `myflow_subagent`. Sub-agent definitions
  omit the tool from their allowlist, and `tool_call` blocks the call as a
  second line of defense; a sub-agent must report its recommendation instead.
- Sub-agents run in the caller's directory and share one working tree; nothing
  creates git worktrees. Parallel dispatch is for read-only work
  (`myflow-research`); run writing agents one at a time. Independent *tasks*
  run in isolated worktrees through `/myflow-parallel`.
- A `myflow-check` sub-agent is held until `verify:` commands in
  `.myflow/worktree.yaml` pass, so a checked change is a verified change. A
  channel `reviewer` worker is held the same way (its launcher sets
  `MYFLOW_VERIFY_GATE`), so a peer review cannot skip the gate.
- Every dispatch prompt starts with `Active task: <path from task.py current>`.
- Read order inside a sub-agent: `implement.jsonl` / `check.jsonl` referenced
  files → `prd.md` → `design.md` if present → `implement.md` if present.

## Escape Hatch

Include the skip keyword (default `no-myflow`, configurable in
`.myflow/config.yaml` under `prompt_injection.skip_keyword`) to suppress the
per-turn breadcrumb for that turn. `session-context` and `task-context` are
still injected.

[workflow-state:no_task]
No active task. First classify the current turn and ask for task-creation consent before creating any myflow task.
Simple conversation / small task: ask only whether this turn should create a myflow task. If the user says no, skip myflow for this session.
Complex task: ask the user if you can create a myflow task and enter the planning phase. If the user says no, explain, clarify scope, or suggest a smaller split.
[/workflow-state:no_task]

[workflow-state:planning]
Load `myflow-brainstorm`; stay in planning.
Lightweight: `prd.md` can be enough. Complex: finish `prd.md`, `design.md`, and `implement.md`; ask for review before `task.py start`.
Multi-deliverable scope: consider a parent task plus independently verifiable child tasks; dependencies must be written in child artifacts, not implied by tree position.
Sub-agent mode: curate `implement.jsonl` and `check.jsonl` as spec/research manifests before start.
[/workflow-state:planning]

[workflow-state:in_progress]
Tools: `myflow-implement` / `myflow-check` / `myflow-research` are sub-agent types dispatched with `myflow_subagent` (not skills). `myflow-before-dev`, `myflow-check`, `myflow-update-spec`, and `myflow-break-loop` are skills.
Flow: `myflow-implement` -> `myflow-check` -> `myflow-update-spec` -> commit (3.2) -> `/myflow-finish-work`.
Main-session default: dispatch implement/check sub-agents. Sub-agent self-exemption: if already running as `myflow-implement`, do NOT dispatch another `myflow-implement` or `myflow-check`; if already running as `myflow-check`, do NOT dispatch another `myflow-check` or `myflow-implement`. Dispatch is main session only.
Dispatch prompt starts with `Active task: <task path from task.py current>`. Read context: jsonl entries -> `prd.md` -> `design.md if present` -> `implement.md if present`.
[/workflow-state:in_progress]

[workflow-state:completed]
Code committed. Run `/myflow-finish-work` to verify, capture spec, and archive; if dirty, return to step 3.2 first.
[/workflow-state:completed]
