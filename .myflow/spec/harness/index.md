# Harness Spec

Rules for changing the myflow harness: `.pi/extensions/myflow/`, `.pi/agents/`,
`.pi/skills/`, `.myflow/scripts/`, and `.myflow/workflow.md`.

Payload tour and inventory:
`.pi/skills/myflow-meta/references/harness-conventions.md`.

## Pre-Development Checklist

- [ ] Run `npm run check` (typecheck, then the suite) with the `MYFLOW_*` env
      vars scrubbed. Every process that runs the suite scrubs them first; a
      check sub-agent must, because it is the one that has to run it. The suite
      is not hermetic w.r.t. `MYFLOW_AGENT_TYPE` / `MYFLOW_CONTEXT_ID`: when
      those leak in, unrelated tests fail because the extension sees itself as a
      sub-agent. Clear them before believing a failure:
      `env -u MYFLOW_AGENT_TYPE -u MYFLOW_CONTEXT_ID -u MYFLOW_SKIP_BREADCRUMB -u MYFLOW_WRITES_UNDER npm run check`
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
      is the only writer of `<id>.log`, `<id>.exit`, and `<id>.pid`; the tools
      are the only writer of `<id>.json`. A change to the `.pid` handshake (its
      timing, payload, or who reads it) touches `writePidRecord`,
      `readPidFile` / `readPid`, and this spec in the same change.

## Contracts

### Platform: Windows only

- **Producers**: one guard per entry point — `.pi/extensions/myflow/index.ts`
  (throws at load), `.myflow/scripts/bg_runner.mjs` (records a refusal in
  `<taskId>.exit`), `.myflow/scripts/channel.py` and `.myflow/scripts/worktree.py`
  (exit 1 with a message).
- **Invariant**: one code path. No `process.platform` / `os.name` branch
  survives outside those guards: the shell is the Git for Windows bash, a tree
  is killed with `taskkill /F /T`, a worker is spawned with `DETACHED_PROCESS |
  CREATE_NEW_PROCESS_GROUP`, and path comparison folds case (NTFS does).
- **Breaks if**: a cross-platform branch is reintroduced "just in case". It can
  never run here, so it is untested code that reads as a supported platform.

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
  - `.myflow/scripts/bg_runner.mjs` — the detached wrapper. It writes its own
    `<taskId>.pid` handshake first (`writePidRecord`), resolves the shell
    (`resolveShellPath`: `MYFLOW_BG_SHELL` → the settings `shellPath` → the Git
    for Windows bash → `bash` on `PATH`, skipping the WSL launcher), refuses with
    `shellRejectionReason` when none resolves, spawns the shell with argv
    (`shellArgsFor`), and writes the `<taskId>.exit` record itself
    (`writeExitRecord` / `spawnFailureRecord` / `shellUnavailableRecord`).
  - `.pi/extensions/myflow/background/` — `registry.ts` holds the tools' on-disk
    layer (`newTaskId`,
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
    `exec >> '<log>' 2>&1`), `<taskId>.exit` (written by the wrapper),
    `<taskId>.pid` (the handshake, written by the wrapper),
    and `cursors/<contextKey>__<taskId>.json` (`{"offset": <bytes>}`). The rename is
    retried up to 50 × 20ms on the transient Windows sharing codes (`EPERM` /
    `EACCES` / `EBUSY`, the same schedule `bg_runner.mjs` uses for `.exit`); any
    other error is thrown immediately and the `.tmp` is removed.
  - `taskId` is `bg-<base36 millisecond timestamp>-<4 hex digits>`, never derived
    from a pid (pids are reused).
  - A registry entry carries `id, command, description?, cwd, pid, log,
    exit_file, status, exit_code, started_at, ended_at,
    started_by_context_key, confirmed_by, spawn_error?`. `log` / `exit_file` are
    project-root-relative. `cwd` is the **resolved absolute** directory the
    command runs in (R5), always inside the project root. `pid` is a cache of
    what `spawn` returned: the entry is written with `pid: 0` **before** the
    spawn and backfilled afterwards, so `0` means "no pid confirmed yet", never
    "pid 0". **No reader trusts it directly** — every one goes through
    `readPid`. Extra fields are tolerated by the reader.
  - **Four reachable statuses**: `starting` | `running` | `exited` | `stopped`.
    `unknown` is in the type for forward compatibility and appears only in the
    two refusal payloads (`bgOutputError`, `bgStopError`); `resolveStatus` never
    returns it, and a registry file that cannot be parsed is reported through
    `listEntries().warnings` instead of being given a status.
  - `<taskId>.pid` is the wrapper's handshake: `{"pid": N, "at": "<ISO>"}`,
    written atomically (`.tmp` → rename, the same 50 × 20ms retry on
    `EPERM` / `EACCES` / `EBUSY` as `.exit`) by the process whose pid it names.
    It is written **after `parseArgs` succeeds and before the shell is resolved,
    the log directory created, or the command executed** — so a command can
    never run unless a pid was recorded first. A write failure is fatal *for the
    command* (fail-closed): the wrapper writes an `.exit` naming the failure and
    runs nothing. The path is an explicit `--pid` argument; nothing derives it.
    The file existing means "the wrapper was alive", not "the command runs"
    (a refused shell also leaves one). `prune` deletes it with the entry.
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
  - `ExitRecord` in `background/registry.ts` admits those fields (`shell?: string | null`,
    `retries?: number`) so a reader does not need a cast. There is exactly one
    consumer: **`myflow_bg_output` attaches `shell` and `retries` only for a
    finished task** (a `.exit` record exists). `shell` is included even when it
    is `null` (a recorded refusal is a fact); `retries` is omitted entirely when
    the field is absent — never `0`, never `undefined`.
  - Read cursors are per (session context key, task id); a missing, empty or
    corrupt cursor file reads as offset `0`, which may re-read but never skips.
  - `myflow_bg_output` `mode: "tail"` truncates on line boundaries, so it never
    returns half a line. The one exception is a single line longer than
    `max_bytes`: dropping it would return nothing, so the UTF-8-aligned fragment
    is returned with `truncated: true`. A delta cursor past the file end means a
    rotated/recreated log, so it restarts at `0` and sets `reset: true`.
  - Creation of the command's process is retried on a bounded backoff (up to 8
    attempts / ~7.2s, hard cap 10s) and only for a *transient* refusal; a
    deterministic failure is recorded immediately. The wrapper still returns
    immediately to the tool, which never waits for any of this — the exit status
    merely arrives later.
