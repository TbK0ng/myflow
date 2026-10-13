# Harness Conventions

How to change the myflow harness without breaking it. These rules describe the
harness itself, so they hold in every project that carries the payload.

## Payload vs Project Files

**Payload** — identical everywhere, safe to copy into any project:

- `.pi/extensions/myflow/` (self-contained; no files outside this directory)
- `.pi/agents/` — `myflow-implement`, `myflow-check`, `myflow-research`
- `.pi/prompts/` — `myflow-continue`, `myflow-finish-work`
- `.pi/skills/` — the workflow skills
- `.myflow/workflow.md`
- `.myflow/scripts/`

**Project-owned** — never copy between projects:

- `.myflow/spec/` (this project's conventions), `.myflow/config.yaml`
- `.myflow/tasks/`, `.myflow/archive/`, `.myflow/.runtime/`

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
- Keep runtime logic importable by `node --test` regardless of whether Pi is
  present.

## Gotchas

- **Parallel sub-agents share the working tree.** `myflow_subagent` never
  creates git worktrees; every child spawns in the caller's directory unless
  its task passes `cwd`. Use parallel dispatch for read-only work
  (`myflow-research`), and give a writing task its own checkout via `cwd` when
  you need isolation.
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
- [ ] No instruction file (skill, prompt, `workflow.md`) now describes
  something that does not exist.
- [ ] `git status` is clean apart from intended changes.
