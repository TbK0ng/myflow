# Changelog

One section per release the payload build produces (`tools/release.py` reads the
version from `package.json`; a release is a directory `myflow-<version>/` plus a
reproducible zip). Dates are the tag dates.

## Unreleased

### Changed

- **Windows only, with Git Bash.** Every non-win32 code path is deleted rather
  than kept "just in case": the shell resolver has no `platform` parameter, a
  tree dies by `taskkill /F /T`, a worker is spawned with `DETACHED_PROCESS |
  CREATE_NEW_PROCESS_GROUP`, and path comparison always folds case. The
  extension, the background wrapper, `channel.py` and `worktree.py` refuse to
  start on any other platform.

### Added

- Types are checked: `typescript` and `@types/node` are real dependencies,
  `npm run typecheck` is the gate, and `npm run check` runs it before the suite.
  The first run fixed a wrong `Dirent` type in agent discovery and made
  `HookContext` match Pi's own `ui.notify` signature.
- CI on `windows-latest`: the single supported platform, typecheck then suite.
- `engines: node >= 22`, which is what stripping types in the test suite needs.
- This changelog.

### Fixed

- Documentation named `node --test tests/`, which Node 24 rejects (the argument
  is a file glob, not a directory). Every occurrence now names `npm test` or
  `npm run check`.

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
