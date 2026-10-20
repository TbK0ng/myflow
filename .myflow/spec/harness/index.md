# Harness Spec

Rules for changing the myflow harness: `.pi/extensions/myflow/`, `.pi/agents/`,
`.pi/skills/`, `.myflow/scripts/`, and `.myflow/workflow.md`.

Payload tour and inventory:
`.pi/skills/myflow-meta/references/harness-conventions.md`.

## Pre-Development Checklist

- [ ] Run `node --test tests/` **from the main session**, not from inside a
      sub-agent. The suite is not hermetic w.r.t. `MYFLOW_AGENT_TYPE` /
      `MYFLOW_CONTEXT_ID`: when those leak in, ~14 unrelated tests fail because
      the extension sees itself as a sub-agent. Clear them before believing a
      failure:
      `env -u MYFLOW_AGENT_TYPE -u MYFLOW_CONTEXT_ID -u MYFLOW_SKIP_BREADCRUMB -u MYFLOW_WRITES_UNDER node --test tests/`
- [ ] Decide whether you are changing a **contract** (env key, frontmatter key,
      file format, tool schema) or only behavior inside one module. A contract
      change updates this file *and* every copy of the rule in the same change.
- [ ] If you touch dispatch, or anything that writes, read
      "Write scope: `writesUnder`" below first.
- [ ] If you change the approval gate, the plan hash, or either of the two new
      tools (`myflow_ask_user` / `myflow_request_approval`), keep the
      one-implementation rule: the hash and the "answered" count live only in
      `.myflow/scripts/task.py`, and every TS caller goes through
      `task.py gate-info`.
- [ ] If you touch the four `myflow_bg_*` tools, read
      "Background tasks: `myflow_bg_*`" below **and** the shell resolution in
      `.myflow/scripts/bg_runner.mjs` (`resolveShellPath` /
      `shellRejectionReason` / `shellArgsFor`) before changing either. The runner
      is the only writer of `<id>.log` and `<id>.exit`; the tools are the only
      writer of `<id>.json`.

## Contracts

### Write scope: `writesUnder`

- **Producer**: `.pi/agents/<agent>.md` frontmatter — `writesUnder: <dir>`
  (relative to the active task dir), parsed in `.pi/extensions/myflow/agents.ts`.
- **Consumers**:
  - `.pi/extensions/myflow/subagent.ts` — injects the declaration as the
    `MYFLOW_WRITES_UNDER` env var into the child process, and gates
    `mode: "parallel"`.
  - `.pi/extensions/myflow/index.ts` — the child's `tool_call` handler blocks
    `write` / `edit` outside `<active task>/<writesUnder>/`.
- **Value/shape**: one relative directory path, e.g. `research`. Handed over as
  `MYFLOW_WRITES_UNDER`. Empty or absent means "no declared scope".
- **Invariant**: a sub-agent carrying `MYFLOW_WRITES_UNDER` may only write under
  `<active task>/<scope>/`. Every ambiguity blocks:
  - a blank declaration,
  - a declaration that is absolute, drive-lettered, or contains a `..` segment,
  - a `write` / `edit` input whose `path` is missing or not a string,
  - no resolvable active task.
- **Breaks if**: the containment test stops anchoring on `<dir>/` (so
  `researchX` would match `research`); `..` is not collapsed before the prefix
  comparison; or the comparison is not case-insensitive on Windows.

### Task context gate: empty `implement.jsonl` / `check.jsonl`

- **Producer**: `.myflow/scripts/task.py create` seeds empty `implement.jsonl`
  and `check.jsonl` in every task it creates.
- **Consumers**:
  - `task.py start` — refuses a task whose manifest exists but has 0 curated
    entries, unless `--allow-empty-context` is passed. The manifest gate is a
    second line of defense after the phase-1 review gate in `workflow.md`.
  - `task.py validate <task>` — reports the same condition (and invalid rows,
    missing referenced files) with a non-zero exit.
  - `task.py add-context <task> <implement|check> <path> [reason]` — the write
    side; appends `{file, reason}` (or `{file, type:"directory", reason}` for a
    directory) and refuses a duplicated path.
- **Value/shape**: a curated entry is a JSON object line carrying a truthy
  `file` (or legacy `path`) string. `create` seeds the file **empty** — a
  placeholder `_example` row is a hard validation error, not scaffolding.
- **Invariant**: an **absent** manifest is not gated; only a seeded-but-empty
  one is. Gating absence would strand every task created before seeding landed.
