#!/usr/bin/env python3
"""Task management for the Myflow omp harness.

Usage:
    task.py create <title> --description <desc> --slug <slug> [--parent <dir>]
    task.py start <task_dir>
    task.py current
    task.py finish
    task.py add-subtask <parent_dir> <child_dir>
    task.py list

Data model (matches src/turn-cache.ts resolveActiveTaskStatus):
    .myflow/.runtime/sessions/<contextKey>.json  -> {"current_task": "tasks/<dir>"}
    .myflow/tasks/<dir>/task.json                -> {"title", "status", "description", "slug", "parent"}

Statuses: planning -> in_progress -> done
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path.cwd()
TASKS_DIR = PROJECT_ROOT / ".myflow" / "tasks"
SESSIONS_DIR = PROJECT_ROOT / ".myflow" / ".runtime" / "sessions"


def _slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug or "task"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _task_dir_for(slug: str) -> Path:
    return TASKS_DIR / slug


def _write_task(task_dir: Path, data: dict) -> None:
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / "task.json").write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _read_task(task_dir: Path) -> dict | None:
    p = task_dir / "task.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _session_file() -> Path:
    """Return the single session file, creating it if needed."""
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(f for f in SESSIONS_DIR.iterdir() if f.suffix == ".json")
    if len(files) == 1:
        return files[0]
    if not files:
        default = SESSIONS_DIR / "default.json"
        default.write_text(json.dumps({"current_task": None}, indent=2), encoding="utf-8")
        return default
    # Multiple sessions: use the most recently modified.
    return max(files, key=lambda f: f.stat().st_mtime)


def _read_session() -> dict:
    sf = _session_file()
    try:
        return json.loads(sf.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"current_task": None}


def _write_session(data: dict) -> None:
    sf = _session_file()
    sf.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def cmd_create(args: argparse.Namespace) -> int:
    slug = args.slug or _slugify(args.title)
    task_dir = _task_dir_for(slug)
    if (task_dir / "task.json").exists():
        print(f"error: task '{slug}' already exists", file=sys.stderr)
        return 1
    data = {
        "title": args.title,
        "status": "planning",
        "description": args.description or "",
        "slug": slug,
        "parent": args.parent,
        "created_at": _now(),
    }
    _write_task(task_dir, data)
    print(f"created: tasks/{slug}")
    return 0


def cmd_start(args: argparse.Namespace) -> int:
    task_dir = Path(args.task_dir)
    if not task_dir.is_absolute():
        task_dir = PROJECT_ROOT / task_dir
    task = _read_task(task_dir)
    if task is None:
        print(f"error: no task.json in {args.task_dir}", file=sys.stderr)
        return 1
    task["status"] = "in_progress"
    task["started_at"] = _now()
    _write_task(task_dir, task)
    rel = os.path.relpath(task_dir, PROJECT_ROOT)
    session = _read_session()
    session["current_task"] = rel
    _write_session(session)
    print(f"started: {rel}")
    return 0


def cmd_current(_args: argparse.Namespace) -> int:
    session = _read_session()
    current = session.get("current_task")
    if not current:
        print("no active task")
        return 0
    task_dir = PROJECT_ROOT / current
    task = _read_task(task_dir)
    if task is None:
        print(f"active task path missing: {current}")
        return 1
    print(f"{current}\t{task.get('status', 'unknown')}\t{task.get('title', '')}")
    return 0


def cmd_finish(_args: argparse.Namespace) -> int:
    session = _read_session()
    current = session.get("current_task")
    if current:
        task_dir = PROJECT_ROOT / current
        task = _read_task(task_dir)
        if task is not None:
            task["status"] = "done"
            task["finished_at"] = _now()
            _write_task(task_dir, task)
    session["current_task"] = None
    _write_session(session)
    print("finished")
    return 0


def cmd_add_subtask(args: argparse.Namespace) -> int:
    parent_dir = Path(args.parent_dir)
    if not parent_dir.is_absolute():
        parent_dir = PROJECT_ROOT / parent_dir
    child_dir = Path(args.child_dir)
    if not child_dir.is_absolute():
        child_dir = PROJECT_ROOT / child_dir
    parent = _read_task(parent_dir)
    child = _read_task(child_dir)
    if parent is None:
        print(f"error: no task.json in {args.parent_dir}", file=sys.stderr)
        return 1
    if child is None:
        print(f"error: no task.json in {args.child_dir}", file=sys.stderr)
        return 1
    child["parent"] = os.path.relpath(parent_dir, PROJECT_ROOT)
    _write_task(child_dir, child)
    print(f"linked: {args.child_dir} -> {args.parent_dir}")
    return 0


def cmd_list(_args: argparse.Namespace) -> int:
    if not TASKS_DIR.exists():
        print("no tasks")
        return 0
    for task_dir in sorted(TASKS_DIR.iterdir()):
        if not task_dir.is_dir():
            continue
        task = _read_task(task_dir)
        if task is None:
            continue
        print(f"{task_dir.name}\t{task.get('status', 'unknown')}\t{task.get('title', '')}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="myflow task management")
    sub = parser.add_subparsers(dest="command", required=True)

    p_create = sub.add_parser("create", help="create a new task")
    p_create.add_argument("title")
    p_create.add_argument("--description", default="")
    p_create.add_argument("--slug", default=None)
    p_create.add_argument("--parent", default=None)
    p_create.set_defaults(func=cmd_create)

    p_start = sub.add_parser("start", help="start a task")
    p_start.add_argument("task_dir")
    p_start.set_defaults(func=cmd_start)

    p_current = sub.add_parser("current", help="show the active task")
    p_current.set_defaults(func=cmd_current)

    p_finish = sub.add_parser("finish", help="finish the active task")
    p_finish.set_defaults(func=cmd_finish)

    p_sub = sub.add_parser("add-subtask", help="link a child task to a parent")
    p_sub.add_argument("parent_dir")
    p_sub.add_argument("child_dir")
    p_sub.set_defaults(func=cmd_add_subtask)

    p_list = sub.add_parser("list", help="list all tasks")
    p_list.set_defaults(func=cmd_list)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
