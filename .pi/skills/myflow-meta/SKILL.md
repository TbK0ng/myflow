---
name: myflow-meta
description: "Understand, modify, and copy the myflow harness for Pi: the extension hooks, the myflow_subagent tool, the /myflow-status command, context injection and escape hatch, the task lifecycle and scripts, workflow.md state blocks, the harness conventions, and which files form the copyable payload. Use when asked to change, debug, extend, or install the myflow harness."
---

# myflow Meta

This repository **is** the myflow harness for Pi. This skill is the map for
changing it. It describes only what exists here — there is one platform (Pi),
this repository is the whole harness: one Pi extension, five scripts, the skills that drive them, and their tests.

**Windows only, with Git Bash.** The shell is the Git for Windows bash, a process
tree dies by `taskkill /F /T`, a worker is spawned with `DETACHED_PROCESS`, and
path comparison folds case (NTFS does). There is exactly one code path: no
`process.platform` / `os.name` branch survives, and each entry point refuses to
start on another platform instead of half-working.

## Layout

```
.pi/
  extensions/myflow/index.ts        # extension factory: hooks + /myflow-status
  extensions/myflow/subagent.ts     # myflow_subagent tool (single/parallel/chain)
  extensions/myflow/ask.ts          # myflow_ask_user tool (one choice question)
  extensions/myflow/approval.ts     # myflow_request_approval tool (writes approval.json)
  extensions/myflow/background/      # the four myflow_bg_* tools + the on-disk registry
    index.ts                         #   public surface: BG_TOOL_NAMES + registerMyflowBackground
    registry.ts                      #   the on-disk layer (entry, pid, exit, cursor, prune)
    tools.ts                         #   shared plumbing: registration, refusals, cwd check
    {start,output,list,stop}.ts       #   one tool each
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
  worktree.yaml                     # optional, project-owned: parallel sessions + verify commands
  scripts/get_context.py            # session context (workflow + task + git)
  scripts/task.py                   # task lifecycle + session pointer
  scripts/bg_runner.mjs             # detached background-task wrapper (records its own exit)
  scripts/worktree.py               # isolated parallel sessions (git worktrees)
  scripts/channel.py                # channel runtime (workers, messages, wait)
  spec/                             # this project's conventions (project-owned)
  tasks/<slug>/                     # task.json, prd.md, info.md, *.jsonl, approval.json, research/
  archive/<YYYY-MM>/<slug>/         # archived tasks
  .runtime/sessions/<key>.json      # active-task pointer per session
tests/                              # harness development only (node --test)
tools/                              # harness development only, never in the payload
  release-payload.json              # the single source of truth for the payload list
  release.py                        # builds dist/myflow-<version>/ + .zip; --check / --verify
                                    # --release bumps, changelogs, builds, commits and tags
  INSTALL.md                        # installer instructions copied into every release
```

## Payload

To install the harness in another project, copy:

- `.pi/` — extension, agents, prompts, skills
- `.myflow/agents/` — channel runtime agent definitions
- `.myflow/workflow.md` and `.myflow/scripts/`

Do **not** copy `.myflow/spec/`, `.myflow/tasks/`, `.myflow/archive/`,
`.myflow/.runtime/`, `.myflow/config.yaml`, or `.myflow/worktree.yaml` — those
belong to the project. Both config files are optional: every reader falls back
to built-in defaults, so a project without them is configured, not broken.
`tests/`, `package.json`, `tsconfig.json`, and `tools/` are harness development
and are not copied either.

The payload list has exactly **one source**: `tools/release-payload.json`
(`dirs` / `trees` / `files` / `exclude`). `tests/scaffold.test.ts` and
`tools/release.py` both read it, so adding or removing a payload file is a
manifest edit, never a second list in either consumer.
`tests/scaffold.test.ts` fails if the payload ever depends on a file outside it.

## Runtime: the extension

`.pi/extensions/myflow/` is self-contained: the extension, the tools, the
command, the pure helpers, and the type declaration all live in that
directory. These hooks are always registered:

| Hook | What it does |
| --- | --- |
| `session_start` | Main session: `session-context` + `task-context`. Sub-agent: `task-context` only. |
| `input` | Reads the skip keyword, starts the turn cache. |
| `before_agent_start` | Returns the `workflow-state` breadcrumb. |
| `context` | Replaces a stale `task-context`, re-adds or strips the breadcrumb. |
| `tool_call` | Blocks `myflow_subagent` inside a sub-agent (recursion guard), blocks `myflow_ask_user` / `myflow_request_approval` inside a sub-agent (main-session-only guard), blocks the four `myflow_bg_*` tools inside a sub-agent (background tasks register in the shared project registry and outlive the process), and blocks `write`/`edit` outside a declared `writesUnder` scope. |
| `session_before_compact` | Records the compaction timestamp so the breadcrumb is re-injected. |
| `agent_before_settle` | Holds a `myflow-check` sub-agent until the configured verify commands pass (bounded retries). |
| `session_shutdown` | Kills nothing: background tasks are project-level and must outlive the session. It is idempotent (one run per session), reports the tasks this session started that are still running (silent without a UI), and never throws. |

Injected blocks are `custom` messages with `display: false`:
`<session-context>`, `<task-context>`, `<workflow-state>`.

