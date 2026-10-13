---
name: myflow-meta
description: "Understand and modify this repository's myflow harness for Pi: the six extension hooks, the myflow_subagent tool, the /myflow-status command, context injection and escape hatch, the task lifecycle and scripts, workflow.md state blocks, and .myflow/spec/. Use when asked to change, debug, or extend the myflow harness itself."
---

# myflow Meta

This repository **is** the myflow harness for Pi. This skill is the map for
changing it. It describes only what exists here — there is one platform (Pi),
this repository is the whole harness: one Pi extension, four scripts, the skills that drive them, and their tests.

## Layout

```
.pi/
  settings.json                     # enableSkillCommands
  extensions/myflow/index.ts        # extension factory: 6 hooks + /myflow-status
  extensions/myflow/subagent.ts     # myflow_subagent tool (single/parallel/chain)
  extensions/myflow/agents.ts       # agent discovery from .pi/agents
  extensions/myflow/status.ts       # status report builder (used by the command)
  agents/myflow-{implement,check,research}.md
  prompts/myflow-{continue,finish-work}.md
  skills/myflow-{meta,brainstorm,before-dev,check,update-spec,break-loop,spec-bootstrap}/
.myflow/
  workflow.md                       # phases, routing, per-turn state blocks
  scripts/get_context.py            # session context (workflow + task + git)
  scripts/task.py                   # task lifecycle + session pointer
  spec/                             # coding conventions (index + harness + guides)
  tasks/<slug>/                     # task.json, prd.md, info.md, *.jsonl, research/
  archive/<YYYY-MM>/<slug>/         # archived tasks
  .runtime/sessions/<key>.json      # active-task pointer per session
src/                                # pure helpers: root, state parsing, cache, injection
tests/                              # node --test
types/pi-coding-agent.d.ts          # the only Pi type surface used
```

## Runtime: the extension

`src/*.ts` holds pure logic; `.pi/extensions/myflow/` wires it to Pi. Six hooks
are always registered:

| Hook | What it does |
| --- | --- |
| `session_start` | Main session: `session-context` + `task-context`. Sub-agent: `task-context` only. |
| `input` | Reads the skip keyword, starts the turn cache. |
| `before_agent_start` | Returns the `workflow-state` breadcrumb. |
| `context` | Replaces a stale `task-context`, re-adds or strips the breadcrumb. |
| `tool_call` | Blocks `myflow_subagent` inside a sub-agent (recursion guard). |
| `session_before_compact` | Records the compaction timestamp so the breadcrumb is re-injected. |

Injected blocks are `custom` messages with `display: false`:
`<session-context>`, `<task-context>`, `<workflow-state>`.

`myflow_subagent` spawns an isolated `pi` process per task. It discovers agents
from `.pi/agents/` (project) and `~/.pi/agent/agents/` (user), passes the agent
body via `--append-system-prompt`, sets `MYFLOW_AGENT_TYPE` and
`MYFLOW_CONTEXT_ID`, and emits `myflow-subagent-progress`. Agents without a
`model` inherit the caller's model and thinking level.

`/myflow-status` is a real Pi command (no model call): it prints the active
task, the workflow phase, and git state.

## Runtime: identity and the shell bridge

- A **context key** is `pi_<sanitized id>` from Pi's session id, or an explicit
  `MYFLOW_CONTEXT_ID` (which wins, and is how a sub-agent resolves the parent's
  task).
- The active task pointer is `.myflow/.runtime/sessions/<contextKey>.json`.
- Shell commands share that identity through `PI_SESSION_ID`, which Pi injects
  into bash; `task.py` and `get_context.py` read it (and `MYFLOW_CONTEXT_ID`)
  to address the same file. This is why shell-created tasks activate the right
  session.

## Runtime: context injection

`buildTaskContext` (`src/context-injection.ts`) materializes `prd.md`,
`info.md`, and the files referenced by `implement.jsonl` / `check.jsonl`,
bounded by `context_injection.*` in `.myflow/config.yaml`. Files outside the
project are only read when under a trusted root (`channel.*`). Omitted or
truncated entries remain authoritative on disk; the model must read them.

