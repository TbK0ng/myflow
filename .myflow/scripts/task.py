#!/usr/bin/env python3
"""Task management for the Myflow Pi harness.

Usage:
    task.py create <title> --description <desc> --slug <slug> [--parent <dir>]
    task.py start <task_dir>
    task.py current [--source] [--json]
    task.py finish
    task.py archive <task_dir>
    task.py add-subtask <parent_dir> <child_dir>
    task.py list [--status <status>] [--json]

Data model (matches .pi/extensions/myflow/turn-cache.ts resolveActiveTaskStatus):
    .myflow/.runtime/sessions/<contextKey>.json  -> {"current_task": ".myflow/tasks/<dir>"}
    .myflow/tasks/<dir>/task.json                -> {"title", "status", "description", "slug", "parent"}
    .myflow/archive/<YYYY-MM>/<dir>/task.json    -> archived task

Statuses: planning -> in_progress -> done -> (archived as completed)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path


def _force_utf8_stdio() -> None:
    """Windows pipes default to the ANSI codepage, which mangles non-ASCII
    task titles in shell output. Force UTF-8 for every consumer."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8")
        except (ValueError, OSError):
            pass


_force_utf8_stdio()

def _find_project_root(start: Path | None = None) -> Path:
    """The nearest ancestor whose `.myflow/` holds `workflow.md`.

    Walking up means the scripts behave the same from a subdirectory. The
    `workflow.md` part matters: `.myflow` alone is a marker a stray directory
    can carry, and treating one above the project (a home directory, say) as
    the root would quietly redirect every task, session, and archive there.
    With no project above, the start directory is used as-is.
    """
    directory = (start or Path.cwd()).resolve()
    for candidate in [directory, *directory.parents]:
        if (candidate / ".myflow" / "workflow.md").is_file():
            return candidate
    return directory


PROJECT_ROOT = _find_project_root()
TASKS_DIR = PROJECT_ROOT / ".myflow" / "tasks"
ARCHIVE_DIR = PROJECT_ROOT / ".myflow" / "archive"
SESSIONS_DIR = PROJECT_ROOT / ".myflow" / ".runtime" / "sessions"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug or "task"


def _sanitize_key(raw: str) -> str:
    """Mirror the extension's sanitizeKey so context keys match exactly."""
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", raw.strip()).strip("._-")
    return safe[:160]


def _context_key() -> str | None:
    """Resolve the myflow context key for the current shell session.

    Pi exposes the session id to shell commands as ``PI_SESSION_ID``, which is
    the shell/session bridge: the TypeScript extension derives ``pi_<session>``
    from the same id, so both sides address one session file.
    """
    override = os.environ.get("MYFLOW_CONTEXT_ID", "").strip()
    if override:
        return _sanitize_key(override) or None
    session_id = os.environ.get("PI_SESSION_ID", "").strip()
    if session_id:
        safe = _sanitize_key(session_id)
        if safe:
            return f"pi_{safe}"
    return None


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _relative(path: Path) -> str:
    try:
        return path.resolve().relative_to(PROJECT_ROOT.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _task_dir_for(slug: str) -> Path:
    return TASKS_DIR / slug


def _resolve_task_dir(raw: str) -> Path:
    """Accept a task slug or a project-relative/absolute task directory."""
    candidate = Path(raw)
    if candidate.is_absolute():
        return candidate
    direct = PROJECT_ROOT / candidate
    if direct.is_dir():
        return direct
    return TASKS_DIR / raw


def _write_task(task_dir: Path, data: dict) -> None:
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / "task.json").write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _read_task(task_dir: Path) -> dict | None:
    path = task_dir / "task.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _resolve_session(create: bool) -> tuple[Path | None, str]:
    """Resolve the active session file and report where the pointer came from.

    Sources: ``context:<key>`` (session-scoped), ``single-session``,
    ``recent-session``, ``default``, ``context-missing``, ``none``.
    """
    if not SESSIONS_DIR.is_dir():
        if not create:
            return None, "none"
        SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

    context_key = _context_key()
    if context_key:
        candidate = SESSIONS_DIR / f"{context_key}.json"
        if candidate.is_file():
            return candidate, f"context:{context_key}"
        if create:
            candidate.write_text(json.dumps({"current_task": None}, indent=2), encoding="utf-8")
            return candidate, f"context:{context_key}"
        return None, "context-missing"

    files = sorted(p for p in SESSIONS_DIR.iterdir() if p.suffix == ".json")
    if len(files) == 1:
        return files[0], "single-session"
    if not files:
        if not create:
            return None, "none"
        default = SESSIONS_DIR / "default.json"
        default.write_text(json.dumps({"current_task": None}, indent=2), encoding="utf-8")
        return default, "default"
    return max(files, key=lambda p: p.stat().st_mtime), "recent-session"