- **Breaks if**: the gate reads a missing file as 0 entries; `create` stops
  seeding (the gate then never fires); or a gate ships without `add-context` as
  its write side (an unsatisfiable gate).

### Task context: what the extension injects

- **Producer**: `.pi/extensions/myflow/context-injection.ts` `buildTaskContext`.
- **Consumers**: the `<task-context>` block `myflow_subagent` injects into
  every dispatched child, and `session_before_compact` re-injects.
- **Value/shape**: task artifacts in a fixed order — `prd.md` → `design.md` →
  `implement.md` → `info.md` — each materialized as an `artifact` and bounded
  by `context_injection.max_artifact_bytes`; then the files referenced by
  `implement.jsonl` / `check.jsonl`, each bounded by `max_file_bytes`; every
  block scored against `max_total_bytes`.
- **Invariant**: `design.md` and `implement.md` get exactly the treatment
  `prd.md` does — same `max_artifact_bytes` cap, same truncation/omitted
  fallback under `max_total_bytes`. A missing artifact is skipped silently,
  never an error. `info.md` is myflow's own artifact and stays in the list.
- **Ordering caveat**: artifacts are emitted **before** the curated jsonl
  files, so under total-budget pressure the jsonl context is dropped or
  degraded first. That inversion is known and
  deliberately **not** changed here (a budget-priority
  reorder is a separate change); if it is revisited, update the Dispatch
  Protocol read order in `.myflow/workflow.md` and this entry together.
- **Breaks if**: `design.md` / `implement.md` drop out of the injection list
  (the Dispatch Protocol promises sub-agents see them), or a missing artifact
  starts emitting an error instead of being skipped.

### Plan approval gate and plan hash

- **Producers**:
  - `.pi/extensions/myflow/ask.ts` (`myflow_ask_user`) — the only writer of
    `<active task>/questions.jsonl`. It appends one row per call; a row with
    `via: "ui-select"` and a non-empty `answer` is the only thing that counts as
    "the user was asked".
  - `.pi/extensions/myflow/approval.ts` (`myflow_request_approval`) and
    `task.py approve` — the two writers of `<active task>/approval.json`, the
    user's approval of one plan revision.
- **Consumers**:
  - `task.py start` — refuses to start until a plan file exists and
    `approval.json` parses with a `plan_hash` equal to the current plan hash;
    then admits the task only when at least one choice question was answered
    (the R2 backstop).
  - `task.py gate-info` — the single read path. It returns the plan hash, the
    present plan files, and the answered-question count **together**, so no
    caller re-derives either. The TS approval tool and `/myflow-status` read
    only this.
  - `task.py validate` — reports the answered count and the approval state; it
    is a reporter, `start` is the enforcing gate.
- **Value/shape**: `approval.json` carries `plan_hash` (`sha256:<hex>`), the
  ordered list of present plan files, `approved_by` (`ui-confirm` or `cli`),
  `questions_asked`, a timestamp, and the session id. **`approved_by` is NOT a
  trustworthy field**: a hand-written file can carry either value, so it must
  never be used to distinguish a real approval from a forged one. The plan hash is computed
  by `task.py`'s `_plan_digest` over the `prd.md` / `design.md` / `implement.md`
  that exist, in that fixed order, as `filename` + NUL + raw bytes + NUL.
- **Invariant**: **exactly one plan-hash implementation**
  (`.myflow/scripts/task.py`). The TypeScript side never hashes the plan and
  never counts `questions.jsonl`; it shells out to `task.py gate-info`. Editing
  any plan file after approval makes the approval stale and re-opens the gate;
  deleting `approval.json` revokes it. The gate is a **convention reinforcement
  against forgetting to ask or approve — it is NOT a security boundary.**
- **Breaks if**: a second hash implementation or a second "answered" predicate
  appears (then one side reports "approved" while `start` refuses, with no error
  naming the root cause); `start` checks only that `approval.json` exists
  without comparing the hash; or the R2 backstop stops re-checking the answered
  count at the admitting step.
