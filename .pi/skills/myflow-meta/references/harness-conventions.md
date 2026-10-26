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

The payload list has exactly **one source**: `tools/release-payload.json`
(`dirs` / `trees` / `files` / `exclude`). `tests/scaffold.test.ts` and
`tools/release.py` both read that file, so adding or removing a payload file is
a manifest edit — never a second list in either consumer.

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
- `tools/` — `release-payload.json` (the payload manifest), `release.py` (builds
  a release from it), `INSTALL.md` (the installer instructions copied into the
  release). None of these are copied into a target project.

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
- **Bounded writers may run in parallel**: `myflow_subagent` rejects
  `mode: parallel` for a write-capable agent (tools include `write`/`edit`, or no
  allowlist) unless it declares `writesUnder: <dir>`. `myflow-implement` and
  `myflow-check` declare none, so they run one at a time in the shared tree. A
  declared scope is enforced in the child: `MYFLOW_WRITES_UNDER` carries the
  declaration and `tool_call` blocks any `write`/`edit` outside
  `<active task>/<dir>/`. `myflow-research` declares `writesUnder: research`, so
  its parallel runs each persist one topic file under the active task's
  `research/`. This is a **boundary** guarantee, not mutual exclusion: the code
  cannot verify that parallel prompts write disjoint files. True concurrency
  uses worktrees, one session each.
- **Dispatch cap and log**: every `myflow_subagent` run is capped (default
  `SUBAGENT_TIMEOUT_MS`, override with `timeoutMs`, `0` disables) and tees its raw
  stream to `.myflow/.runtime/subagent-logs/`. Stopping is a tree kill
  (`taskkill /T /F`): a plain kill leaves the MCP servers the child started
  holding its handles.
- **Delegated work orders**: `worktree.py start` and `channel.py spawn` prefix the
  prompt with "do not create or manage myflow tasks". Without it a detached
  session reads the `no_task` block at session start and stalls asking for consent.
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
- **Plan approval gate**: `myflow_ask_user` appends `<active task>/questions.jsonl`
  and `myflow_request_approval` writes `<active task>/approval.json`. `task.py start`
  refuses to start until a plan file exists, `approval.json`'s `plan_hash`
  equals the current plan hash, and at least one choice question was answered.
  The plan hash and the answered count have exactly one implementation
  (`.myflow/scripts/task.py`): every TS caller reads them through
  `task.py gate-info` and never re-hashes the plan or counts `questions.jsonl`
  itself. This is a convention reinforcement against forgetting, **not** a
  permission boundary — a `bash`-capable agent can bypass it, and
  `--allow-unapproved` is the escape hatch that leaves
  `task.json.started_without_approval`.
- **Background tasks**: `myflow_bg_start` / `myflow_bg_output` /
  `myflow_bg_list` / `myflow_bg_stop` are the main session's tools for a command
  that must outlive the session. Everything lives under
  `.myflow/.runtime/background/`: `<taskId>.json` (registry entry, written only
  by the tools, atomically), `<taskId>.log` (written by the shell itself),
  `<taskId>.exit` (written by the detached wrapper
  `.myflow/scripts/bg_runner.mjs`, the only observer of the exit code),
  `<taskId>.pid` (the wrapper's own handshake, written before any command can
  run), and `cursors/<contextKey>__<taskId>.json` (per-session read cursor).
  `taskId` is `bg-<base36ms>-<4hex>`, never a pid. Four statuses are reachable —
  `starting`, `running`, `exited`, `stopped` — and a present `.exit` record
  always outranks pid liveness, so a reused pid never reports as running; a dead
  pid with no `.exit` self-heals to `exited` with no code. The pid has one
  source: `<taskId>.pid`, else the entry's cached `pid`, else `0`. `starting`
  means "entry on disk, handshake not yet landed"; it self-heals to `exited`
  after 60s, `output` returns it normally, and `stop` refuses it with "not
  addressable yet" instead of killing pid 0. `cwd` is optional and confined to
  the project root (validated before the dialog, always shown in the dialog).
  `confirmed_by` records `ui-confirm` or the explicit bypass `no-ui-explicit`,
  which `list` surfaces as `unconfirmed`. The command runs under a POSIX shell
  resolved as `MYFLOW_BG_SHELL` → the settings `shellPath` → the Git for Windows
  bash → `bash` on `PATH`, with **no** `cmd.exe` fallback: when nothing resolves
  the task is refused and nothing runs. Sub-agents cannot use any of the four
  tools (allowlist, `tool_call`, and each `execute`). `session_shutdown` must
  never kill a background task — that is the whole point — and must stay
  idempotent; it stays silent when `hasUI === false`, not merely when `notify`
  is absent.

## Extension Rules

- Every hook in the `myflow-meta` table stays registered: `session_start`, `input`, `before_agent_start`,
  `context`, `tool_call`, `session_before_compact`, `agent_before_settle`,
  `session_shutdown`.
- Inject context with `pi.sendMessage({ customType, content, display: false })`;
  never paste injected blocks into user-visible output.
- Agents declare tool allowlists that exclude `myflow_subagent`, so a sub-agent
  cannot dispatch in practice. `tool_call` also blocks that call as a second
  line of defense (for agents without an allowlist); keep both.
