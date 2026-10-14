---
name: myflow-meta
description: "Understand, modify, and copy the myflow harness for Pi: the six extension hooks, the myflow_subagent tool, the /myflow-status command, context injection and escape hatch, the task lifecycle and scripts, workflow.md state blocks, the harness conventions, and which files form the copyable payload. Use when asked to change, debug, extend, or install the myflow harness."
---

# myflow Meta

This repository **is** the myflow harness for Pi. This skill is the map for
changing it. It describes only what exists here — there is one platform (Pi),
this repository is the whole harness: one Pi extension, four scripts, the skills that drive them, and their tests.

## Layout

```
.pi/
  extensions/myflow/index.ts        # extension factory: hooks + /myflow-status
  extensions/myflow/subagent.ts     # myflow_subagent tool (single/parallel/chain)
  extensions/myflow/agents.ts       # agent discovery from .pi/agents
  extensions/myflow/status.ts       # status report builder (used by the command)
  extensions/myflow/*.ts            # pure helpers the extension imports: root lookup,
                                    # state parsing, turn cache, escape hatch, injection
  extensions/myflow/pi-coding-agent.d.ts  # the only Pi type surface used
  agents/myflow-{implement,check,research}.md
  prompts/myflow-{continue,finish-work,parallel}.md
  skills/myflow-{meta,brainstorm,before-dev,check,update-spec,break-loop,spec-bootstrap,channel}/
.myflow/
  agents/{architect,reviewer}.md      # channel runtime peers (design review, code review)
  workflow.md                       # phases, routing, per-turn state blocks
  worktree.yaml                     # parallel-session config + verify commands (project-owned)
  scripts/get_context.py            # session context (workflow + task + git)
  scripts/task.py                   # task lifecycle + session pointer
  scripts/worktree.py               # isolated parallel sessions (git worktrees)
  scripts/channel.py                # channel runtime (workers, messages, wait)
  spec/                             # this project's conventions (project-owned)
  tasks/<slug>/                     # task.json, prd.md, info.md, *.jsonl, research/
  archive/<YYYY-MM>/<slug>/         # archived tasks
  .runtime/sessions/<key>.json      # active-task pointer per session
tests/                              # harness development only (node --test)
```

## Payload

To install the harness in another project, copy:

- `.pi/` — extension, agents, prompts, skills
- `.myflow/agents/` — channel runtime agent definitions
- `.myflow/workflow.md` and `.myflow/scripts/`

Do **not** copy `.myflow/spec/`, `.myflow/tasks/`, `.myflow/archive/`,
`.myflow/.runtime/`, `.myflow/config.yaml`, or `.myflow/worktree.yaml` — those
belong to the project.
`tests/scaffold.test.ts` fails if the payload ever depends on a file outside it.

## Runtime: the extension

`.pi/extensions/myflow/` is self-contained: the extension, the tool, the
command, the pure helpers, and the type declaration all live in that
directory. Six hooks are always registered:

| Hook | What it does |
| --- | --- |
| `session_start` | Main session: `session-context` + `task-context`. Sub-agent: `task-context` only. |
| `input` | Reads the skip keyword, starts the turn cache. |
| `before_agent_start` | Returns the `workflow-state` breadcrumb. |
| `context` | Replaces a stale `task-context`, re-adds or strips the breadcrumb. |
| `tool_call` | Blocks `myflow_subagent` inside a sub-agent (recursion guard). |
| `session_before_compact` | Records the compaction timestamp so the breadcrumb is re-injected. |
| `agent_before_settle` | Holds a `myflow-check` sub-agent until the configured verify commands pass (bounded retries). |

Injected blocks are `custom` messages with `display: false`:
`<session-context>`, `<task-context>`, `<workflow-state>`.