def _read_session() -> tuple[dict, str]:
    session_file, source = _resolve_session(create=True)
    assert session_file is not None  # create=True always yields a file
    try:
        return json.loads(session_file.read_text(encoding="utf-8")), source
    except (json.JSONDecodeError, OSError):
        return {"current_task": None}, source


def _write_session(data: dict) -> None:
    session_file, _source = _resolve_session(create=True)
    assert session_file is not None
    session_file.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _clear_sessions_pointing_at(task_dir: Path) -> int:
    """Clear active-task pointers that still reference an archived task."""
    if not SESSIONS_DIR.is_dir():
        return 0
    cleared = 0
    target = task_dir.resolve()
    for session_file in sorted(SESSIONS_DIR.glob("*.json")):
        try:
            data = json.loads(session_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        current = data.get("current_task")
        if not isinstance(current, str) or not current.strip():
            continue
        if (PROJECT_ROOT / current).resolve() != target:
            continue
        data["current_task"] = None
        session_file.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        cleared += 1
    return cleared


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


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
    session, _source = _read_session()
    if not session.get("current_task"):
        # Planning needs a pointer too. Without one the extension reports
        # no_task, so the planning block — and the jsonl review gate it
        # carries — never reaches the model while a task sits in planning.
        # An existing pointer is left alone: creating a second task (or a
        # child) must not hijack the session that is already working.
        session["current_task"] = _relative(task_dir)
        _write_session(session)
    print(f"created: {_relative(task_dir)}")
    return 0


def cmd_start(args: argparse.Namespace) -> int:
    task_dir = _resolve_task_dir(args.task_dir)
    task = _read_task(task_dir)
    if task is None:
        print(f"error: no task.json in {args.task_dir}", file=sys.stderr)
        return 1
    task["status"] = "in_progress"
    task["started_at"] = _now()
    _write_task(task_dir, task)
    session, _source = _read_session()
    session["current_task"] = _relative(task_dir)
    _write_session(session)
    print(f"started: {_relative(task_dir)}")
    return 0


def cmd_current(args: argparse.Namespace) -> int:
    session_file, source = _resolve_session(create=False)
    current: str | None = None
    if session_file is not None:
        try:
            data = json.loads(session_file.read_text(encoding="utf-8"))
            value = data.get("current_task")
            if isinstance(value, str) and value.strip():
                current = value
        except (json.JSONDecodeError, OSError):
            current = None

    task: dict | None = None
    stale = False
    if current:
        task = _read_task(PROJECT_ROOT / current)
        stale = task is None

    if getattr(args, "json", False):
        payload = {
            "current_task": current.replace("\\", "/") if current else None,
            "status": task.get("status") if task else None,
            "title": task.get("title") if task else None,
            "source": source,
            "stale": stale,
        }
        print(json.dumps(payload, ensure_ascii=False))
        return 0

    if not current:
        suffix = f" (source: {source})" if args.source else ""
        print(f"no active task{suffix}")
        return 0

    rel = current.replace("\\", "/")
    if task is None:
        print(f"active task path missing: {rel}")
        return 1

    line = f"{rel}\t{task.get('status', 'unknown')}\t{task.get('title', '')}"
    if args.source:
        line += f"\tsource:{source}"
    print(line)
    return 0


def cmd_archive(args: argparse.Namespace) -> int:
    task_dir = _resolve_task_dir(args.task_dir)
    task = _read_task(task_dir)
    if task is None:
        print(f"error: no task.json in {args.task_dir}", file=sys.stderr)
        return 1

    stamp = datetime.now(timezone.utc).strftime("%Y-%m")
    destination = ARCHIVE_DIR / stamp / task_dir.name
    if destination.exists():
        print(f"error: archive destination already exists: {_relative(destination)}", file=sys.stderr)
        return 1

    task["status"] = "completed"
    task["finished_at"] = task.get("finished_at") or _now()
    task["archived_at"] = _now()
    _write_task(task_dir, task)

    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(task_dir), str(destination))
    cleared = _clear_sessions_pointing_at(task_dir)
    print(f"archived: {_relative(destination)}" + (f" (cleared {cleared} session pointer(s))" if cleared else ""))
    return 0


