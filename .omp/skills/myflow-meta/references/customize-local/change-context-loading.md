# Change Local Context Loading

Context loading determines when AI reads workflow, task, spec, research, workspace, and git status. Read this page when the user says "AI does not know the current task," "the agent did not read specs," or "there is too much/too little context."

## Read These Files First

1. `.myflow/workflow.md`
2. `.myflow/scripts/get_context.py`
3. `.myflow/scripts/common/session_context.py`
4. `.myflow/scripts/common/task_context.py`
5. `.myflow/scripts/common/active_task.py`
6. Current platform hooks or agent files
7. The current task's `implement.jsonl` / `check.jsonl`

## Context Sources

| Source | Purpose |
| --- | --- |
| `.myflow/workflow.md` | Workflow and next-action hints. |
| `.myflow/tasks/<task>/prd.md` | Current task requirements. |
| `.myflow/tasks/<task>/implement.jsonl` | Spec/research to read before implementation. |
| `.myflow/tasks/<task>/check.jsonl` | Spec/research to read during checking. |
| `.myflow/spec/` | Project specs. |
| `.myflow/workspace/` | Session records. |
| git status | Current working tree changes. |

## Common Needs And Edit Points

| Need | Edit point |
| --- | --- |
| Inject more/less information in new sessions | `session_context.py` or the platform `session-start` hook. |
| Change hints on each user input | `[workflow-state:STATUS]` block in `.myflow/workflow.md`. The `inject-workflow-state` hook is parser-only and reads the block verbatim. |
| Agent did not read specs | Task JSONL, agent prelude, `inject-subagent-context` hook. |
| Active task is lost | `active_task.py` and platform session identity propagation. |
| Change JSONL validation rules | `task_context.py`. |

## JSONL Rules

`implement.jsonl` / `check.jsonl` are the key context loading interface:

```jsonl
{"file": ".myflow/spec/backend/index.md", "reason": "Backend conventions"}
{"file": ".myflow/tasks/04-28-x/research/api.md", "reason": "API research"}
```

Include only spec/research files. Do not put code files that will be modified into these manifests; agents read code files themselves during implementation.

## Change Session Context

If the user wants every new session to see more project state, edit:

- `.myflow/scripts/common/session_context.py`
- the corresponding platform `session-start` hook

Context cannot grow without bound. Prefer injecting indexes and paths so the AI can read detailed files on demand.

## Change Sub-Agent Context

First determine which mode the platform uses:

- hook push: edit the `inject-subagent-context` hook.
- agent pull: edit the read steps in the corresponding `myflow-implement` / `myflow-check` agent file.

In both modes, make sure the agent ultimately reads:

1. active task
2. `prd.md`
3. `info.md` if present
4. the corresponding JSONL
5. spec/research referenced by the JSONL

## Troubleshooting Order

```bash
python3 ./.myflow/scripts/task.py current --source
python3 ./.myflow/scripts/task.py list-context <task>
python3 ./.myflow/scripts/task.py validate <task>
python3 ./.myflow/scripts/get_context.py --mode packages
```

Confirm the task and JSONL are correct before editing hooks/agents.