- **Honest strength (measured)**: any agent that can run `bash` can write
  `approval.json` by hand or pass `--allow-unapproved`. `task.py approve`'s
  `sys.stdin.isatty()` check does **not** stop it in this environment: Pi's bash
  tool allocates a pty, and `sys.stdin.isatty()` was measured as `True` there.
  (On Windows the check is weaker still: redirecting `< /dev/null` maps to `NUL`
  and also reports `isatty() === true`; only a **pipe** counts as non-tty.)
  A forged `approval.json` — correct `plan_hash`, `approved_by: "ui-confirm"`,
  plus a fabricated `via:"ui-select"` row — was measured to pass `start`
  outright; there is **no technical countermeasure**, only after-the-fact
  inspection.
  The gate reliably blocks *forgetting* and *skipping*; it does not stop a
  deliberate bypass. `--allow-unapproved` leaves a trace
  (`task.json.started_without_approval: true`) and prints a warning, so a
  bypass is discoverable after the fact.

### Background tasks: `myflow_bg_*`

- **Producers**:
  - `.myflow/scripts/bg_runner.mjs` — the detached wrapper. It resolves a POSIX
    shell (`resolveShellPath`), refuses with `shellRejectionReason` when none
    resolves, spawns the shell with argv (`shellArgsFor`), and writes the
    `<taskId>.exit` record itself (`writeExitRecord` / `spawnFailureRecord` /
    `shellUnavailableRecord`).
  - `.pi/extensions/myflow/background.ts` — the registry (`newTaskId`,
    `writeEntry` / `readEntry` / `listEntries`, `isAlive`, `resolveStatus`,
    `prune`, cursors) and the four tool builders (`createBgStartTool`,
    `createBgOutputTool`, `createBgListTool`, `createBgStopTool`) plus
    `registerMyflowBackground` and `BG_TOOL_NAMES`.
  - `.pi/extensions/myflow/index.ts` — registers the four tools with injected
    `deriveContextKey` / `isSubAgent` / `onStarted`, blocks them in `tool_call`
    for a sub-agent, and reports still-running tasks from `session_shutdown`.
- **Consumers**: the model (`myflow_bg_start` / `myflow_bg_output` /
  `myflow_bg_list` / `myflow_bg_stop`); `.pi/agents/*.md` tool allowlists, which
  must omit all four so a sub-agent cannot start or manage a task; the
  `tool_call` guard in `index.ts`.
- **Value/shape**:
  - Everything lives under `.myflow/.runtime/background/` (gitignored machine
    state): `<taskId>.json` (registry entry, written only by the tools, atomically
    via `.tmp` → rename), `<taskId>.log` (written by the shell's own
    `exec >> '<log>' 2>&1`), `<taskId>.exit` (written by the wrapper), and
    `cursors/<contextKey>__<taskId>.json` (`{"offset": <bytes>}`). The rename is
    retried up to 50 × 20ms on the transient Windows sharing codes (`EPERM` /
    `EACCES` / `EBUSY`, the same schedule `bg_runner.mjs` uses for `.exit`); any
    other error is thrown immediately and the `.tmp` is removed.
  - `taskId` is `bg-<base36 millisecond timestamp>-<4 hex digits>`, never derived
    from a pid (pids are reused).
  - A registry entry carries `id, command, description?, cwd, pid, log,
    exit_file, status, exit_code, started_at, ended_at,
    started_by_context_key, confirmed_by, spawn_error?`. `log` / `exit_file` are
    project-root-relative; `pid` is `0` when `spawn` reported no pid; extra
    fields are tolerated by the reader.
  - **Three reachable statuses**: `running` | `exited` | `stopped`. `unknown` is
    in the type for forward compatibility and appears only in the two refusal
    payloads (`bgOutputError`, `bgStopError`); `resolveStatus` never returns it,
    and a registry file that cannot be parsed is reported through
    `listEntries().warnings` instead of being given a status.
  - `confirmed_by` is `ui-confirm` (the user saw the exact command) or
    `no-ui-explicit` (no UI and `unattended: true` was passed). The second value
    is a recorded bypass: `myflow_bg_start` echoes it, and `myflow_bg_list`
    reports it as `unconfirmed`.
  - `<taskId>.exit`: `{exit_code, signal, at, shell}` on a normal exit (`shell`
    is always present), `+ retries` when creation was retried, and `error` only
    when the shell could not be created (`exit_code: null`, `shell` = the
    requested path) or the shell was refused (`exit_code: null`, `shell: null` or
    the rejected `cmd.exe` path, message naming the search order). A *missing
    command* is not in that list: the shell starts and exits `127` with no
    `error`.
  - Read cursors are per (session context key, task id); a missing, empty or
    corrupt cursor file reads as offset `0`, which may re-read but never skips.
