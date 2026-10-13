#!/usr/bin/env python3
"""Session context for the Myflow Pi harness.

Usage:
    python3 get_context.py            Output context in text format
    python3 get_context.py --json     Output context in JSON format
    python3 get_context.py --mode default   (explicit form of the default mode)

Output:

1. Every ``[workflow-state:STATUS]`` block from ``.myflow/workflow.md``. The
   Pi extension parses these separately for the per-turn breadcrumb, but the
   full set is useful once at session start.
2. The active task summary (path / status / title).
3. Git branch, working-tree status, and recent commits.

Only ``--mode default`` exists on purpose. Other myflow builds also ship
``--mode phase`` / ``--step`` / ``--platform`` (a workflow step parser and
platform filter) and ``--mode packages`` (a spec registry lister). This
single-user Pi harness deliberately does not implement them: it has one
platform, no structured workflow step tree, and a plain ``.myflow/spec/``
directory that is read directly. Passing an unsupported mode fails loudly so
missing output can never be mistaken for real output.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path


def _force_utf8_stdio() -> None:
    """Windows pipes default to the ANSI codepage, which mangles non-ASCII.

    The Pi extension reads this script's stdout as UTF-8, so force it.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8")
        except (ValueError, OSError):
            pass


_force_utf8_stdio()

GIT_TIMEOUT_SECONDS = 5
MAX_CHANGES_REPORTED = 20
MAX_COMMITS_REPORTED = 5


# ---------------------------------------------------------------------------
# workflow.md
# ---------------------------------------------------------------------------


def _workflow_blocks(workflow_md: str) -> list[tuple[str, str]]:
    """Parse [workflow-state:STATUS] ... [/workflow-state:STATUS] blocks."""
    blocks: list[tuple[str, str]] = []
    current_status: str | None = None
    current_lines: list[str] = []
    for line in workflow_md.splitlines():
        open_tag = line.strip().startswith("[workflow-state:")
        close_tag = line.strip().startswith("[/workflow-state:")
        if open_tag:
            current_status = line.strip()[len("[workflow-state:") :].rstrip("]").strip()
            current_lines = []
        elif close_tag and current_status is not None:
            blocks.append((current_status, "\n".join(current_lines).strip()))
            current_status = None
            current_lines = []
        elif current_status is not None:
            current_lines.append(line)
    return blocks


# ---------------------------------------------------------------------------
# Session identity / active task
# ---------------------------------------------------------------------------


def _sanitize_key(raw: str) -> str:
    """Mirror the extension's sanitizeKey so context keys match exactly."""
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", raw.strip()).strip("._-")
    return safe[:160]


def _context_key() -> str | None:
    """Resolve the context key exactly like the Pi extension does."""
    override = os.environ.get("MYFLOW_CONTEXT_ID", "").strip()
    if override:
        return _sanitize_key(override) or None
    session_id = os.environ.get("PI_SESSION_ID", "").strip()
    if session_id:
        safe = _sanitize_key(session_id)
        if safe:
            return f"pi_{safe}"
    return None


def _resolve_session_file(project_root: Path) -> tuple[Path | None, str]:
    """Resolve the active session file, mirroring resolveActiveTaskStatus()."""
    sessions_dir = project_root / ".myflow" / ".runtime" / "sessions"
    if not sessions_dir.is_dir():
        return None, "none"

    context_key = _context_key()
    if context_key:
        candidate = sessions_dir / f"{context_key}.json"
        if candidate.is_file():
            return candidate, f"context:{context_key}"
        return None, "context-missing"

    files = sorted(p for p in sessions_dir.iterdir() if p.suffix == ".json")
    if len(files) == 1:
        return files[0], "single-session"
    if not files:
        return None, "none"
    return max(files, key=lambda p: p.stat().st_mtime), "recent-session"