- **Invariant**:
  - A present `.exit` record outranks pid liveness: the status is `exited` even
    if the pid now belongs to something else. A dead pid with no `.exit`
    self-heals to `exited` with `exit_code: null`. `exit_code` is therefore
    nullable everywhere: a task force-stopped by `myflow_bg_stop`, or one whose
    wrapper died, is reported `stopped` / `exited` with no code.
  - A finished verdict is **sticky**. `resolveStatus` has a fixed
    precedence: `.exit` → `status: "stopped"` → `status: "exited"` →
    `isAlive(readPid(...))` → `starting` while the entry is at most
    `STARTING_TIMEOUT_MS` (60s) old → self-heal to `exited` with
    `exit_code: null`. An entry already recorded as `exited` or `stopped` never
    flips back to `running` because its pid now reads alive, so a reused pid can
    neither resurrect a task nor make `myflow_bg_stop` kill an unrelated
    process. A `.exit` record arriving later still wins over the sticky branch
    (its `exit_code` / `failure` / `signal` are the truth). Level 4 outranks
    level 5 on purpose: once a pid is confirmed alive the task is `running`, even
    if the entry still says `starting`, so `stop` can address it.
  - **The pid has one source**: `readPid(dir, entry)` = `<taskId>.pid`'s positive
    integer, else the entry's `pid`, else `0`. The handshake is authoritative
    because the wrapper writes it about itself before running anything; the
    entry's `pid` is only the tool's cache and may still be `0`. `resolveStatus`,
    `myflow_bg_stop`, `myflow_bg_list`'s rows, and `session_shutdown` all use it.
  - **`starting` is a state, not a flag.** `myflow_bg_start` writes the entry as
    `status: "starting"`, `pid: 0` *before* spawning and backfills `pid` +
    `running` before returning, so the only window in which a reader sees
    `starting` is "entry on disk, handshake not yet landed". `myflow_bg_output`
    returns it normally (the log may be empty; it is not an error),
    `myflow_bg_list` shows it as a row and persists the self-heal, and
    `myflow_bg_stop` **refuses** it with an explicit "not addressable yet, retry"
    error — no kill, no `stopped` write, never `terminate(0)` (pid 0 would mean
    the whole process group). Once `.pid` appears the same task stops normally.
    A live pid also outranks the 60s timeout for `prune` (`isFinished` checks it
    first): a `starting` entry whose `.pid` names a live process *did* start, so
    it is retained with its log and handshake rather than reaped as a residue.
  - **`cwd` is confined to the project root** (ADR-9), the same posture as
    `writesUnder`: a relative value resolves against the root, an absolute value
    is accepted only inside it, and containment is decided **by path segment,
    case-insensitively on Windows, with `..` collapsed** by the shared
    `isWithinWriteScope` / `normalizeWriterPath` from `agents.ts` (imported, not
    copied). The directory must already exist and be a directory. Validation
    happens **before** the confirmation dialog, so a refusal produces no dialog,
    no registry entry, and no spawn. The dialog always shows the resolved
    directory — including when it equals the project root — because a shell makes
    a relative command mean something different in every directory. The entry
    records the absolute path and the wrapper receives it as `--cwd` (a missing
    `--cwd` value is a hard error, never "the wrapper's own cwd").
  - A failed registry write-back must not fail a listing: `myflow_bg_list`
    catches the write inside its self-heal step, still returns the resolved
    status for this call, and reports `healed` only for entries it really wrote.
  - The tools are the **only** writers of `<taskId>.json`; the wrapper writes
    only its own `.log`, `.exit`, and `.pid`. That is what makes
    one-file-per-task lock-free and safe across sessions.
  - `myflow_bg_start` must not await any child-process event: it returns as soon
    as the entry is on disk, and the detached wrapper is the only observer of
    the exit code. It must still attach an `'error'` listener (an unhandled
    `'error'` event would crash Pi) and record `spawn_error` there.
  - `session_shutdown` **never kills a background task** — that is the point of
    the feature. It is idempotent (the `shutdownDone` flag is claimed first),
    it only reports tasks from its own `startedBackgroundIds` set, it never
    throws, and it notifies only when **`ctx.hasUI !== false` and a
    `ctx.ui.notify` function exists**. An explicit `hasUI: false` means silence
    even if the host still handed us a `notify`; an absent `hasUI` counts as
    "there is a UI".
  - Main session only: agent allowlists omit the four tools, `tool_call` blocks
    them for a sub-agent, and each `execute` re-checks `isSubAgent` before any
    dialog, spawn, or write.
  - The shell is resolved, never improvised: `MYFLOW_BG_SHELL` → the
    `shellPath` in `~/.pi/agent/settings.json` → the Git for Windows bash →
    `bash` on `PATH`. When nothing resolves — or it resolves to `cmd.exe` — the
    task is **refused**, and no command runs.