- **Invariant**:
  - A present `.exit` record outranks pid liveness: the status is `exited` even
    if the pid now belongs to something else. A dead pid with no `.exit`
    self-heals to `exited` with `exit_code: null`.
  - A finished verdict is **sticky**. The precedence is fixed at five levels:
    `.exit` → `status: "stopped"` → `status: "exited"` → `isAlive(pid)` →
    self-heal to `exited`. An entry already recorded as `exited` or `stopped`
    never flips back to `running` because its pid now reads alive, so a reused
    pid can neither resurrect a task nor make `myflow_bg_stop` kill an unrelated
    process. A `.exit` record arriving later still wins over the sticky branch
    (its `exit_code` / `failure` / `signal` are the truth).
  - A failed registry write-back must not fail a listing: `myflow_bg_list`
    catches the write inside its self-heal step, still returns the resolved
    status for this call, and reports `healed` only for entries it really wrote.
  - The tools are the **only** writers of `<taskId>.json`; the wrapper writes
    only its own `.log` and `.exit`. That is what makes one-file-per-task
    lock-free and safe across sessions.
  - `myflow_bg_start` must not await any child-process event: it returns as soon
    as the entry is on disk, and the detached wrapper is the only observer of
    the exit code. It must still attach an `'error'` listener (an unhandled
    `'error'` event would crash Pi) and record `spawn_error` there.
  - `session_shutdown` **never kills a background task** — that is the point of
    the feature. It is idempotent (the `shutdownDone` flag is claimed first),
    it only reports tasks from its own `startedBackgroundIds` set, it stays
    silent when no `ctx.ui.notify` is available (that, not `hasUI`, is the
    predicate it checks), and it never throws.
  - Main session only: agent allowlists omit the four tools, `tool_call` blocks
    them for a sub-agent, and each `execute` re-checks `isSubAgent` before any
    dialog, spawn, or write.
  - The shell is resolved, never improvised: `MYFLOW_BG_SHELL` → the
    `shellPath` in `~/.pi/agent/settings.json` → the Git for Windows bash →
    `bash` on `PATH`. When nothing resolves — or it resolves to `cmd.exe` — the
    task is **refused**, and no command runs.
- **Breaks if**: a `cmd.exe` (or `/bin/sh`) fallback is added back; a descriptor
  is handed to the child instead of letting the shell redirect its own output;
  the `.exit`-before-pid or sticky-`exited`-before-pid precedence is reordered;
  `session_shutdown` starts killing tasks or loses its idempotence flag; a sub-agent allowlist gains one
  of the four tools; or `unknown` becomes a reachable status without this entry
  and the tool descriptions being updated in the same change.

**Known limits (measured/observable, not fixed):**

| Limit | Behavior |
| --- | --- |
| No `cmd.exe` fallback | A machine with no POSIX shell cannot run background tasks: the task is refused, `.exit` records `exit_code: null` + `error`, and nothing executes. This is a choice, not a defect. |
| Retry budget after a refused creation | The wrapper retries up to 8 attempts / ~7.2s (hard cap 10s) before writing `.exit`. The tool still returns immediately, but the exit status arrives that much later. |
| `stop` vs `start` window | `start` spawns before writing the entry, so a `stop` in that window reports "no such task". The window is tiny; no compensation is attempted. |
| Orphan window | If the tool crashes between `spawn` and `writeEntry`, the process runs with no registry entry and `list` cannot see it. No transactional compensation. |
| `tail` single-line exception | `tail` truncates on line boundaries; the one exception is a single line longer than `max_bytes`, which is returned as a UTF-8-aligned fragment with `truncated: true`. |
| `syswow64` not skipped | `findOnPath` skips `system32` / `sysnative` (the WSL launcher) but not `SysWOW64`, so a 32-bit view can still select it. |
| Unknown spawn errors are retried | `isRetryableSpawnError` treats an unrecognized `code` (including deterministic `ERR_*` ones) as transient, so they can wait ~7.2s before `.exit`. |
| Exit code may be `null` | A task force-stopped by `myflow_bg_stop`, or whose wrapper died, is reported `stopped` / `exited` with no code. |
| Pid reuse | Liveness is `process.kill(pid, 0)`. Two things outrank it: a present `.exit` record, and a status already recorded as `exited` / `stopped` (a finished verdict is sticky). So a reused pid can neither resurrect a finished task nor make `myflow_bg_stop` kill an unrelated process. The residual risk is narrower than that: a task whose pid is reused **before any reader ever observed it** still reads as `running`, because nothing on disk records that it died. `myflow_bg_list` additionally forces a task carrying `spawn_error` to `exited`. |
| Registry write-back can fail | A reader holding the entry open (or an unremovable `.tmp`) makes the self-heal write fail. `myflow_bg_list` still returns the resolved status for that call and does not count the entry as `healed`; the disk keeps the old status until a later write succeeds. |
| No sandbox, no resource limits | A background command runs with the current user's full permissions; the confirmation dialog is the only gate, and it is not a security boundary (`unattended: true` bypasses it, leaving `confirmed_by: "no-ui-explicit"` in the registry). CPU/memory/process count are not limited and no timeout kills a long task. |
| No log rotation | `.log` grows without bound; `prune` only deletes the files of *finished* tasks that ended more than 24 hours ago. |

