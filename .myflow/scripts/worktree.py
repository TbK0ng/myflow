#!/usr/bin/env python3
"""Isolated parallel sessions for the Myflow Pi harness.

A *worktree session* is a git worktree with its own branch, running its own
`pi` process. Use it when you want to work on several independent tasks at
once without sharing a working tree.

Usage:
    worktree.py create <name> [--branch <branch>] [--base <ref>]
    worktree.py list [--json]
    worktree.py remove <name> [--force]
    worktree.py prune
    worktree.py start <name> --prompt <text> [--session-id <id>]
    worktree.py verify [--json]
    worktree.py config [--json]

Configuration: `.myflow/worktree.yaml` (all optional)

    worktree_dir: ../worktrees     # relative to the project root
    copy:                          # files/dirs copied into each new worktree
      - .myflow/config.yaml
    post_create:                   # commands run in the new worktree
      - npm install
    verify:                        # commands that must pass to settle a check
      - node --test

State: `.myflow/.runtime/worktrees.json` records every session this project
started. Logs for `start` live in `.myflow/.runtime/worktree-logs/`.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path.cwd()
CONFIG_PATH = PROJECT_ROOT / ".myflow" / "worktree.yaml"
RUNTIME_DIR = PROJECT_ROOT / ".myflow" / ".runtime"
REGISTRY_PATH = RUNTIME_DIR / "worktrees.json"
LOG_DIR = RUNTIME_DIR / "worktree-logs"

DEFAULT_WORKTREE_DIR = "../worktrees"
COMMAND_TIMEOUT_SECONDS = 600


def _force_utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8")
        except (ValueError, OSError):
            pass


_force_utf8_stdio()


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def _parse_scalar(raw: str) -> str:
    value = raw.strip()
    if value.startswith(("'", '"')) and value.endswith(("'", '"')) and len(value) >= 2:
        return value[1:-1]
    return value


def read_config() -> dict:
    """Read the small YAML subset used by worktree.yaml."""
    config: dict = {"worktree_dir": DEFAULT_WORKTREE_DIR, "copy": [], "post_create": [], "verify": []}
    if not CONFIG_PATH.is_file():
        return config
    try:
        lines = CONFIG_PATH.read_text(encoding="utf-8").splitlines()
    except OSError:
        return config

    current: str | None = None
    for raw in lines:
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        stripped = line.strip()
        if stripped.endswith(":") and not line.startswith(" "):
            key = stripped[:-1].strip()
            current = key if key in {"worktree_dir", "copy", "post_create", "verify"} else None
            continue
        if ":" in stripped and not line.startswith(" ") and current is None:
            key, _, value = stripped.partition(":")
            if key.strip() == "worktree_dir":
                config["worktree_dir"] = _parse_scalar(value)
            continue
        if current and stripped.startswith("- "):
            config[current].append(_parse_scalar(stripped[2:]))
    return config


# ---------------------------------------------------------------------------
# Git
# ---------------------------------------------------------------------------


def run_git(args: list[str], cwd: Path = PROJECT_ROOT) -> tuple[int, str, str]:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return 1, "", str(error)
    return completed.returncode, completed.stdout, completed.stderr


def repo_root() -> Path | None:
    code, out, _ = run_git(["rev-parse", "--show-toplevel"])
    return Path(out.strip()) if code == 0 and out.strip() else None


def worktree_dir(root: Path, config: dict) -> Path:
    raw = str(config.get("worktree_dir") or DEFAULT_WORKTREE_DIR)
    candidate = Path(raw)
    return candidate if candidate.is_absolute() else (root / candidate).resolve()


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def read_registry() -> list[dict]:
    if not REGISTRY_PATH.is_file():
        return []
    try:
        data = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    return data.get("sessions", []) if isinstance(data, dict) else []


def write_registry(sessions: list[dict]) -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(json.dumps({"sessions": sessions}, indent=2, ensure_ascii=False), encoding="utf-8")


def record(entry: dict) -> None:
    sessions = [item for item in read_registry() if item.get("name") != entry["name"]]
    sessions.append(entry)
    write_registry(sessions)


def forget(name: str) -> None:
    write_registry([item for item in read_registry() if item.get("name") != name])


def is_alive(pid: object) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except (OSError, ValueError):
        return False
    return True


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_create(args: argparse.Namespace) -> int:
    root = repo_root()
    if root is None:
        print("error: not inside a git repository", file=sys.stderr)
        return 1
    config = read_config()
    target = worktree_dir(root, config) / args.name
    if target.exists():
        print(f"error: worktree path already exists: {target}", file=sys.stderr)
        return 1

    branch = args.branch or f"myflow/{args.name}"
    target.parent.mkdir(parents=True, exist_ok=True)
    base = args.base or "HEAD"
    code, _out, err = run_git(["worktree", "add", "-b", branch, str(target), base], cwd=root)
    if code != 0:
        print(f"error: git worktree add failed: {err.strip()}", file=sys.stderr)
        return 1

    copied: list[str] = []
    for entry in config.get("copy", []):
        source = (root / entry).resolve()
        if not source.exists():
            continue
        destination = target / entry
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, destination, dirs_exist_ok=True)
        else:
            shutil.copy2(source, destination)
        copied.append(entry)

    post_create_failed: str | None = None
    for command in config.get("post_create", []):
        completed = subprocess.run(command, cwd=target, shell=True, text=True, encoding="utf-8", errors="replace")
        if completed.returncode != 0:
            post_create_failed = command
            break

    record(
        {
            "name": args.name,
            "path": str(target),
            "branch": branch,
            "created_at": _now(),
            "copied": copied,
            "post_create_failed": post_create_failed,
        }
    )

    if args.json:
        print(json.dumps({"name": args.name, "path": str(target), "branch": branch, "copied": copied}, ensure_ascii=False))
    else:
        print(f"created: {target}")
        print(f"branch:  {branch}")
        if copied:
            print(f"copied:  {', '.join(copied)}")
        if post_create_failed:
            print(f"warning: post_create failed: {post_create_failed}", file=sys.stderr)
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    sessions = read_registry()
    if args.json:
        payload = [
            {**entry, "alive": is_alive(entry.get("pid")), "exists": Path(str(entry.get("path", ""))).exists()}
            for entry in sessions
        ]
        print(json.dumps({"sessions": payload}, ensure_ascii=False))
        return 0
    if not sessions:
        print("no worktree sessions")
        return 0
    for entry in sessions:
        state = "alive" if is_alive(entry.get("pid")) else ("ready" if Path(str(entry.get("path", ""))).exists() else "missing")
        print(f"{entry.get('name')}\t{entry.get('branch', '-')}\t{state}\t{entry.get('path', '')}")
    return 0


def cmd_remove(args: argparse.Namespace) -> int:
    root = repo_root()
    if root is None:
        print("error: not inside a git repository", file=sys.stderr)
        return 1
    entry = next((item for item in read_registry() if item.get("name") == args.name), None)
    target = Path(str(entry.get("path"))) if entry else worktree_dir(root, read_config()) / args.name
    git_args = ["worktree", "remove", str(target)]
    if args.force:
        git_args.append("--force")
    code, _out, err = run_git(git_args, cwd=root)
    if code != 0 and target.exists() and args.force:
        shutil.rmtree(target, ignore_errors=True)
        code = 0
    if code != 0:
        print(f"error: git worktree remove failed: {err.strip()}", file=sys.stderr)
        return 1
    forget(args.name)
    print(f"removed: {target}")
    return 0


def cmd_prune(_args: argparse.Namespace) -> int:
    root = repo_root()
    if root is None:
        print("error: not inside a git repository", file=sys.stderr)
        return 1
    run_git(["worktree", "prune"], cwd=root)
    kept = [entry for entry in read_registry() if Path(str(entry.get("path", ""))).exists()]
    removed = len(read_registry()) - len(kept)
    write_registry(kept)
    print(f"pruned: {removed} stale session(s)")
    return 0


def _pi_command() -> list[str]:
    executable = shutil.which("pi")
    return [executable] if executable else ["pi"]


def cmd_start(args: argparse.Namespace) -> int:
    create_args = argparse.Namespace(
        name=args.name,
        branch=args.branch,
        base=args.base,
        json=True,
    )
    import io
    import contextlib

    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = cmd_create(create_args)
    if code != 0:
        return code
    created = json.loads(buffer.getvalue().strip().splitlines()[-1])
    target = Path(created["path"])

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / f"{args.name}.log"
    session_id = args.session_id or f"myflow-{args.name}"
    command = [*_pi_command(), "-p", "--approve", "--session-id", session_id, args.prompt]

    kwargs: dict = {"cwd": str(target), "stdin": subprocess.DEVNULL, "stdout": open(log_path, "wb"), "stderr": subprocess.STDOUT}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    process = subprocess.Popen(command, **kwargs)  # noqa: SIM115 - log handle lives with the child

    sessions = read_registry()
    for entry in sessions:
        if entry.get("name") == args.name:
            entry.update({"pid": process.pid, "session_id": session_id, "log": str(log_path), "started_at": _now()})
    write_registry(sessions)

    if args.json:
        print(json.dumps({"name": args.name, "path": str(target), "pid": process.pid, "session_id": session_id, "log": str(log_path)}))
    else:
        print(f"started: {args.name} (pid {process.pid}, session {session_id})")
        print(f"worktree: {target}")
        print(f"log:      {log_path}")
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    commands = read_config().get("verify", [])
    results = []
    failed = False
    for command in commands:
        completed = subprocess.run(
            command,
            cwd=PROJECT_ROOT,
            shell=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        results.append({"command": command, "exit_code": completed.returncode})
        if completed.returncode != 0:
            failed = True
            if args.json:
                continue
            print(f"FAIL: {command}", file=sys.stderr)
            if completed.stdout.strip():
                print(completed.stdout.rstrip(), file=sys.stderr)
            if completed.stderr.strip():
                print(completed.stderr.rstrip(), file=sys.stderr)
    if args.json:
        print(json.dumps({"verify": results, "failed": failed}, ensure_ascii=False))
    elif not commands:
        print("no verify commands configured")
    elif not failed:
        print(f"verify passed ({len(results)} command(s))")
    return 1 if failed else 0


def cmd_config(args: argparse.Namespace) -> int:
    config = read_config()
    if args.json:
        print(json.dumps(config, ensure_ascii=False))
    else:
        print(f"worktree_dir: {config.get('worktree_dir')}")
        for key in ("copy", "post_create", "verify"):
            values = config.get(key) or []
            print(f"{key}: {', '.join(values) if values else '(none)'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="myflow worktree sessions")
    sub = parser.add_subparsers(dest="command", required=True)

    def with_json(sub_parser: argparse.ArgumentParser) -> argparse.ArgumentParser:
        sub_parser.add_argument("--json", action="store_true", help="machine-readable output")
        return sub_parser

    p_create = with_json(sub.add_parser("create", help="create an isolated worktree for a session"))
    p_create.add_argument("name")
    p_create.add_argument("--branch", default=None)
    p_create.add_argument("--base", default=None)
    p_create.set_defaults(func=cmd_create)

    p_list = with_json(sub.add_parser("list", help="list recorded worktree sessions"))
    p_list.set_defaults(func=cmd_list)

    p_remove = sub.add_parser("remove", help="remove a worktree session")
    p_remove.add_argument("name")
    p_remove.add_argument("--force", action="store_true")
    p_remove.set_defaults(func=cmd_remove)

    p_prune = sub.add_parser("prune", help="drop git worktree metadata for deleted paths")
    p_prune.set_defaults(func=cmd_prune)

    p_start = with_json(sub.add_parser("start", help="create a worktree and run pi there"))
    p_start.add_argument("name")
    p_start.add_argument("--prompt", required=True)
    p_start.add_argument("--branch", default=None)
    p_start.add_argument("--base", default=None)
    p_start.add_argument("--session-id", default=None)
    p_start.set_defaults(func=cmd_start)

    p_verify = with_json(sub.add_parser("verify", help="run the configured verify commands"))
    p_verify.set_defaults(func=cmd_verify)

    p_config = with_json(sub.add_parser("config", help="show the effective configuration"))
    p_config.set_defaults(func=cmd_config)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
