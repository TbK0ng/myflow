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
| 1.1 | Requirement exploration | `[required · once]` `myflow-brainstorm`; ask choice questions with `myflow_ask_user` → `prd.md` (complex work also `design.md` + `implement.md`) |
| 1.2 | Research | `[optional · repeatable]` `myflow_subagent` with `myflow-research` → `research/<topic>.md` |
| 1.3 | Configure context | `[required · once]` curate `implement.jsonl` / `check.jsonl` with `task.py add-context`; a seeded-but-empty manifest blocks `start` |
| 1.4 | Activate | `[required · once]` review gate, then approve the plan (`myflow_request_approval`, or `task.py approve`), then `task.py start` → status `in_progress` |
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
| Long-running command / dev server / watch (must outlive the session) | `myflow_bg_start` (+ `myflow_bg_output` / `myflow_bg_list` / `myflow_bg_stop`) |
| Read or stop a command you started in the background | `myflow_bg_output`, `myflow_bg_list`, `myflow_bg_stop` |
| Watch or manage dispatched runs and background tasks | `/mysubagents` — `board` is read-only, `tree` and `background` can stop, steer, rerun and cancel a group |
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
- `questions.jsonl` — append-only audit of the choice questions asked with
  `myflow_ask_user`. Only a row with `via: "ui-select"` and a non-empty answer
  counts as "the user was asked".
- `approval.json` — the user's approval of one plan revision, written by
  `myflow_request_approval` (TUI) or `task.py approve` (human CLI). It is a
  cross-language contract that `task.py start` reads, so the model must not
  hand-write it; deleting the file revokes the approval.

`tasks/` and `archive/` are deliverables and are committed with the code they
describe. `.myflow/.runtime/` (sessions, worktree registry, worker logs) is
machine state: put it in `.gitignore`, never commit it.

## Dispatch Protocol

- Only the main session may dispatch `myflow_subagent`. Sub-agent definitions
  omit the tool from their allowlist, and `tool_call` blocks the call as a
  second line of defense; a sub-agent must report its recommendation instead.
- The same guard covers `myflow_ask_user` and `myflow_request_approval`: only
  the main session may ask the user or record approval, their agent allowlists
  omit them, and `tool_call` blocks them as a second line of defense.
- Sub-agents run in the caller's directory and share one working tree; nothing
  creates git worktrees. **At most one unbounded writer per working tree at a
  time**: `myflow_subagent` rejects `mode: parallel` for any agent whose tools
  include `write`/`edit` (or that declares no allowlist) unless it declares a
  `writesUnder: <dir>` scope, so `myflow-implement` and `myflow-check` run one
  at a time — repeats are sequential. An agent that declares `writesUnder`
  (`myflow-research` -> `research/`) may run in parallel, because the child
  blocks every `write`/`edit` outside `<active task>/<dir>/` and the agent
  writes one topic per file. That is a **boundary** guarantee (it shrinks the
  blast radius), not a mutual-exclusion guarantee. Independent *tasks* run in
  isolated worktrees through `/myflow-parallel`.
- A `myflow-check` sub-agent is held until `verify:` commands in
  `.myflow/worktree.yaml` pass, so a checked change is a verified change. A
  channel `reviewer` worker is held the same way (its launcher sets
  `MYFLOW_VERIFY_GATE`), so a peer review cannot skip the gate.
- Every dispatch prompt starts with `Active task: <path from task.py current>`.
- Every dispatch is capped (`timeoutMs`, default 15 minutes, `0` disables it) and
  logs its raw stream under `.myflow/.runtime/subagent-logs/`. A run that hits the
  cap is stopped, reported with its log path, and leaves its changes in the tree —
  nothing is reverted, so re-dispatch a bounded next step instead of redoing it.
- Injected read order inside a sub-agent: `prd.md` → `design.md` if present →
  `implement.md` if present → `info.md` → `implement.jsonl` / `check.jsonl`
  referenced files. The extension materializes each into `<task-context>` —
  artifacts bounded by the per-artifact byte budget, jsonl files by
  `max_file_bytes` — so they are read, not merely named; a missing artifact is
  skipped silently.

## Escape Hatch

Include the skip keyword (default `no-myflow`) to suppress the per-turn
breadcrumb for that turn. `session-context` and `task-context` are
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
Sub-agent mode: curate `implement.jsonl` and `check.jsonl` with `task.py add-context <task> <implement|check> <path> "<why>"` before `task.py start`.
Seeded-but-empty guard: `task.py start` refuses a task whose manifest was seeded by `create` but has no curated entry, because its sub-agents would run with zero spec context. Curate one, or pass `--allow-empty-context` to bypass it knowingly.
Approval gate: ask at least one choice question with `myflow_ask_user` (2-4 options), write the plan, then call `myflow_request_approval`. `task.py start` refuses the task until an `approval.json` matches the current plan hash and at least one choice question was answered; editing a plan file after approval makes it stale. A no-UI session returns instructions instead - never fabricate an answer or an approval. `--allow-unapproved` skips the whole gate knowingly and records `started_without_approval` in `task.json`.
[/workflow-state:planning]

[workflow-state:in_progress]
Tools: `myflow-implement` / `myflow-check` / `myflow-research` are sub-agent types dispatched with `myflow_subagent` (not skills). `myflow-before-dev`, `myflow-check`, `myflow-update-spec`, and `myflow-break-loop` are skills.
Flow: `myflow-implement` -> `myflow-check` -> `myflow-update-spec` -> commit (3.2) -> `/myflow-finish-work`.
Main-session default: dispatch implement/check sub-agents. Sub-agent self-exemption: if already running as `myflow-implement`, do NOT dispatch another `myflow-implement` or `myflow-check`; if already running as `myflow-check`, do NOT dispatch another `myflow-check` or `myflow-implement`. Dispatch is main session only.
Dispatch prompt starts with `Active task: <task path from task.py current>`. Injected context: `prd.md` -> `design.md if present` -> `implement.md if present` -> `info.md` -> jsonl-referenced files.
[/workflow-state:in_progress]

[workflow-state:completed]
Code committed. Run `/myflow-finish-work` to verify, capture spec, and archive; if dirty, return to step 3.2 first.
[/workflow-state:completed]
