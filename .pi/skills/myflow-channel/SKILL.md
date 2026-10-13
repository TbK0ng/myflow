---
name: myflow-channel
description: "Use the local channel runtime for live multi-agent collaboration: spawn runtime-agent workers, send and read durable messages, wait for a worker's completion, interrupt a stalled worker, and keep forum boards with threads and linked context. Use when the user wants two agents to discuss a problem, wants an implement/check/plan/research worker spawned as a peer process, wants an issue board or changelog board, or when a worker needs to be inspected, redirected, or stopped."
---

# myflow channel

`channel.py` is the local multi-agent runtime. A *channel* is a durable,
project-scoped JSONL event log; a *worker* is an ordinary `pi` process started
with a runtime agent definition from `.myflow/agents/`.

Reach for it when agents must talk through a durable log, when a worker should
run as a peer process, or when an in-flight worker needs an interrupt.

## First Commands

```bash
python3 ./.myflow/scripts/channel.py list --all
python3 ./.myflow/scripts/channel.py workers
python3 ./.myflow/scripts/channel.py messages <channel> --json
```

## Runtime Agents

`.myflow/agents/` — `architect`, `plan`, `research`, `implement`, `check`. They
are peer workers, not sub-agents: they run in this project, keep their own
session, and report back through the channel.

## Workflows

### Peer brainstorm

```bash
python3 ./.myflow/scripts/channel.py create brainstorm
python3 ./.myflow/scripts/channel.py send brainstorm --as me --text "<question>"
python3 ./.myflow/scripts/channel.py spawn brainstorm --agent architect --handle arch \
  --prompt "<the question, plus what a good answer must contain>"
python3 ./.myflow/scripts/channel.py wait brainstorm --from arch --kind done --timeout 600
python3 ./.myflow/scripts/channel.py messages brainstorm
```

Do several pressure-test rounds; one answer plus a confirmation is a review, not
a brainstorm.

### Spawn an implement or check worker

```bash
python3 ./.myflow/scripts/channel.py spawn review --agent check --handle checker \
  --task .myflow/tasks/<slug>
python3 ./.myflow/scripts/channel.py wait review --from checker --kind done
```

The `--task` path becomes the worker's `Active task:` line, so it loads the task
artifacts itself.

### Forum boards

A forum channel keeps durable items instead of a chat stream:

```bash
python3 ./.myflow/scripts/channel.py create board --type forum
python3 ./.myflow/scripts/channel.py title set board "Release Board"
python3 ./.myflow/scripts/channel.py post board "Flaky test in CI" --as me --text "<details>"
python3 ./.myflow/scripts/channel.py forum board                 # open threads
python3 ./.myflow/scripts/channel.py forum board --state all     # include closed
python3 ./.myflow/scripts/channel.py thread board flaky-test-in-ci
python3 ./.myflow/scripts/channel.py thread board flaky-test-in-ci --text "Root cause found" --as me
python3 ./.myflow/scripts/channel.py thread board flaky-test-in-ci --close --as me
```

Threads are event-sourced: `thread` is the durable record, so use it instead
of parsing `events.jsonl`. A taken slug gets a numeric suffix.

### Linked context

```bash
python3 ./.myflow/scripts/channel.py context add board --kind spec --value docs/spec.md --label Spec --as me
python3 ./.myflow/scripts/channel.py context add board --target thread --thread <id> --kind file --value src/x.ts
python3 ./.myflow/scripts/channel.py context list board [--thread <id>]
python3 ./.myflow/scripts/channel.py context delete board <context-id>
```

Context makes a board self-describing: a reviewer sees which spec or file an
item refers to without leaving the channel.

### Interrupt and redirect

```bash
python3 ./.myflow/scripts/channel.py send review --as me --to checker --kind interrupt \
  --text "Stop: keep the existing signature."
```

### Inspect and clean up

```bash
python3 ./.myflow/scripts/channel.py workers --json
python3 ./.myflow/scripts/channel.py prune          # drop dead workers, stop idle ones
python3 ./.myflow/scripts/channel.py kill <handle>
python3 ./.myflow/scripts/channel.py rm <channel>
```

## Rules

- Completion signal is `--kind done`, a system event the runtime understands. A
  user `--tag` is an opaque label; never rely on a worker writing a tag to mean
  "finished".
- `post`, `forum`, `thread`, `context`, and `title` are for `--type forum`
  boards; `post` on a chat channel is rejected on purpose.
- Use `--stdin` or `--text-file` for long text instead of a giant positional
  argument.
- `--scope project` (default) keeps the channel with this project;
  `--scope global` shares one bucket across projects. Pick deliberately — a
  global channel is invisible from project listings.
- Long work goes to `research/<topic>.md` or the task artifacts; the channel
  carries instructions and short reports.
- The worker guard caps live workers (`channel.worker_guard.max_live_workers`,
  default 3) and stops idle ones (`channel.worker_guard.idle_timeout`, default
  900s).

## Not For

- A single static review where a sub-agent and a prompt are enough.
- Self-logging every tool call.
