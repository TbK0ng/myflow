# Local Task System

The myflow task system is stored entirely under `.myflow/tasks/` in the user project. Each task is a directory containing requirements, context, research, state, and relationship information.

## Task Directory Structure

```text
.myflow/tasks/
├── 04-28-example-task/
│   ├── task.json
│   ├── prd.md
│   ├── info.md
│   ├── implement.jsonl
│   ├── check.jsonl
│   └── research/
└── archive/
    └── 2026-04/
```

| File | Purpose |
| --- | --- |
| `task.json` | Task metadata: status, assignee, priority, branch, parent/child tasks, and similar fields. |
| `prd.md` | Requirements document; the most important business context during implementation. |
| `info.md` | Optional technical design. |
| `implement.jsonl` | List of spec/research files the implement agent must read first. |
| `check.jsonl` | List of spec/research files the check agent must read first. |
| `research/` | Research artifacts. Complex findings should not live only in chat. |

## `task.json`

`task.json` records task status and metadata. Common fields:

| Field | Meaning |
| --- | --- |
| `id` / `name` / `title` | Task identity and title. |
| `status` | Status such as `planning`, `in_progress`, `review`, or `completed`. |
| `priority` | `P0`, `P1`, `P2`, `P3`. |
| `creator` / `assignee` | Creator and assignee. |
| `package` | Target package in a monorepo; may be empty. |
| `branch` / `base_branch` | Working branch and PR target branch. |
| `children` / `parent` | Parent/child task relationships. |
| `commit` / `pr_url` | Commit and PR information after completion. |
| `meta` | Extension fields. |

The AI should not treat phase numbers as task status. Task progress is mainly determined by `status`, `prd.md`, whether JSONL context is configured, and the phase descriptions in `workflow.md`.

## Active Task

The user sees a "current task," but myflow stores active task state per session.

```text
.myflow/.runtime/sessions/<context-key>.json
```

`task.py start` writes the task path into the runtime session file for the current session. `task.py current --source` shows the current task and where it came from. Different AI windows can point to different tasks without overwriting each other.

If the platform or shell environment has no stable session identity, `task.py start` may be unable to set the active task. The AI should read the error, inspect the platform hook/session environment, and not fall back to a shared global pointer.

## JSONL Context

`implement.jsonl` and `check.jsonl` are context manifests for sub-agents to read first.

Format:

```jsonl
{"file": ".myflow/spec/cli/backend/index.md", "reason": "Backend conventions"}
{"file": ".myflow/tasks/04-28-example/research/api.md", "reason": "API research"}
```

Rules:

- Include spec and research files.
- Do not include code files that are about to be modified.
- Do not treat temporary conclusions in chat as the only context.
- Rows without a `file` field are skipped by readers. Legacy `{"_example": ...}` placeholder rows are rejected by `task.py validate` — delete them.

## Common Commands

```bash
python3 ./.myflow/scripts/task.py create "<title>" --description "<one-line summary>" --slug <slug>
python3 ./.myflow/scripts/task.py start <task>
python3 ./.myflow/scripts/task.py current --source
python3 ./.myflow/scripts/task.py add-context <task> implement <file> <reason>
python3 ./.myflow/scripts/task.py validate <task>
python3 ./.myflow/scripts/task.py finish
python3 ./.myflow/scripts/task.py archive <task>
```

When modifying the task system, the AI should prefer script commands to maintain structure. Edit JSON/Markdown directly only when scripts do not cover the need.

## Local Customization Points

| Need | Edit location |
| --- | --- |
| Change the default task template | `.myflow/scripts/common/task_store.py` and task creation instructions. |
| Change status semantics | `.myflow/workflow.md`, workflow-state hook logic, and task usage conventions. |
| Add task lifecycle actions | `hooks.after_*` in `.myflow/config.yaml`. |
| Change context rules | Phase 1.3 in `.myflow/workflow.md` and related platform agent/hook instructions. |
| Change archive policy | `.myflow/scripts/common/task_store.py` / `task_utils.py`. |

These are local files in the user project. Do not default to editing myflow CLI source code unless the user wants to contribute to the distribution.