`myflow_subagent` spawns an isolated `pi` process per run. A call names one
agent and one or more prompts: `single` runs one prompt, `parallel` runs up to
six prompts for that agent at once, and `chain` runs them in sequence with
`Previous output:` appended. Runs are capped (`timeoutMs`, default 15 min, 0 = none)
and logged under `.myflow/.runtime/subagent-logs/`. `parallel` is refused for a
write-capable agent that declares no `writesUnder` scope (implement, check):
sub-agents share one tree, so an unbounded writer runs one at a time. A declared
scope makes the writer parallel-safe within `<active task>/<dir>/`.
`agent` is normalized to the `myflow-` prefix
(`implement` → `myflow-implement`) and must have a definition in `.pi/agents/`.
Per-call `model` and `thinking` override the agent definition, which overrides
the caller. The child receives the agent body via `--append-system-prompt`, plus
`MYFLOW_AGENT_TYPE` and `MYFLOW_CONTEXT_ID` (and `MYFLOW_WRITES_UNDER` when the
agent declares a write scope), and emits
`myflow-subagent-progress`. Agents without `model`/`thinking` inherit both from
the caller.

`myflow_ask_user` and `myflow_request_approval` implement the plan-approval
gate and take the same injected `deriveContextKey` / `isSubAgent` as
`myflow_subagent`, so neither imports `index.ts`. The first asks one 2-4 option
question through `ctx.ui.select` and appends `questions.jsonl`; the second
confirms through `ctx.ui.confirm` and writes `approval.json` only on consent.
With no interactive UI both return instructions instead of fabricating an answer
or an approval. The gate's contracts live in `references/harness-conventions.md`.

The four `myflow_bg_*` tools (`myflow_bg_start`, `myflow_bg_output`,
`myflow_bg_list`, `myflow_bg_stop`) run a command that outlives the session.
`background/registry.ts` owns the registry (`<taskId>.json` under
`.myflow/.runtime/background/`) and injects nothing back into `index.ts`;
`scripts/bg_runner.mjs` is the detached wrapper that spawns the command through
a resolved POSIX shell and records `<taskId>.exit` itself, which is the only way
a later session can learn the exit code. `myflow_bg_start` shows the exact
command in `ctx.ui.confirm` and refuses without a UI unless called with
`unattended: true`, which is recorded as `confirmed_by: no-ui-explicit`.
`session_shutdown` never kills these tasks: it only reports the ones this
session started that are still running. The full contract lives in
`references/harness-conventions.md`.

`/myflow-status` is a real Pi command (no model call): it prints the active
task, the workflow phase, the plan-approval state, and git state.

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
`design.md` / `implement.md` when present, `info.md`, and the files referenced
by `implement.jsonl` / `check.jsonl`, bounded by `context_injection.*` in
`.myflow/config.yaml`. Files outside the
project are only read when under a trusted root (`channel.*`). Omitted or
truncated entries remain authoritative on disk; the model must read them.

The escape hatch: if the user's input contains the configured skip keyword
(default `no-myflow`), the per-turn `workflow-state` breadcrumb is suppressed
for that turn. `session-context` and `task-context` are not suppressed.

## Task Lifecycle

```bash
python3 .myflow/scripts/task.py create "<title>" [--slug <name>] [--parent <dir>]
python3 .myflow/scripts/task.py start .myflow/tasks/<slug>   # activates, planning -> in_progress
python3 .myflow/scripts/task.py approve .myflow/tasks/<slug> # human approval of the current plan
python3 .myflow/scripts/task.py plan-hash .myflow/tasks/<slug>   # the only plan-hash implementation
python3 .myflow/scripts/task.py gate-info .myflow/tasks/<slug>   # read-only gate snapshot (JSON)
python3 .myflow/scripts/task.py current [--source] [--json]
python3 .myflow/scripts/task.py archive .myflow/tasks/<slug> # completed + moves to archive/<YYYY-MM>/
python3 .myflow/scripts/task.py add-subtask <parent> <child>
python3 .myflow/scripts/task.py add-context <task> <implement|check> <path> "<why>"   # curate a manifest entry
python3 .myflow/scripts/task.py validate <task>   # check the manifests have curated entries
python3 .myflow/scripts/task.py finish   # clear the active-task pointer without changing status
python3 .myflow/scripts/task.py list [--status <s>] [--json]
```

Statuses: `planning -> in_progress -> done`; `archive` rewrites to `completed`.
The workflow-state block key equals the status (`no_task` when there is none,
`completed` for archived work).

`start` now runs two gates after the context-manifest gate: `questions.jsonl`
must hold at least one answered choice question, and `approval.json`'s
`plan_hash` must match the current plan hash. Editing any plan file after
approval makes it stale, so it must be approved again; `--allow-unapproved`
skips the gate knowingly and records `started_without_approval` in `task.json`.

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
| Choice questions, plan approval, the gate | `.pi/extensions/myflow/ask.ts`, `.pi/extensions/myflow/approval.ts`; enforcing side in `.myflow/scripts/task.py` |
| Background tasks (start/output/list/stop) | `.pi/extensions/myflow/background/`; the wrapper in `.myflow/scripts/bg_runner.mjs` |
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
npm run check                     # tsc --noEmit, then the suite
python3 .myflow/scripts/get_context.py
python3 .myflow/scripts/task.py current --source
python3 .myflow/scripts/worktree.py config
python3 .myflow/scripts/channel.py list --all
```

The extension must stay loadable by Pi from a payload-only copy: run
`node --test tests/scaffold.test.ts` after changing anything under `.pi/` or
under `.myflow/workflow.md` / `.myflow/scripts/`. Only `import type` from
`@earendil-works/pi-coding-agent`, Node builtins otherwise, no runtime
dependency on `node_modules`.

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
