# Harness Coding Spec

Conventions for this repository: the Pi myflow harness (`src/`, the Pi
extension, `.myflow/` scripts, and the tests that pin their behavior).

## Stack And Constraints

| Area | Rules |
| --- | --- |
| TypeScript (`src/`, `.pi/extensions/myflow/`) | ESM, `strict`, `noEmit`, `allowImportingTsExtensions`, `verbatimModuleSyntax`. Relative imports include the `.ts` extension. |
| Pi types | Only `import type { ... } from "@earendil-works/pi-coding-agent"`. Never a value import; the package is not installed in this repo. |
| Runtime deps | Node builtins and relative modules only. Tests run under `node --test` with type stripping and no `node_modules`. |
| Python (`.myflow/scripts/`) | Python 3 standard library only. Both scripts run from the project root and use `Path.cwd()`. |
| Platform | Pi only. Do not add per-platform branches, conditional blocks, or other AI-tool directories. |

## Load-Bearing Contracts

These must stay consistent across files; change them together or not at all:

- **Context key**: `pi_<sanitized value>` (`src`/extension `buildContextKey`, `get_context.py`, `task.py`). Session files are `.myflow/.runtime/sessions/<contextKey>.json`.
- **Shell/session bridge**: scripts read `MYFLOW_CONTEXT_ID` first, then Pi's `PI_SESSION_ID`.
- **Task statuses**: `planning → in_progress → done`; `archive` rewrites to `completed`. The workflow-state block key equals the status, except `no_task` (no session) and `completed` (archived).
- **Workflow-state blocks**: `[workflow-state:STATUS] … [/workflow-state:STATUS]` in `.myflow/workflow.md`. The extension is parser-only; it injects whatever is inside.
- **Subagent detection**: `MYFLOW_AGENT_TYPE` is set by `myflow_subagent` and read by `detectAgentType()`.
- **Spec source**: `.myflow/spec/*/index.md`. There is no packages mode.

## Extension Rules (`.pi/extensions/myflow/`)

- All six hooks stay registered: `session_start`, `input`, `before_agent_start`, `context`, `tool_call`, `session_before_compact`.
- Context is injected with `pi.sendMessage({ customType, content, display: false })`; never paste injected blocks into user-visible output.
- `tool_call` owns the subagent recursion guard; do not remove it.
- New tools use a plain JSON-schema `parameters` object (no TypeBox import). Pi validates it at runtime.
- Keep runtime logic importable by `node --test` regardless of whether Pi is present.

## Gotchas

- **Windows stdout encoding**: a Python process writing to a pipe defaults to
the ANSI codepage, so non-ASCII text (em dashes, CJK task titles) becomes
mojibake for the UTF-8 reader. `get_context.py` and `task.py` both call
`_force_utf8_stdio()` at import; keep that call.
- **Pi redirects extension console output to stderr in print mode** and keeps
stdout for the model's answer. `/myflow-status` uses `console.log` only when
`ctx.mode === "print"`; in `json` mode it uses `pi.sendMessage` so stdout
stays a clean JSONL stream.
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
- [ ] Identify which load-bearing contract above your change touches, and every file that mirrors it.
- [ ] Confirm the change is testable with `node --test` (no network, no model, no installed dependencies).
- [ ] If the change alters what the model is told to do, note the skill/prompt/`workflow.md` file that must change too.

## Quality Check

- [ ] `node --test tests/` passes.
- [ ] The extension still loads: no value imports from Pi, no missing builtins.
- [ ] New behavior has a test that fails when the behavior is reverted.
- [ ] `python3 .myflow/scripts/get_context.py` and `task.py current --source` still run from the project root.
- [ ] No instruction file (skill, prompt, `workflow.md`, this spec) now describes something that does not exist.
- [ ] `git status` is clean apart from intended changes.