- **Breaks if**: a `cmd.exe` (or `/bin/sh`) fallback is added back, or
  `findOnPath` stops skipping **all three** WSL-launcher views (`system32`,
  `sysnative`, `syswow64`); `isRetryableSpawnError` starts retrying Node's
  deterministic `ERR_*` codes (or stops retrying `EAGAIN` / `ENOMEM` / `EMFILE` /
  `ENFILE` and unknown/no-code errors); a descriptor is handed to the child
  instead of letting the shell redirect its own output; a command can run
  without `<taskId>.pid` first (the orphan window reopens); the
  `.exit`-before-pid, sticky-`exited`-before-pid, or `isAlive`-before-`starting`
  precedence is reordered; `cwd` is accepted without the project-root
  containment test or is not shown in the confirmation dialog; `session_shutdown`
  starts killing tasks, loses its idempotence flag, or decides "no UI" from the
  presence of `notify`; a sub-agent allowlist gains one of the four tools; or
  `unknown` becomes a reachable status without this entry and the tool
  descriptions being updated in the same change.

**Known limits (measured/observable, deliberately not fixed):**

| Limit | Behavior |
| --- | --- |
| Pid identity | Liveness is `process.kill(pid, 0)`. Two things outrank it: a present `.exit` record, and a status already recorded as `exited` / `stopped` (a finished verdict is sticky). So a reused pid can neither resurrect a finished task nor make `myflow_bg_stop` kill an unrelated process. The residual risk is a task whose pid is reused **before any reader ever observed it**: nothing on disk records that it died, so the first read still says `running`. Proving identity needs an OS-level process-creation time (WMI on Windows, `/proc` on POSIX); that is only worth paying inside `stop`, never on `list`'s hot path, so it is deferred to its own task instead of being approximated here. `myflow_bg_list` additionally forces a task carrying `spawn_error` to `exited`. |
| No log rotation | `.log` grows without bound; `prune` only deletes the files of *finished* tasks that ended more than 24 hours ago. The retention policy is undecided: truncating loses history, rolling adds a naming contract, so neither is chosen here. |
| No sandbox, no resource limits | A background command runs with the current user's full permissions; the confirmation dialog is the only gate, and it is not a security boundary (`unattended: true` bypasses it, leaving `confirmed_by: "no-ui-explicit"` in the registry). CPU/memory/process count are not limited and no timeout kills a long task. This belongs to the permission system, not to the background-task feature. |

