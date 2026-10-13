---
description: Start an isolated parallel session in its own git worktree
argument-hint: "<task description>"
---

Start an isolated parallel session for: ${@:-describe the task}

## Steps

1. Inspect the configuration:

   ```bash
   python3 ./.myflow/scripts/worktree.py config
   ```

2. Start the session with a short, unique name:

   ```bash
   python3 ./.myflow/scripts/worktree.py start <name> --prompt "<complete task prompt>" \
     [--task .myflow/tasks/<slug>]
   ```

   This creates a git worktree on branch `myflow/<name>` under the configured
   `worktree_dir`, copies the configured files, runs `post_create`, then launches
   a detached `pi` session there (session id `myflow-<name>`) and writes its
   output to `.myflow/.runtime/worktree-logs/<name>.log`. The initial run is a
   delegated work order: it carries the `Active task:` line when `--task` is
   given, and it skips the per-turn workflow breadcrumb so it starts working
   instead of asking whether to create a task.
3. Report the name, worktree path, branch, session id, and log path. Discover
   the session later with `pi --resume` (session id) or read the log.

4. Continue working in the current directory. The parallel session is
   independent: it has its own branch, files, and context.

## Managing sessions

```bash
python3 ./.myflow/scripts/worktree.py list [--json]
python3 ./.myflow/scripts/worktree.py remove <name> [--force]
python3 ./.myflow/scripts/worktree.py prune
```

Do not implement the requested task in the current directory — it belongs to the
new session. If the project is not a git repository, the command fails with a
clear error; say so instead of improvising a worktree.