- User interaction is main-session-only: `myflow_ask_user` (one multiple-choice
  question, 2-4 options, appends `questions.jsonl`) and `myflow_request_approval`
  (writes `approval.json` only when the user agrees). Both refuse in their
  handler and again in `tool_call`; keep both lines, and do not put either tool
  in an agent allowlist.
- Background tasks are main-session-only for the same reason plus one more: they
  register in the *shared project* registry and outlive the process, so a child
  would leave work nobody can attribute. The four `myflow_bg_*` tools refuse in
  their handler, `tool_call` blocks them, and no agent allowlist may list them.
- `session_shutdown` may run more than once (cancel, reload, session
  replacement, process exit): claim an idempotence flag before doing anything,
  release only what the session actually owns, never kill a background task,
  and never throw — a throwing shutdown hook can block or corrupt the exit.
- New tools use a plain JSON-schema `parameters` object (no TypeBox import). Pi
  validates it at runtime.
- `agent_before_settle` holds a `myflow-check` sub-agent until
  `.myflow/worktree.yaml` `verify:` passes; the retry cap is mandatory so a
  broken command cannot loop.
- Keep runtime logic importable by `node --test` regardless of whether Pi is
  present.

## Gotchas

- **Sub-agents share one working tree.** `myflow_subagent` always spawns
  children in the caller's directory and never creates git worktrees. Run
  unbounded writing agents one at a time; parallel dispatch is allowed for
  `myflow-research` because it declares `writesUnder: research` and the child
  blocks writes outside that directory. For genuinely parallel *sessions*, use
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

- **`taskkill` must be called with an argv array**, never through Git Bash: MSYS
  rewrites `/F` into `F:/` and the command fails with "invalid argument".
  `terminateTree` in `background/stop.ts` spawns it that way, and the stop tests must
  not route the call through a shell either.
- **The `bash` on `PATH` may be the WSL launcher.**
  `C:\Windows\System32\bash.exe` is the WSL entry point, which this project
  forbids invoking. Background shell resolution therefore skips all three
  spellings of that directory — `System32`, `Sysnative`, `SysWOW64` — so a
  resolved shell is never the launcher; prefer an explicit `MYFLOW_BG_SHELL` or
  a settings `shellPath` when in doubt.

- **Testing a launch on Windows**: a `.cmd` shim cannot observe a multi-line argv
  (cmd splits on the newline), so a test that inspects what was handed to `pi`
  breaks as soon as the prompt grows a newline. Assert the recorded state
  (registry/plan) instead of the shim's view of argv.

## Config Keys (`.myflow/config.yaml`, all optional)

| Key | Default | Effect |
| --- | --- | --- |
| `prompt_injection.skip_keyword` | `no-myflow` | Word that suppresses the per-turn workflow breadcrumb |
| `context_injection.max_file_bytes` | 32768 | Per-file task-context budget |
| `context_injection.max_artifact_bytes` | 65536 | Per-artifact (prd/design/implement/info) budget |
| `context_injection.max_total_bytes` | 131072 | Total task-context budget |
| `channel.trusted_context_dirs` | `[]` | Extra roots JSONL-referenced files may live in |
| `channel.auto_trust_myflow_symlinks` | `true` | Auto-trust a symlinked `.myflow/tasks` directory |
| `channel.worker_guard.max_live_workers` | `3` | Cap on live workers; `spawn` refuses above it |
| `channel.worker_guard.idle_timeout` | `900` | Seconds before the guard stops an idle worker |

## Pre-Development Checklist

- [ ] Read `.myflow/workflow.md` and this file.
- [ ] Identify which load-bearing contract your change touches, and every file
  that mirrors it.
- [ ] Confirm the change is testable with `node --test` (no network, no model,
  no installed dependencies).
- [ ] If the change alters what the model is told to do, note the
  skill/prompt/`workflow.md` file that must change too.
- [ ] If the change touches the `myflow_bg_*` tools, read the "Background tasks"
  contract above and the shell resolution in `.myflow/scripts/bg_runner.mjs`
  before editing either side. The tools are the only writer of `<taskId>.json`;
  the wrapper is the only writer of `<taskId>.log`, `<taskId>.exit`, and
  `<taskId>.pid`.

## Quality Check

- [ ] `npm run check` passes (typecheck, then the suite).
- [ ] The extension still loads from a payload-only copy
  (`tests/scaffold.test.ts`).
- [ ] New behavior has a test that fails when the behavior is reverted.
- [ ] `python3 .myflow/scripts/get_context.py` and `task.py current --source`
  still run from the project root.
- [ ] The suite covers `worktree.py` (create/list/verify/remove/prune)
  and the verify gate.
- [ ] No instruction file (skill, prompt, `workflow.md`) now describes
  something that does not exist.
- [ ] Changing the background-task shell resolution, the `<taskId>.exit` shape,
  or the `<taskId>.pid` handshake was mirrored into the `myflow_bg_start` tool
  description, the spec contract (`.myflow/spec/harness/index.md`), and this
  file in the same change.
- [ ] `git status` is clean apart from intended changes.