The `Routing` table in `.myflow/workflow.md` names `myflow_bg_start` for
long-running commands. That is orientation, not a gate: a background task is an
execution facility the model reaches for when a command must outlive the
session, and the invariants above are what keep it honest.

### Front runs: the registry, `stale`, and the control channel

A dispatched run is no longer only a log file. Three on-disk contracts make it
visible and steerable from *any* session in the project:

| Path | Contract |
| --- | --- |
| `.myflow/.runtime/subagents/<runId>.json` | one entry per run: `runId`/`group`/`index`/`total`, `agent`, `mode`, `prompt`, `status`, `startedAt`/`endedAt`/`heartbeatAt`, `pid`, `owner{contextKey,pid}`, `logPath`, `task`, `steers[]` |
| `.myflow/.runtime/subagents/<runId>.ctl.jsonl` | append-only commands `{"type":"steer","message"}` / `{"type":"abort"}`; the dispatcher polls it every 1s and deletes it on settle |
| `.myflow/.runtime/subagent-logs/<agent>-<ts>.log` | unchanged: the raw rpc stream, still the only source of transcript text |

- **Settle is `agent_settled`, never the process exiting.** A child that leaves
  after a turn has *not* finished: retries, compaction recovery and steering can
  still follow. `agent_end` is likewise not a settle signal.
- **Every wait is bounded.** prompt accepted ≤10s, abort grace 5s, exit grace
after `stdin.end()` 5s, and each ends in `clearTimers()` + exactly one terminal
  write (`isSettled` guard) + ctl removal + temp-prompt removal.
- **`running` is believed, `stale` is inferred.** A reader never probes pids: a
  `running` entry whose `heartbeatAt` is older than `STALE_AFTER_MS` (30s, while
  the dispatcher beats every 1s) renders as `stale`. The `x` key is the only
  place that pays for a real `taskkill /T /F` on the recorded pid.
- **The dispatcher must not overwrite a board-recorded `stopped`.** A board `x`
  kills at once, possibly before the dispatcher polled the abort line, so
  `finalize` re-reads the entry and keeps `stopped` + its reason instead of
  rewriting it `failed` / `"unexpected exit"`.
- **Two writers, one append-only file.** Steering is safe because the ctl file
  is never rewritten: each session appends its own line, the dispatcher dedupes
  by command `id` and forwards in file order. The registry's `steers[]` is a
  display copy, not the transport.
- **Unchanged by all of this**: the `MYFLOW_AGENT_TYPE` / `MYFLOW_CONTEXT_ID` /
  `MYFLOW_WRITES_UNDER` env trio, `--append-system-prompt` / `--tools` /
  `--model`, and the log path. `exitCode` is now informational only —
  `isFailedResult` reads `stopReason` / `errorMessage`.
- **Display order is liveness first, then recency.** `listRuns` sorts by group:
  a group with any non-terminal member first, then newest group first; members
  keep `index` order so a chain still reads `1..n`. Recency comes from the
  group's `g-<epoch>` prefix (shared by its members), *not* from `startedAt` —
  a run that was marked running later must not split its own group apart.
- **A pruned run takes its log with it; a forgotten one does not.** `pruneRuns`
  (called once per `/mysubagents` open) deletes the entry, its control file, and
  its log, then sweeps log files no surviving entry references once they are past
  the same 24h cutoff. `d` keeps the log on purpose — it is the transcript a human
  may still want — and the sweep is what finally reclaims it. Without this a
  registry of 8 runs left **91 MB** of orphaned transcripts behind.