The escape hatch: if the user's input contains the configured skip keyword
(default `no-myflow`), the per-turn `workflow-state` breadcrumb is suppressed
for that turn. `session-context` and `task-context` are not suppressed.

## Task Lifecycle

```bash
python3 .myflow/scripts/task.py create "<title>" [--slug <name>] [--parent <dir>]
python3 .myflow/scripts/task.py start .myflow/tasks/<slug>   # activates, planning -> in_progress
python3 .myflow/scripts/task.py current [--source] [--json]
python3 .myflow/scripts/task.py finish                       # done + clears the pointer
python3 .myflow/scripts/task.py archive .myflow/tasks/<slug> # completed + moves to archive/<YYYY-MM>/
python3 .myflow/scripts/task.py add-subtask <parent> <child>
python3 .myflow/scripts/task.py list [--status <s>] [--json]
python3 .myflow/scripts/task.py list-archive
```

Statuses: `planning -> in_progress -> done`; `archive` rewrites to `completed`.
The workflow-state block key equals the status (`no_task` when there is none,
`completed` for archived work).

## Workflow

`.myflow/workflow.md` is the source of truth for phases and routing. It holds:

1. A short **Phase Index** (Plan / Execute / Finish).
2. Skill/agent routing.
3. `[workflow-state:STATUS] … [/workflow-state:STATUS]` blocks, which the
   extension injects verbatim for the active status.

Change behavior by editing the relevant block. Keep the opening and closing
STATUS identical — mismatched pairs are silently dropped.

## Spec

`.myflow/spec/` is the convention store, and it is **optional by design**: a
project may have no spec tree yet, in which case `myflow-before-dev` reports
that and continues rather than inventing rules. When it exists, `index.md` is
the entry point, `harness/index.md` holds this repository's rules and the
Pre-Development / Quality Check lists, and `guides/index.md` holds thinking
checklists. `myflow-update-spec` creates the first entry;
`myflow-spec-bootstrap` generates or refreshes the whole tree from the
codebase. There is no packages mode and no registry.

## How To Change What

| Want to change | Edit |
| --- | --- |
| A hook's behavior | `.pi/extensions/myflow/index.ts` |
| `myflow_subagent` modes, progress, spawn flags | `.pi/extensions/myflow/subagent.ts` |
| Which agent files exist / their tools | `.pi/agents/*.md`; discovery in `agents.ts` |
| `/myflow-status` output | `.pi/extensions/myflow/status.ts` |
| Task context budgets or trust rules | `.myflow/config.yaml`, `src/context-injection.ts` |
| Skip keyword behavior | `.myflow/config.yaml`, `src/escape-hatch.ts` |
| Workflow phases, routing, breadcrumbs | `.myflow/workflow.md` |
| Task lifecycle | `.myflow/scripts/task.py` |
| Session context sections | `.myflow/scripts/get_context.py` |
| Entry prompts | `.pi/prompts/*.md` |
| Conventions the model must follow | `.myflow/spec/*/index.md` |
| Regenerate specs from the codebase | `myflow-spec-bootstrap` skill |

## Verify A Change

```bash
node --test tests/
python3 .myflow/scripts/get_context.py
python3 .myflow/scripts/task.py current --source
```

The extension must stay loadable by Pi: only `import type` from
`@earendil-works/pi-coding-agent`, Node builtins otherwise, no `node_modules`.

## Rules

- Pi is the only host. Call Pi's APIs directly; do not add host conditionals or a runtime host filter.
- Do not instruct the model to run commands or read paths that do not exist.
  If you remove a feature, remove its instructions in the same change.
- Keep `.myflow/workflow.md` and `.myflow/spec/` true; they are the two files
  the model trusts when it is unsure.
- Prefer a test over a note. `tests/skills-hygiene.test.ts` guards against
  reintroducing dead references.