The `Routing` table in `.myflow/workflow.md` names `myflow_bg_start` for
long-running commands. That is orientation, not a gate: a background task is an
execution facility the model reaches for when a command must outlive the
session, and the invariants above are what keep it honest.

## Design Decisions

### Design Decision: bound the write scope, do not try to exclude writers

- Context: sub-agents share one working tree, so two concurrent writers are the
  one thing dispatch forbids. Parallel research needs each shard to persist its
  own `research/<topic>.md`.
- Options: **(A)** keep research read-only and route persistence through a
  serial writer; **(B)** give research `write` and relax the guard by agent
  capability; **(C)** give research `write` and confine each run to a declared
  directory.
- Chosen: **(C)**. The code cannot verify that parallel prompts write *disjoint*
  files, so it shrinks the blast radius to one directory and the agent contract
  requires one topic per file. This is a **boundary** guarantee, **not mutual
  exclusion** — do not describe it as a lock.
- Revisit if: a sub-agent gains `bash` (which would write around the guard), or
  dispatch grows a way to prove disjointness.

## Gotchas

> **Gotcha**: "no declaration" and "blank declaration" mean deliberately
> different things.
>
> Happens when: an agent omits `writesUnder` versus declares it empty. Handle it
> by: reading omission as "unbounded serial writer" — `myflow-implement` and
> `myflow-check` keep full-tree access — and a blank *present* value as
> fail-closed inside the child.

> **Gotcha**: the guard compares paths **lexically**, not through `realpath`.
>
> Happens when: a symlink already inside the scope points outside it. This is
> unreachable for the current agents (no `bash`, no symlink tool), but re-check
> if an agent ever gains either.

> **Gotcha**: `hasWriteScope` and `declaresWriteScope` are not interchangeable.
>
> Happens when: gating env injection on `hasWriteScope`. That would leave an
> *unsafe* scope's writes **unbounded** instead of blocked. Injection keys off
> `declaresWriteScope` (any non-blank value); only the parallel gate uses the
> stricter `hasWriteScope`.

## Quality Check

- [ ] `node --test tests/` green (from the main session, or with the `MYFLOW_*`
      env vars cleared).
- [ ] Every copy of a changed rule was updated together: the `subagent.ts` tool
      description and error text, `.myflow/workflow.md` Dispatch Protocol,
      `harness-conventions.md`, and the `myflow-meta` / `myflow-brainstorm`
      skills. A stale rule statement anywhere is a bug.
- [ ] A new refusal path has a test that fails when the guard is reverted.
- [ ] Adding or removing a Pi hook updates **all three** copies in the same
      change: `tests/scaffold.test.ts`'s exhaustive hook set (it fails otherwise),
      the count and table in `.pi/skills/myflow-meta/SKILL.md`, and the list in
      `references/harness-conventions.md`. The count is **eight**
      (`session_start`, `input`, `before_agent_start`, `context`, `tool_call`,
      `session_before_compact`, `agent_before_settle`, `session_shutdown`); it
      read "six" over a seven-row table before this rule existed.
- [ ] The approval gate's contract copies agree: `.myflow/workflow.md`, the
      `myflow-meta` harness conventions, the `myflow-brainstorm` skill, and
      `.pi/prompts/myflow-continue.md`. No copy still describes `task.py start`
      as gated only on the context manifests.
- [ ] No agent gained `bash` without revisiting the Design Decision above.
- [ ] Changing the shell resolution (`resolveShellPath` /
      `shellRejectionReason` / `shellArgsFor`) or the `<taskId>.exit` shape was
      mirrored into the `myflow_bg_start` tool description, the "Background
      tasks" contract above, and `harness-conventions.md` in the same change.
