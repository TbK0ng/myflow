#!/usr/bin/env python3
"""Task management for the Myflow Pi harness.

Usage:
    task.py create <title> --description <desc> --slug <slug> [--parent <dir>]
    task.py start <task_dir> [--allow-empty-context]
    task.py current [--source] [--json]
    task.py finish
    task.py archive <task_dir>
    task.py add-subtask <parent_dir> <child_dir>
    task.py add-context <task_dir> <implement|check> <path> [reason]
    task.py validate <task_dir>
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

# The context manifests every sub-agent-capable setup seeds. A manifest that
# exists but carries no truthy `file` row means a dispatched sub-agent would
# run with zero spec context, which `start` refuses unless overridden.
CONTEXT_MANIFESTS = ("implement.jsonl", "check.jsonl")

# Extensions that look like code rather than spec/research docs. `validate`
# warns (never fails) on these outside spec/docs and the task's own directory:
# the reader is a sub-agent that can open the code itself.
_CODE_FILE_EXTENSIONS = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
    ".java", ".rb", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".kt",
    ".swift", ".php", ".sh", ".ps1", ".sql", ".vue", ".svelte",
}


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
    """Repo-relative posix ref, or "" when the path leaves the project.

    Returning "" instead of the absolute path matters: an absolute ref is how
    a task outside the repo used to reach the session pointer and be replayed
    on every later turn (a resolver must refuse it the same way).
    """
    try:
        return path.resolve().relative_to(PROJECT_ROOT.resolve()).as_posix()
    except ValueError:
        return ""


def _is_within_tasks_dir(path: Path) -> bool:
    """True when ``path`` resolves to a directory strictly inside the tasks dir.

    Both sides are resolved so ``..`` escapes and symlinks that leave the
    tasks tree are folded before the comparison.
    """
    try:
        resolved = path.resolve()
        tasks_root = TASKS_DIR.resolve()
    except (OSError, RuntimeError, ValueError):
        return False
    return resolved != tasks_root and tasks_root in resolved.parents


def _curated_entry_count(jsonl_file: Path) -> int | None:
    """Count curated entries in a jsonl context manifest.

    Returns ``None`` when the file does not exist. That asymmetry is the whole
    gate: ``create`` seeds the manifests, so an absent file means the setup is
    not one a sub-agent reads and must not be gated. A curated entry is a JSON
    object row carrying a truthy ``file`` (or legacy ``path``) value — the same
    rows the injection materializes.
    """
    if not jsonl_file.is_file():
        return None
    try:
        lines = jsonl_file.read_text(encoding="utf-8").splitlines()
    except OSError:
        return 0
    count = 0
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and (data.get("file") or data.get("path")):
            count += 1
    return count


def _seed_context_manifests(task_dir: Path) -> None:
    """Create empty ``implement.jsonl`` / ``check.jsonl`` placeholders.

    Empty on purpose: a placeholder row would read as unresolved scaffolding to
    ``validate``. The files stay empty until the planning phase curates real
    entries through ``add-context``.
    """
    for name in CONTEXT_MANIFESTS:
        path = task_dir / name
        if not path.exists():
            path.write_text("", encoding="utf-8")


def _resolve_context_entry(path_str: str) -> Path:
    """Resolve a jsonl entry path against the project root (absolute passes through)."""
    candidate = Path(path_str)
    return candidate if candidate.is_absolute() else PROJECT_ROOT / candidate


def _context_max_file_bytes() -> int:
    """Read ``context_injection.max_file_bytes`` from ``.myflow/config.yaml``.

    Mirrors the extension's parser and default so `validate` warns at the same
    threshold the injection actually truncates at.
    """
    default = 32768
    config = PROJECT_ROOT / ".myflow" / "config.yaml"
    if not config.is_file():
        return default
    try:
        text = config.read_text(encoding="utf-8")
    except OSError:
        return default
    in_section = False
    section_indent = -1
    for raw in text.splitlines():
        stripped = raw.strip()
        if not in_section:
            if re.match(r"^context_injection\s*:\s*(#.*)?$", stripped):
                in_section = True
                section_indent = len(raw) - len(raw.lstrip())
            continue
        if not stripped or stripped.startswith("#"):
            continue
        if len(raw) - len(raw.lstrip()) <= section_indent:
            break
        match = re.match(r"^max_file_bytes\s*:\s*(\d+)", stripped)
        if match:
            return int(match.group(1))
    return default


def _validate_jsonl(jsonl_file: Path, task_dir: Path, max_file_bytes: int) -> int:
    """Validate one manifest; return its error count (0 curated entries = 1 error).

    A missing file is skipped, never an error: ``create`` seeds the manifests
    only on sub-agent-capable setups, so absence means no sub-agent reads it.
    """
    name = jsonl_file.name
    if not jsonl_file.is_file():
        print(f"  {name}: not found (skipped)")
        return 0

    task_rel = ""
    try:
        task_rel = task_dir.resolve().relative_to(PROJECT_ROOT.resolve()).as_posix()
    except ValueError:
        task_rel = ""

    try:
        lines = jsonl_file.read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []

    errors = 0
    real_entries = 0
    for line_num, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            print(f"  {name}:{line_num}: invalid JSON")
            errors += 1
            continue
        if not isinstance(data, dict):
            print(f"  {name}:{line_num}: expected a JSON object")
            errors += 1
            continue
        if "_example" in data:
            print(
                f'  {name}:{line_num}: placeholder `_example` row — replace it with '
                '{"file": "<path>", "reason": "<why>"}'
            )
            errors += 1
            continue
        file_path = data.get("file")
        entry_type = data.get("type", "file")
        if not file_path:
            continue
        if not isinstance(file_path, str):
            print(f"  {name}:{line_num}: `file` must be a string path")
            errors += 1
            continue
        real_entries += 1
        full_path = _resolve_context_entry(file_path)
        if entry_type == "directory":
            if not full_path.is_dir():
                print(f"  {name}:{line_num}: directory not found: {file_path}")
                errors += 1
            continue
        if not full_path.is_file():
            print(f"  {name}:{line_num}: file not found: {file_path}")
            errors += 1
            continue

        posix_path = file_path.replace("\\", "/").lstrip("/")
        exempt = posix_path.startswith((".myflow/spec/", "docs/", "docs-site/")) or (
            bool(task_rel) and (posix_path == task_rel or posix_path.startswith(f"{task_rel}/"))
        )
        if full_path.suffix.lower() in _CODE_FILE_EXTENSIONS and not exempt:
            print(
                f"  {name}:{line_num}: warning: {file_path} looks like a code file — "
                "implement/check.jsonl should reference spec/research docs"
            )
        if max_file_bytes:
            try:
                size: int | None = full_path.stat().st_size
            except OSError:
                size = None
            if size is not None and size > max_file_bytes:
                print(
                    f"  {name}:{line_num}: warning: {file_path} is {size} bytes, exceeds "
                    f"context_injection.max_file_bytes ({max_file_bytes})"
                )

    if errors == 0 and real_entries == 0:
        action = name.split(".", 1)[0]
        print(f"  {name}: no curated entries — sub-agents would get zero spec context")
        print(f'    Curate one:  python3 .myflow/scripts/task.py add-context <task> {action} <path> "<why>"')
        print("    Intentionally empty?  python3 .myflow/scripts/task.py start <task> --allow-empty-context")
        return 1
    noun = "entry" if real_entries == 1 else "entries"
    print(f"  {name}: {real_entries} curated {noun}")
    return errors


def _task_dir_for(slug: str) -> Path:
    return TASKS_DIR / slug


def _resolve_task_dir(raw: str) -> Path | None:
    """Resolve a task slug or path to a directory under ``.myflow/tasks/``.

    Returns ``None`` when the target would fall outside the tasks directory, so
    an absolute, ``..``-escaping, or symlinked-away ref can never become the
    active-task pointer.
    """
    candidate = Path(raw)
    if candidate.is_absolute():
        resolved = candidate
    else:
        direct = PROJECT_ROOT / candidate
        resolved = direct if direct.is_dir() else TASKS_DIR / raw
    if not _is_within_tasks_dir(resolved):
        return None
    return resolved


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
    if not _is_within_tasks_dir(task_dir):
        print(
            f"error: refusing to create '{slug}': not a task under {_relative(TASKS_DIR)}",
            file=sys.stderr,
        )
        return 1
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
    # Seed the context manifests empty. Materializing them here — rather than
    # leaving the model to remember — is what lets `start` tell "not curated
    # yet" apart from "this setup has no manifests", and it gives
    # `add-context` a file to append to from the first planning turn.
    _seed_context_manifests(task_dir)
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
    if task_dir is None:
        print(
            f"error: refusing to start '{args.task_dir}': not a task under {_relative(TASKS_DIR)}",
            file=sys.stderr,
        )
        return 1
    task = _read_task(task_dir)
    if task is None:
        print(f"error: no task.json in {args.task_dir}", file=sys.stderr)
        return 1

    # Context-manifest gate: a manifest that exists but carries no curated
    # entry means every implement/check sub-agent for this task runs with zero
    # spec context, and nothing downstream surfaces that. An absent manifest
    # is not gated — that is a setup without sub-agent manifests, not an
    # uncurated one.
    if not args.allow_empty_context:
        empty_manifests = [
            name for name in CONTEXT_MANIFESTS if _curated_entry_count(task_dir / name) == 0
        ]
        if empty_manifests:
            joined = " and ".join(empty_manifests)
            verb = "has" if len(empty_manifests) == 1 else "have"
            print(f"error: {joined} {verb} no curated entries", file=sys.stderr)
            print("Sub-agents (implement/check) would run with zero spec context.", file=sys.stderr)
            print(
                f'  Curate:  python3 .myflow/scripts/task.py add-context {args.task_dir} '
                'implement <path> "<why>"',
                file=sys.stderr,
            )
            print(f"  Verify:  python3 .myflow/scripts/task.py validate {args.task_dir}", file=sys.stderr)
            print("  Intentionally empty? Re-run start with --allow-empty-context", file=sys.stderr)
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
    if task_dir is None:
        print(
            f"error: refusing to archive '{args.task_dir}': not a task under {_relative(TASKS_DIR)}",
            file=sys.stderr,
        )
        return 1
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
    if parent_dir is None:
        print(
            f"error: refusing to link '{args.parent_dir}': not a task under {_relative(TASKS_DIR)}",
            file=sys.stderr,
        )
        return 1
    if child_dir is None:
        print(
            f"error: refusing to link '{args.child_dir}': not a task under {_relative(TASKS_DIR)}",
            file=sys.stderr,
        )
        return 1
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


def cmd_add_context(args: argparse.Namespace) -> int:
    """Append one curated entry to a task's ``implement.jsonl`` / ``check.jsonl``.

    This is the write side of the empty-context gate: without it `start` would
    refuse a seeded task with no way to satisfy the gate. The entry carries a
    ``reason`` so the manifest is self-describing, matching the rows the
    injection materializes.
    """
    task_dir = _resolve_task_dir(args.task_dir)
    if task_dir is None:
        print(
            f"error: refusing to add context to '{args.task_dir}': not a task under {_relative(TASKS_DIR)}",
            file=sys.stderr,
        )
        return 1
    if not task_dir.is_dir():
        print(f"error: no task directory at {args.task_dir}", file=sys.stderr)
        return 1

    action = args.action
    if action.endswith(".jsonl"):
        action = action[: -len(".jsonl")]
    # Keep the manifest a plain name so the joined path cannot leave the task.
    if action not in ("implement", "check") or "/" in args.action or "\\" in args.action:
        print(f"error: context action must be 'implement' or 'check': {args.action}", file=sys.stderr)
        return 1

    jsonl_file = task_dir / f"{action}.jsonl"
    path = args.path
    reason = args.reason or "Added manually"

    full_path = _resolve_context_entry(path)
    entry_type = "file"
    if full_path.is_dir():
        entry_type = "directory"
        if not path.endswith("/"):
            path = f"{path}/"
    elif not full_path.is_file():
        print(f"error: path not found: {path}", file=sys.stderr)
        return 1

    if jsonl_file.is_file():
        content = jsonl_file.read_text(encoding="utf-8")
        if f'"{path}"' in content:
            print(f"warning: entry already exists for {path}")
            return 0

    entry: dict = {"file": path, "reason": reason}
    if entry_type == "directory":
        entry = {"file": path, "type": "directory", "reason": reason}
    with jsonl_file.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(f"added {entry_type}: {path} -> {action}.jsonl")
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    """Validate a task's context manifests (exit 1 when there is nothing curated)."""
    task_dir = _resolve_task_dir(args.task_dir)
    if task_dir is None:
        print(
            f"error: refusing to validate '{args.task_dir}': not a task under {_relative(TASKS_DIR)}",
            file=sys.stderr,
        )
        return 1
    if not task_dir.is_dir():
        print(f"error: no task directory at {args.task_dir}", file=sys.stderr)
        return 1

    print("=== Validating context files ===")
    print(f"target: {_relative(task_dir)}")
    max_file_bytes = _context_max_file_bytes()
    total_errors = 0
    for name in CONTEXT_MANIFESTS:
        jsonl_file = task_dir / name
        if not jsonl_file.is_file():
            print(f"  {name}: not found (skipped)")
            continue
        total_errors += _validate_jsonl(jsonl_file, task_dir, max_file_bytes)

    if total_errors == 0:
        print("all validations passed")
        return 0
    print(f"validation failed ({total_errors} error(s))")
    return 1


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
    p_start.add_argument(
        "--allow-empty-context",
        action="store_true",
        help="start even when implement.jsonl / check.jsonl have no curated entries",
    )
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

    p_add = sub.add_parser("add-context", help="append a curated entry to a task's jsonl manifest")
    p_add.add_argument("task_dir")
    p_add.add_argument("action", help="implement or check")
    p_add.add_argument("path", help="file or directory to reference, relative to the project root")
    p_add.add_argument("reason", nargs="?", default=None, help="why this entry is included")
    p_add.set_defaults(func=cmd_add_context)

    p_validate = sub.add_parser("validate", help="check a task's jsonl manifests for curated entries")
    p_validate.add_argument("task_dir")
    p_validate.set_defaults(func=cmd_validate)

    p_list = sub.add_parser("list", help="list all tasks")
    p_list.add_argument("--status", default=None, help="filter by status")
    p_list.add_argument("--json", action="store_true", help="machine-readable output")
    p_list.set_defaults(func=cmd_list)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
