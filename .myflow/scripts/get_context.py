#!/usr/bin/env python3
"""Get session context for the Myflow omp harness.

Usage:
    python3 get_context.py           Output context in text format
    python3 get_context.py --json    Output context in JSON format

Reads .myflow/workflow.md and emits the workflow-state blocks as the
session context. This is the myflow equivalent of Myflow's
.myflow/scripts/get_context.py (which delegates to common.git_context).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


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


def main() -> int:
    project_root = Path.cwd()
    workflow_path = project_root / ".myflow" / "workflow.md"
    if not workflow_path.exists():
        return 0

    workflow_md = workflow_path.read_text(encoding="utf-8")
    blocks = _workflow_blocks(workflow_md)
    if not blocks:
        return 0

    as_json = "--json" in sys.argv[1:]
    if as_json:
        print(json.dumps({"blocks": [{"status": s, "content": c} for s, c in blocks]}, ensure_ascii=False))
    else:
        parts = [f"[workflow-state:{status}]\n{content}\n[/workflow-state:{status}]" for status, content in blocks]
        print("\n\n".join(parts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