def cmd_add_subtask(args: argparse.Namespace) -> int:
    parent_dir = _resolve_task_dir(args.parent_dir)
    child_dir = _resolve_task_dir(args.child_dir)
    parent = _read_task(parent_dir)
    child = _read_task(child_dir)
    if parent is None:
        print(f"error: no task.json in {args.parent_dir}", file=sys.stderr)
        return 1
    if child is None:
        print(f"error: no task.json in {args.child_dir}", file=sys.stderr)
        return 1
    child["parent"] = _relative(parent_dir)
    _write_task(child_dir, child)
    print(f"linked: {_relative(child_dir)} -> {_relative(parent_dir)}")
    return 0


def _collect_tasks() -> list[dict]:
    if not TASKS_DIR.is_dir():
        return []
    tasks: list[dict] = []
    for task_dir in sorted(TASKS_DIR.iterdir()):
        if not task_dir.is_dir():
            continue
        task = _read_task(task_dir)
        if task is None:
            continue
        tasks.append(
            {
                "slug": task_dir.name,
                "path": _relative(task_dir),
                "status": task.get("status", "unknown"),
                "title": task.get("title", ""),
            }
        )
    return tasks


def cmd_list(args: argparse.Namespace) -> int:
    tasks = _collect_tasks()
    if args.status:
        tasks = [task for task in tasks if task["status"] == args.status]
    if getattr(args, "json", False):
        print(json.dumps({"tasks": tasks}, ensure_ascii=False))
        return 0
    if not tasks:
        print("no tasks")
        return 0
    for task in tasks:
        print(f"{task['slug']}\t{task['status']}\t{task['title']}")
    return 0


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="myflow task management")
    sub = parser.add_subparsers(dest="command", required=True)

    p_create = sub.add_parser("create", help="create a new task")
    p_create.add_argument("title")
    p_create.add_argument("--description", default="")
    p_create.add_argument("--slug", default=None)
    p_create.add_argument("--parent", default=None)
    p_create.set_defaults(func=cmd_create)

    p_start = sub.add_parser("start", help="start a task (sets the active task)")
    p_start.add_argument("task_dir")
    p_start.set_defaults(func=cmd_start)

    p_current = sub.add_parser("current", help="show the active task")
    p_current.add_argument("--source", action="store_true", help="also report where the pointer came from")
    p_current.add_argument("--json", action="store_true", help="machine-readable output")
    p_current.set_defaults(func=cmd_current)


    p_archive = sub.add_parser("archive", help="archive a finished task under .myflow/archive/<YYYY-MM>/")
    p_archive.add_argument("task_dir")
    p_archive.set_defaults(func=cmd_archive)

    p_sub = sub.add_parser("add-subtask", help="link a child task to a parent")
    p_sub.add_argument("parent_dir")
    p_sub.add_argument("child_dir")
    p_sub.set_defaults(func=cmd_add_subtask)

    p_list = sub.add_parser("list", help="list all tasks")
    p_list.add_argument("--status", default=None, help="filter by status")
    p_list.add_argument("--json", action="store_true", help="machine-readable output")
    p_list.set_defaults(func=cmd_list)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