`myflow_subagent` spawns an isolated `pi` process per run. A call names one
agent and one or more prompts: `single` runs one prompt, `parallel` runs up to
six prompts for that agent at once, and `chain` runs them in sequence with
`Previous output:` appended. Runs are capped (`timeoutMs`, default 15 min, 0 = none)
and logged under `.myflow/.runtime/subagent-logs/`. `parallel` is refused for write-capable agents
(implement, check): sub-agents share one tree, so one writer runs at a time.
`agent` is normalized to the `myflow-` prefix
(`implement` → `myflow-implement`) and must have a definition in `.pi/agents/`.
Per-call `model` and `thinking` override the agent definition, which overrides
the caller. The child receives the agent body via `--append-system-prompt`, plus
`MYFLOW_AGENT_TYPE` and `MYFLOW_CONTEXT_ID`, and emits
`myflow-subagent-progress`. Agents without `model`/`thinking` inherit both from
the caller.

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

`buildTaskContext` (`.pi/extensions/myflow/context-injection.ts`) materializes `prd.md`,
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
python3 .myflow/scripts/task.py archive .myflow/tasks/<slug> # completed + moves to archive/<YYYY-MM>/
python3 .myflow/scripts/task.py add-subtask <parent> <child>
python3 .myflow/scripts/task.py list [--status <s>] [--json]
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

`.myflow/spec/` is the **project's** convention store and is project-owned, not
part of the payload. A project may have none: `myflow-before-dev` then reports
`NO_SPEC` and continues rather than inventing rules. `myflow-update-spec`
creates the first entry and `myflow-spec-bootstrap` generates or refreshes a
whole tree.

The conventions that describe the **harness itself** (payload boundaries,
load-bearing contracts, extension rules, gotchas, config keys, checklists) live
with this skill in `references/harness-conventions.md`.

## How To Change What

| Want to change | Edit |
| --- | --- |
| A hook's behavior | `.pi/extensions/myflow/index.ts` |
| `myflow_subagent` modes, progress, spawn flags | `.pi/extensions/myflow/subagent.ts` |
| Which agent files exist / their tools | `.pi/agents/*.md`; discovery in `agents.ts` |
| `/myflow-status` output | `.pi/extensions/myflow/status.ts` |
| Task context budgets or trust rules | `.myflow/config.yaml`, `.pi/extensions/myflow/context-injection.ts` |
| Skip keyword behavior | `.myflow/config.yaml`, `.pi/extensions/myflow/escape-hatch.ts` |
| Workflow phases, routing, breadcrumbs | `.myflow/workflow.md` |
| Task lifecycle | `.myflow/scripts/task.py` |
| Parallel sessions (worktrees) | `.myflow/scripts/worktree.py`, `.myflow/worktree.yaml` |
| Channel runtime | `.myflow/scripts/channel.py`, skill `myflow-channel` |
| Channel runtime agents | `.myflow/agents/*.md` |
| Verify gate commands | `.myflow/worktree.yaml` (`verify:`) |
| Session context sections | `.myflow/scripts/get_context.py` |
| Entry prompts | `.pi/prompts/*.md` |
| Conventions the model must follow | `.myflow/spec/*/index.md` (project-owned; create on demand) |
| Harness contracts, gotchas, checklists | `.pi/skills/myflow-meta/references/harness-conventions.md` |
| Regenerate specs from the codebase | `myflow-spec-bootstrap` skill |

## Verify A Change

```bash
node --test tests/
python3 .myflow/scripts/get_context.py
python3 .myflow/scripts/task.py current --source
python3 .myflow/scripts/worktree.py config
python3 .myflow/scripts/channel.py list --all
```

The extension must stay loadable by Pi from a payload-only copy: run
`node --test tests/scaffold.test.ts` after changing anything under `.pi/` or
under `.myflow/workflow.md` / `.myflow/scripts/`. Only `import type` from
`@earendil-works/pi-coding-agent`, Node builtins otherwise, no `node_modules`.

## Rules

- Pi is the only host. Call Pi's APIs directly; do not add host conditionals or a runtime host filter.
- Do not instruct the model to run commands or read paths that do not exist.
  If you remove a feature, remove its instructions in the same change.
- Keep `.myflow/workflow.md` and `references/harness-conventions.md` true; they
  are what the model trusts when it is unsure.
- Keep the payload self-contained: nothing under `.pi/` may import a file
  outside `.pi/`, and `.myflow/scripts/` may not import anything outside itself.
- Prefer a test over a note. `tests/skills-hygiene.test.ts` guards against
  reintroducing dead references.