- **A live run or task cannot be deleted, only stopped.** `deleteRun` /
  `deleteFinishedTask` refuse anything not finished, because a dispatcher still
  writes that entry and the next transition would resurrect the row the user
  just removed (a background task additionally uses the `.pid` handshake, so a
  leftover pid file cannot be mistaken for a live command). `deleteFinishedRuns`
  and `deleteFinishedTasks` are the manual prunes; a front run's log survives
  deletion, a background task's log goes with it, matching each feature's own
  `prune`. `board` produces neither (it is read-only).
- **Breaks if**: settle goes back to process exit or `agent_end`; a wait loses
  its cap; the reader starts probing pids per row; `x` is implemented by writing
  only a terminal status (nothing would be killed); `ctl` is ever rewritten or a
  half-written trailing line is consumed; `MYFLOW_*` is injected from anywhere
  other than the dispatcher; or the board claims a stop succeeded without the
  child being gone.

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
- Revisit if: dispatch grows a way to prove disjointness.

## Gotchas

> **Gotcha**: the shipped tree is English, the tests are not (yet).
>
> Everything that ships — comments, docs, tool descriptions, dialog text — is
> English. The test files still carry Chinese prose and assertion messages from
> when they were written, and translating them is churn that proves nothing.
> New test prose is English, so the two converge instead of drifting apart; do
> not add a second language to the shipped tree to match an old test.

> **Gotcha**: "no declaration" and "blank declaration" mean deliberately
> different things.
>
> Happens when: an agent omits `writesUnder` versus declares it empty. Handle it
> by: reading omission as "unbounded serial writer" — `myflow-implement` and
> `myflow-check` keep full-tree access — and a blank *present* value as
> fail-closed inside the child.

> **Gotcha**: the guard compares paths **lexically**, not through `realpath`,
> and it only bounds `write` / `edit`.
>
> Happens when: a symlink already inside the scope points outside it, or an
> agent writes through the shell. `myflow-implement` and `myflow-check` both
> declare `bash`, which can write around the lexical check by design. The scope
> is a blast-radius boundary, **not a sandbox**; do not count on it to contain
> `bash`.

> **Gotcha**: `hasWriteScope` and `declaresWriteScope` are not interchangeable.
>
> Happens when: gating env injection on `hasWriteScope`. That would leave an
> *unsafe* scope's writes **unbounded** instead of blocked. Injection keys off
> `declaresWriteScope` (any non-blank value); only the parallel gate uses the
> stricter `hasWriteScope`.

> **Gotcha**: a child pipe's `error` event is asynchronous and crashes the host.
>
> Happens when: writing a steer/abort to a child that has already exited
> (`EPIPE`), or a log `createWriteStream` failing on a full disk. A `try`/`catch`
> around `write()` cannot catch it — Node raises `error` on the stream. Every
> child stdio stream and every log stream needs an `error` listener; the probe
> that found this killed the whole session.

> **Gotcha**: running the full suite inside a myflow sub-agent fails 11–23 tests.
>
> Happens when: a `myflow-implement` / `myflow-check` sub-agent runs `npm test`.
> The child inherits `MYFLOW_AGENT_TYPE`, so the extension tests see a sub-agent
> session and the dispatch/background guards refuse what the tests expect.
> Handle it by `env -u MYFLOW_AGENT_TYPE -u MYFLOW_CONTEXT_ID -u PI_SESSION_ID -u MYFLOW_WRITES_UNDER npm test`
> (a plain terminal has none of them) — and never "fix" those tests to match.

> **Gotcha**: `rmSync` on a killed child's directory needs a short await loop.
>
> Happens when: a run settles before its child exits, so the first `rmSync` hits
> `EPERM`. `maxRetries` with Node's backoff just burns the timeout and then
> gives up, leaving `%TEMP%/myflow-*` behind on every case (134 accumulated
> before this was noticed). Await the death in a tight retry loop, and keep the
> prefix in `tests/leak-audit.test.ts`'s audited list.

