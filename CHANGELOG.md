# Changelog

One section per release the payload build produces (`tools/release.py` reads the
version from `package.json`; a release is a directory `myflow-<version>/` plus a
reproducible zip). Dates are the tag dates.

## Unreleased

### Added

- **`/mysubagents`**: one panel over every dispatched run and every detached
  background task. `board` is read-only (front runs in accent, background tasks
  in warning, Enter opens a transcript/output viewer); `tree` groups runs by the
  dispatch call that produced them and can stop a run, cancel a group, steer it
  with one line, or rerun it; `background` can stop, prune finished entries, or
  replay a command. `npm` has no new dependencies and `pi-subagents-lite` is not
  involved.

### Changed

- **A sub-agent run is now a long-lived rpc child** (`pi --mode rpc`), not a
  one-shot `-p --mode json` process: it settles on `agent_settled`, closes stdin
  for an orderly exit, and is killed by tree when it ignores that. The reason is
  steering — the same change is what lets a run be redirected while it works.
- **Every run writes `.myflow/.runtime/subagents/<runId>.json`** (agent, mode,
  group, status, heartbeat, steers, log path), which is what makes a run visible
  to another session instead of only as a log file name. A run whose dispatcher
  died is reported `stale` rather than `running` forever.
- **A run can be steered or aborted through `<runId>.ctl.jsonl`**, appended by
  the board and forwarded by the dispatcher's poll loop; this is the only path
  that works when the dispatching session is blocked inside its own tool call.

### Refactored

- The background tools' cores are now exported (`startBackgroundTask`,
  `stopBackgroundTask`, `readLogTail`) so the panel and the tools share one
  implementation; the `myflow_bg_*` behavior is unchanged (their tests ran
  untouched).

## 0.3.0 — 2026-10-27

### Changed

- **Windows only, with Git Bash.** Every non-win32 code path is deleted rather
  than kept "just in case": the shell resolver has no `platform` parameter, a
  tree dies by `taskkill /F /T`, a worker is spawned with `DETACHED_PROCESS |
  CREATE_NEW_PROCESS_GROUP`, and path comparison always folds case. The
  extension, the background wrapper, `channel.py` and `worktree.py` refuse to
  start on any other platform.
- **Every shipped skill was checked against the code it describes.** A parallel
  audit of the eight skills found prose that had drifted: the hook count lived in
  four unguarded copies (now one table, compared against the registered handlers
  by `tests/scaffold.test.ts`), the Config Keys table omitted the two
  `channel.worker_guard` keys, the skill map listed 9 of 12 `task.py` subcommands,
  two skills told an agent to run the suite unscrubbed inside a sub-agent, and
  brainstorm's create snippet and phase map no longer matched the code or
  `workflow.md`. Counts that can drift were deleted from prose rather than
  duplicated again.
- **The verify gate runs something.** `.myflow/worktree.yaml` now names the
  suite, and the `agent_before_settle` child gets a `MYFLOW_*`-free environment.
  Before this, a project without that file silently passed the gate, and a check
  agent inside one inherited its own env into the suite.
- **`done` is gone from the documented status set.** `task.py` only ever wrote
  `planning` / `in_progress`, and `archive` rewrites to `completed`.

### Added

- Types are checked: `typescript` and `@types/node` are real dependencies,
  `npm run typecheck` is the gate, and `npm run check` runs it before the suite.
  The first run fixed a wrong `Dirent` type in agent discovery and made
  `HookContext` match Pi's own `ui.notify` signature.
- CI on `windows-latest`: the single supported platform, typecheck then suite.
- `engines: node >= 22`, which is what stripping types in the test suite needs.
- This changelog.
- `tools/release.py --release {patch|minor|major} [--yes] [--dry-run]`: bump,
  date the changelog, check, build, verify, commit, tag and (with `--yes`) push.
- `.myflow/spec/guides/`: the cross-cutting layer of the spec tree, restored
  after a rewrite dropped its definition, with a doc-drift guide behind it.
- Guards for the drift class this release fixes: a `.myflow/spec/` path named in
  an instruction file must exist, the `32768` injection default must agree across
  TypeScript and Python, and the verify child must not inherit `MYFLOW_*`.

### Fixed

- Documentation named `node --test tests/`, which Node 24 rejects (the argument
  is a file glob, not a directory). Every occurrence now names `npm test` or
  `npm run check`.
- `channel.py`'s docstring pointed at `~/.myflow/channels`; the store is
  `~/.pi/myflow/channels`.
- The stopped-run test slept a fixed 1.5s for a Windows tree kill and failed
  about one run in seven; it now polls to a deadline.

## 0.2.0 - 2026-10-21

### Added

- A reproducible release: one payload manifest (`tools/release-payload.json`),
  one build script (`tools/release.py --check | --out | --verify`), and
  `INSTALL.md` for the person installing it.
- Background tasks: four `myflow_bg_*` tools, a detached wrapper that records
  its own exit code, a pid handshake that closes the orphan window, and a
  registry that self-heals after a crash.
- The plan approval gate: `myflow_ask_user`, `myflow_request_approval`, a plan
  hash with one implementation (`task.py`), and a start that refuses stale or
  unapproved plans.
- The channel runtime (`channel.py`) for peer workers, and worktree sessions
  (`worktree.py`) for parallel tasks in separate checkouts.

### Fixed

- A background task never runs when no usable shell resolves; `cmd.exe` is
  refused rather than driven as if it were a POSIX shell.
- The test suite provably leaves no temporary directories behind (`leak-audit`).

## 0.1.0 - 2026-10-14

### Added

- The harness itself: the Pi extension and its hooks, `myflow_subagent`
  dispatch, the task lifecycle scripts, and per-turn workflow-state injection.
