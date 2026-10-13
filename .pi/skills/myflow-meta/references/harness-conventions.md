# Harness Conventions

How to change the myflow harness without breaking it. These rules describe the
harness itself, so they hold in every project that carries the payload.

## Payload vs Project Files

**Payload** — identical everywhere, safe to copy into any project:

- `.pi/extensions/myflow/` (self-contained; no files outside this directory)
- `.pi/agents/` — `myflow-implement`, `myflow-check`, `myflow-research`
- `.pi/prompts/` — `myflow-continue`, `myflow-finish-work`, `myflow-parallel`
- `.pi/skills/` — the workflow skills
- `.myflow/workflow.md`
- `.myflow/scripts/`
- `.myflow/agents/` — the channel runtime's worker definitions

**Project-owned** — never copy between projects:

- `.myflow/spec/` (this project's conventions), `.myflow/config.yaml`,
  `.myflow/worktree.yaml`
- `.myflow/tasks/`, `.myflow/archive/` — deliverables, committed with the code
- `.myflow/.runtime/` — machine state (sessions, worktree registry, worker
  logs, channel-adjacent records). Add it to the project's `.gitignore`; a
  tracked runtime directory pollutes every diff and makes worktree merges
  collide with untracked copies.

**Harness development** — not needed to run the payload:

- `tests/`, `package.json`, `tsconfig.json`

## Stack And Constraints

| Area | Rules |
| --- | --- |
| TypeScript (`.pi/extensions/myflow/`) | ESM, `strict`, `.ts` extensions in relative imports. Only `import type` from `@earendil-works/pi-coding-agent`; never a value import. |
| Runtime deps | Node builtins and relative modules only. Tests run under `node --test` with type stripping and no `node_modules`. The extension must load from a payload-only copy. |
| Python (`.myflow/scripts/`) | Python 3 standard library only. Each script resolves the project root by walking up to the nearest `.myflow/workflow.md`. |
| Host | Pi. Call Pi's APIs directly: no host conditionals, no host filter. |

## Load-Bearing Contracts

Keep these consistent across files; change them together or not at all:

- **Context key**: `pi_<sanitized value>` (`buildContextKey`, `get_context.py`,
  `task.py`). Session files live at `.myflow/.runtime/sessions/<key>.json`.
- **Shell/session bridge**: scripts read `MYFLOW_CONTEXT_ID` first, then Pi's
  `PI_SESSION_ID`.
- **Task statuses**: `planning → in_progress → done`; `archive` rewrites to
  `completed`. The workflow-state block key equals the status, except
  `no_task` (no session) and `completed` (archived).
- **Workflow-state blocks**: `[workflow-state:STATUS] … [/workflow-state:STATUS]`
  in `.myflow/workflow.md`. The extension is parser-only.
- **Subagent detection**: `myflow_subagent` sets `MYFLOW_AGENT_TYPE` to the
  dispatched agent's name, and `detectAgentType()` treats any non-empty name as
  a sub-agent (custom agent definitions included).
- **Delegated runs**: `MYFLOW_SKIP_BREADCRUMB=1` suppresses the per-turn
  breadcrumb for a process that receives a work order rather than a user turn
  (channel workers set it).
- **One writer per working tree**: `myflow_subagent` rejects `mode: parallel`
  for write-capable agents (tools include `write`/`edit`, or no allowlist).
  `myflow-implement` and `myflow-check` both write, so they run one at a time in
  the shared tree; research is the parallel agent. True concurrency uses
  worktrees, one session each.
- **Verify gate scope**: the gate holds a dispatched `myflow-check` sub-agent
  (agent type) or any process with `MYFLOW_VERIFY_GATE=1`, which is how
  `channel.py spawn --agent reviewer` covers a peer review that carries no
  agent type.
- **Worktree sessions**: `worktree.py start` mints a fresh session id per
  launch (`myflow-<name>-<MMDD-HHMMSS>-<ms>`, recorded in `worktrees.json`) and
  prints the resume command. pi resumes a session it is handed by id, so
  reusing an id would silently continue a finished conversation in a new
  worktree; continuity is explicit via `--session-id` or `pi --resume`.
- **Project marker**: a project root is a directory whose `.myflow/` holds
  `workflow.md`. `find-project-root.ts` and every script (`task.py`,
  `get_context.py`, `channel.py`, `worktree.py`) resolve it the same way by
  walking up, so running from a subdirectory targets the project; with no
  project above, the start directory is used as-is. The file is part of the
  payload and nothing writes it at runtime, so it cannot appear by accident.
- **User-level state**: the channel store lives at `~/.pi/myflow/channels`. Never
  put user-level state in `~/.myflow` — that name is the project marker, so a
  directory called that above a project makes the resolve step stop there and
  redirect the harness (tasks, sessions, archive) into the home directory.

## Extension Rules

- All six hooks stay registered: `session_start`, `input`, `before_agent_start`,
  `context`, `tool_call`, `session_before_compact`.
- Inject context with `pi.sendMessage({ customType, content, display: false })`;
  never paste injected blocks into user-visible output.
- Agents declare tool allowlists that exclude `myflow_subagent`, so a sub-agent
  cannot dispatch in practice. `tool_call` also blocks that call as a second
  line of defense (for agents without an allowlist); keep both.
- New tools use a plain JSON-schema `parameters` object (no TypeBox import). Pi
  validates it at runtime.
- `agent_before_settle` holds a `myflow-check` sub-agent until
  `.myflow/worktree.yaml` `verify:` passes; the retry cap is mandatory so a
  broken command cannot loop.
- Keep runtime logic importable by `node --test` regardless of whether Pi is
  present.

## Gotchas

- **Sub-agents share one working tree.** `myflow_subagent` always spawns
  children in the caller's directory and never creates git worktrees. Use
  parallel dispatch for read-only work (`myflow-research`); run writing agents
  one at a time. For genuinely parallel *sessions*, use
  `worktree.py` (`/myflow-parallel`), which gives each session its own
  checkout and branch.
- **Windows stdout encoding**: a Python process writing to a pipe defaults to
  the ANSI codepage, so non-ASCII text (em dashes, CJK task titles) becomes
  mojibake for the UTF-8 reader. `get_context.py` and `task.py` both call
  `_force_utf8_stdio()` at import; keep that call.
- **Pi redirects extension console output to stderr in print mode** and keeps
  stdout for the model's answer. `/myflow-status` uses `console.log` only when
  `ctx.mode === "print"`; in `json` mode it sends a message so stdout stays a
  clean JSONL stream.
- **Git Bash rewrites `/`-prefixed arguments** (MSYS path conversion), so
  running `pi "/myflow-status"` from Git Bash sends a filesystem path, not the
  command. Verify commands from Node/RPC or use the TUI.

## Config Keys (`.myflow/config.yaml`, all optional)

| Key | Default | Effect |
| --- | --- | --- |
| `prompt_injection.skip_keyword` | `no-myflow` | Word that suppresses the per-turn workflow breadcrumb |
| `context_injection.max_file_bytes` | 32768 | Per-file task-context budget |
| `context_injection.max_artifact_bytes` | 65536 | Per-artifact (prd/info) budget |
| `context_injection.max_total_bytes` | 131072 | Total task-context budget |
| `channel.trusted_context_dirs` | `[]` | Extra roots JSONL-referenced files may live in |
| `channel.auto_trust_myflow_symlinks` | `true` | Auto-trust a symlinked `.myflow/tasks` directory |

## Pre-Development Checklist

- [ ] Read `.myflow/workflow.md` and this file.
- [ ] Identify which load-bearing contract your change touches, and every file
  that mirrors it.
- [ ] Confirm the change is testable with `node --test` (no network, no model,
  no installed dependencies).
- [ ] If the change alters what the model is told to do, note the
  skill/prompt/`workflow.md` file that must change too.

## Quality Check

- [ ] `node --test tests/` passes.
- [ ] The extension still loads from a payload-only copy
  (`tests/scaffold.test.ts`).
- [ ] New behavior has a test that fails when the behavior is reverted.
- [ ] `python3 .myflow/scripts/get_context.py` and `task.py current --source`
  still run from the project root.
- [ ] `node --test tests/` covers `worktree.py` (create/list/verify/remove/prune)
  and the verify gate.
- [ ] No instruction file (skill, prompt, `workflow.md`) now describes
  something that does not exist.
- [ ] `git status` is clean apart from intended changes.
