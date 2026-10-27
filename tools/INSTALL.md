# Installing the myflow payload into another project

This file ships **inside** a release (`myflow-<version>/INSTALL.md`). It is for
the person installing it — it is not part of the payload, so do not copy it (or
`RELEASE.md`) into the target project.

The release directory contains the whole harness:

```
.pi/                            the Pi extension, 3 agents, 3 prompts, 8 skills
.myflow/agents/                 channel-runtime worker definitions (architect, reviewer)
.myflow/scripts/                5 scripts: task.py, get_context.py, worktree.py, channel.py, bg_runner.mjs
.myflow/spec/                   the harness's own specification: index, harness/, guides/
.myflow/workflow.md             phases, routing, and the per-turn workflow-state blocks
.myflow/worktree.template.yaml  the worktree + verify config template, with no project commands
```

Nothing machine-specific rides along: no `.myflow/.runtime/`, no task history,
no absolute paths, and no `verify:` command that only exists here.

The payload has **no runtime dependencies**: the extension imports Node built-ins
only, Pi strips the TypeScript itself, and the scripts are Python 3 plus one
`.mjs`. There is nothing to `npm install`.

**Windows only.** The harness runs on Windows with Git Bash: the background
tools need a POSIX shell and `taskkill`, the channel runtime and the worktree
sessions use `DETACHED_PROCESS` / `taskkill`, and the path guards assume NTFS
case folding. Every entry point refuses to start anywhere else.

Prerequisites: a **git repository** (the harness reads git state and its worktree
sessions are git worktrees), `python3` on `PATH`, Node.js 22 or newer, and Git for
Windows.

## 1. Copy the payload

Unpack the zip, then copy from the release directory into the target project
root, from Git Bash:

```bash
REL=/c/src/myflow-<version>        # replace <version>: wherever you unpacked it
DST=/c/work/target-project

mkdir -p "$DST/.myflow"
cp -r "$REL/.pi" "$DST/"
cp -r "$REL/.myflow/agents" "$REL/.myflow/scripts" "$REL/.myflow/spec" "$DST/.myflow/"
cp "$REL/.myflow/workflow.md" "$DST/.myflow/"
cp "$REL/.myflow/worktree.template.yaml" "$DST/.myflow/worktree.yaml"
```

Then edit `.myflow/worktree.yaml` and replace `verify:` with the target project's
own check command. The template ships with
`python3 .myflow/scripts/task.py current`, which only proves the harness runs;
the settle gate executes that list after a `myflow-check` sub-agent, so a project
that never edits it gets a gate that checks nothing.
```

Why a copy and not a symlink: the payload is meant to be edit-in-place once a
project decides to change harness behavior, and a symlink makes that edit land
in the wrong repository.

## 2. Do **not** copy these

| Path | Why not |
| --- | --- |
| `.myflow/tasks/`, `.myflow/archive/` | One project's deliverables. They reference paths and history that do not exist in the target. |
| `.myflow/.runtime/` | Machine state (session pointers, worktree registry, background tasks, worker logs). Copying it points sessions at tasks that are not there. |
| `.myflow/config.yaml` | Absent on purpose: this repository runs on the built-in defaults. Create one in the target only when an injection budget, the skip keyword, or channel trust has to change. |
| `tests/`, `package.json`, `tsconfig.json` | Harness development only — they run `node --test` against the harness's own source. Not needed to use the payload. |
| `tools/` | Harness development only: the release manifest (`release-payload.json`), the build script (`release.py`), and this file. |
| `INSTALL.md`, `RELEASE.md` | Instructions for the installer, not runtime files. |

| `.myflow/worktree.yaml` | The live verify config; the release carries `.myflow/worktree.template.yaml` instead. Copy that one into place and edit its `verify:` list. |

`.gitattributes`: if the target pins line endings, add `* text=auto eol=lf` so the
shipped Markdown and scripts stay LF — several harness tests and prompts compare
raw file content.

## 3. Let Pi load it

No configuration is needed. Pi discovers `.pi/extensions/`, `.pi/skills/`, and
`.pi/prompts/` from the project root; the extension lives in the subdirectory
`.pi/extensions/myflow/`, whose `index.ts` is the entry point Pi loads.

The only thing Pi asks for is **project trust**: because the target project now
contains `.pi/extensions`, Pi prompts once on startup to trust the folder's Pi
resources. Accept it — declining skips `.pi/extensions`, `.pi/skills`, and
`.pi/prompts` and the harness does nothing.

Then start (or `/reload`) Pi and run `/myflow-status`. It should print
`myflow: no_task`, `Task:   none`, plus git state; that single command proves
the extension loaded, the command registered, and the scripts are reachable.

One requirement: the extension shells out to `python3` (`gate-info`, the verify
gate), so a working `python3` must be on `PATH` — install Python with the
`python3` shim, or point a `python3` wrapper at your interpreter. Without it
`/myflow-status` still renders but reports `Approval: unavailable`.

## 4. Lines the target `.gitignore` needs

```gitignore
.myflow/.runtime/     # required: session pointers, background tasks, worker logs
__pycache__/          # recommended: the scripts are Python
dist/                 # only if you also build releases in this project
```

`.myflow/.runtime/` is not optional: a tracked runtime directory pollutes every
diff and makes parallel worktree copies collide with untracked files.

## 5. First smoke test

```bash
# in the target project root; `python3` (also what the extension invokes)
python3 .myflow/scripts/task.py current       # -> no active task
python3 .myflow/scripts/get_context.py        # -> contains [workflow-state:no_task]
                                              #    and "## Session Runtime Context"
```

And in Pi: `/myflow-status`.

If `task.py current` reports `active task path missing: ...`, this project
inherited a session pointer — delete `.myflow/.runtime/sessions/` and retry.

## 6. Create the first task

```bash
python3 .myflow/scripts/task.py create "First task" --slug first
```

Then `/myflow-brainstorm` writes the plan (`prd.md` / `design.md` /
`implement.md`) into `.myflow/tasks/first/`, and `task.py start` admits the task
once the plan is approved.

The spec tree ships with the payload: `.myflow/spec/` documents the harness
itself. Add the target project's own areas beside it with
`myflow-spec-bootstrap`, or let `myflow-update-spec` write them as the project
grows. A project that deletes the tree is not broken — `myflow-before-dev`
reports `NO_SPEC` and continues instead of inventing rules.
