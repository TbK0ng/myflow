# myflow workflow states

These workflow-state blocks are the single source of truth for what each phase does.
The extension parses them and injects the block matching the current task state.

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
Tools: `myflow-implement` / `myflow-research` are sub-agent types only (`myflow_subagent` tool, NOT Skill; there is no skill by these names). `myflow-update-spec` is a skill. `myflow-check` exists as both; prefer the Agent form when verifying after code changes.
Flow: `myflow-implement` -> `myflow-check` -> `myflow-update-spec` -> commit (Phase 3.4) -> `/myflow-finish-work`.
Main-session default: dispatch implement/check sub-agents. Sub-agent self-exemption: if already running as `myflow-implement`, do NOT spawn another `myflow-implement` or `myflow-check`; if already running as `myflow-check`, do NOT spawn another `myflow-check` or `myflow-implement`. Dispatch is main session only.
Dispatch prompt starts with `Active task: <task path from task.py current>`. Read context: jsonl entries -> `prd.md` -> `design.md if present` -> `implement.md if present`.
[/workflow-state:in_progress]

[workflow-state:completed]
Code committed. Run `/myflow-finish-work`; if dirty, return to Phase 3.4 first.
[/workflow-state:completed]