> **Gotcha**: the panel re-reads both registries every second, so a key's effect
> must survive a refresh.
>
> Happens when: a key changes what is selected. `refresh()` re-locates the cursor
> from an anchor, so the anchor has to describe the row the cursor moved *to* —
> `selectionAnchor(state, ...)` reads `state.selection`, i.e. the row it came
> *from*, and the refresh then silently undoes every move (this shipped once: the
> cursor looked dead while every key was handled). Anchor against the new
> selection, and keep a test that presses an arrow and asserts the marked row
> changed.

> **Gotcha**: `myflow_subagent` resolves the project root as `ctx.cwd`, not
> `findProjectRoot(ctx.cwd)`.
>
> Happens when: dispatching from a subdirectory. `subagent.ts`'s `runOptions`
> passes `projectRoot: ctx.cwd` into `runsDir(ctx.cwd)` and
> `resolveActiveTaskStatus(ctx.cwd, …)`, and a path built from a subdirectory
> lands under `<subdir>/.myflow/.runtime/` (the writer `mkdirSync`s it), so
> `/mysubagents` — which reads the real root — cannot see or steer that run, and
> the registry's `task` field comes out `null`. Every other entry point
> (`index.ts`, `ask.ts`, `approval.ts`, `board/index.ts`, `background/*`) calls
> `findProjectRoot` first. Until that one call site is changed, keep dispatches
> at the project root.

## Quality Check

- [ ] No shipped file (extension, scripts, docs, skills) contains non-English
      prose or user-facing text; the tests are the only allowed exception.
- [ ] `npm run check` green (from the main session, or with the `MYFLOW_*`
      env vars cleared) — locally and in CI (`.github/workflows/ci.yml`, the one
      supported platform, `windows-latest`).
- [ ] Every copy of a changed rule was updated together: the `subagent.ts` tool
      description and error text, `.myflow/workflow.md` Dispatch Protocol,
      `harness-conventions.md`, and the `myflow-meta` / `myflow-brainstorm`
      skills. A stale rule statement anywhere is a bug.
- [ ] A new refusal path has a test that fails when the guard is reverted.
- [ ] Adding or removing a Pi hook updates, in the same change, the canonical
      table in `.pi/skills/myflow-meta/SKILL.md` and the list in
      `references/harness-conventions.md`. `tests/scaffold.test.ts` compares both
      against the handlers the copied extension actually registers, so it fails
      until they follow. No other file states a hook count; `myflow-check`
      points at the table.
- [ ] A new config key read by `.pi/extensions/myflow/` or `.myflow/scripts/` is
      added to the Config Keys table in
      `.pi/skills/myflow-meta/references/harness-conventions.md` in the same
      change. A `channel.worker_guard` key also updates the `myflow-channel`
      skill.
- [ ] The approval gate's contract copies agree: `.myflow/workflow.md`, the
      `myflow-meta` harness conventions, the `myflow-brainstorm` skill, and
      `.pi/prompts/myflow-continue.md`. No copy still describes `task.py start`
      as gated only on the context manifests.
- [ ] An agent that gains `bash` or unbounded `write` re-opens the Design
      Decision above. The `writesUnder` guard bounds `write`/`edit` lexically;
      `bash` writes around it by design, so a write scope is a blast-radius
      boundary, never a sandbox.
- [ ] Changing the shell resolution (`resolveShellPath` /
      `shellRejectionReason` / `shellArgsFor`), the `<taskId>.exit` shape, or the
      `<taskId>.pid` handshake was mirrored into the `myflow_bg_start` tool
      description, the "Background tasks" contract above, and
      `harness-conventions.md` in the same change.
- [ ] The reachable-status count is **four** (`starting`, `running`, `exited`,
      `stopped`). Adding a state means updating `BackgroundTaskStatus`,
      `resolveStatus`, `myflow_bg_list` / `myflow_bg_output` / `myflow_bg_stop`,
      the tool descriptions, and this entry — all together.
- [ ] A number that a shipped doc states and the code defines has **one** home.
      Restating a count in prose is a bug; pointing at the canonical place is
      the fix. `tests/doc-numbers.test.ts` pins the cross-language pairs that
      cannot share a home (the Config Keys table, `STARTING_TIMEOUT_MS`,
      `PRUNE_AFTER_MS`).
- [ ] A test that waits for a Windows tree kill **polls to a deadline**; a fixed
      `setTimeout` under-waits on a loaded machine and slows every run down.
      `waitForProcessGone` in `tests/subagent.test.ts` is the pattern.