def _active_task(project_root: Path) -> dict[str, object] | None:
    """Return {path, status, title, stale, source} for the active task."""
    session_file, source = _resolve_session_file(project_root)
    if session_file is None:
        return None
    try:
        session = json.loads(session_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None

    current = session.get("current_task")
    if not isinstance(current, str) or not current.strip():
        return None
    rel = current.replace("\\", "/")
    task_dir = project_root / current
    task_file = task_dir / "task.json"
    if not task_file.is_file():
        return {"path": rel, "status": "missing", "title": "", "stale": True, "source": source}
    try:
        task = json.loads(task_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"path": rel, "status": "unreadable", "title": "", "stale": True, "source": source}
    return {
        "path": rel,
        "status": str(task.get("status", "unknown")),
        "title": str(task.get("title", "")),
        "stale": False,
        "source": source,
    }


# ---------------------------------------------------------------------------
# Git
# ---------------------------------------------------------------------------


def _run_git(project_root: Path, args: list[str]) -> str | None:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=project_root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=GIT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout


def _git_info(project_root: Path) -> dict[str, object] | None:
    status = _run_git(project_root, ["status", "--porcelain=v1", "-b"])
    if status is None:
        return None

    branch = ""
    changes: list[str] = []
    for line in status.splitlines():
        if line.startswith("## "):
            branch = line[3:].split("...")[0].strip()
        elif line.strip():
            changes.append(line.rstrip())

    log = _run_git(project_root, ["log", f"-{MAX_COMMITS_REPORTED}", "--pretty=%h %s"]) or ""
    commits = [line for line in log.splitlines() if line.strip()]

    return {
        "branch": branch,
        "dirty": len(changes),
        "changes": changes[:MAX_CHANGES_REPORTED],
        "commits": commits,
    }


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _render_text(blocks: list[tuple[str, str]], task: dict | None, git: dict | None) -> str:
    parts: list[str] = []
    for status, content in blocks:
        parts.append(f"[workflow-state:{status}]\n{content}\n[/workflow-state:{status}]")

    lines: list[str] = ["## Session Runtime Context", ""]
    if task is None:
        lines.append("CURRENT TASK: none")
    else:
        suffix = " [stale]" if task["stale"] else ""
        title = f" — {task['title']}" if task["title"] else ""
        lines.append(f"CURRENT TASK: {task['path']} ({task['status']}){title}{suffix}")

    if git is None:
        lines.append("GIT: not a repository (or git unavailable)")
    else:
        lines.append(f"GIT: branch {git['branch'] or '(detached)'}, {git['dirty']} uncommitted change(s)")
        for change in git["changes"]:
            lines.append(f"  {change}")
        if git["commits"]:
            lines.append("RECENT COMMITS:")
            for commit in git["commits"]:
                lines.append(f"  {commit}")
    parts.append("\n".join(lines))
    return "\n\n".join(part for part in parts if part.strip())


def main() -> int:
    args = sys.argv[1:]

    mode = "default"
    if "--mode" in args:
        index = args.index("--mode")
        if index + 1 >= len(args):
            print("error: --mode requires a value (supported: default)", file=sys.stderr)
            return 2
        mode = args[index + 1]
    elif "-m" in args:
        index = args.index("-m")
        if index + 1 >= len(args):
            print("error: -m requires a value (supported: default)", file=sys.stderr)
            return 2
        mode = args[index + 1]

    if mode != "default":
        print(
            f"error: unsupported --mode '{mode}'. This harness only implements 'default'.\n"
            "The phase/step/platform and packages modes are intentionally absent; "
            "read .myflow/workflow.md and .myflow/spec/index.md directly instead.",
            file=sys.stderr,
        )
        return 2

    project_root = Path.cwd()
    workflow_path = project_root / ".myflow" / "workflow.md"
    blocks: list[tuple[str, str]] = []
    if workflow_path.is_file():
        try:
            blocks = _workflow_blocks(workflow_path.read_text(encoding="utf-8"))
        except OSError:
            blocks = []

    task = _active_task(project_root)
    git = _git_info(project_root)

    if "--json" in args or "-j" in args:
        print(
            json.dumps(
                {
                    "blocks": [{"status": status, "content": content} for status, content in blocks],
                    "current_task": task,
                    "git": git,
                },
                ensure_ascii=False,
            )
        )
        return 0

    output = _render_text(blocks, task, git)
    if output:
        print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
