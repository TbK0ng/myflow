#!/usr/bin/env python3
"""Local multi-agent channel runtime for the Myflow Pi harness.

A channel is a durable, project-scoped event log that agents and workers use to
talk to each other. Workers are ordinary `pi` processes started with a runtime
agent definition; the dispatcher sends a request, then waits for the worker's
`done` event.

Usage:
    channel.py create <name> [--type chat|forum] [--scope project|global]
    channel.py list [--scope] [--all]
    channel.py send <name> [text] --as <handle> [--to <handle>] [--kind <kind>]
                  [--tag <tag>] [--idempotency-key <key>] [--stdin] [--text-file <path>]
    channel.py messages <name> [--since <seq>] [--json] [--raw] [--limit <n>]
    channel.py wait <name> [--from <handle>] [--kind <kind>] [--timeout <s>]
    channel.py spawn <name> --agent <name> [--task <path>] [--prompt <text>]
                  [--handle <handle>] [--dry-run]
    channel.py workers [--json]
    channel.py kill <name> [--all]
    channel.py rm <name>
    channel.py prune

Store: `~/.myflow/channels/<project>/<channel>/events.jsonl` for project scope
and `~/.myflow/channels/__global__/<channel>/events.jsonl` for global scope.
Worker processes and logs live beside them. Writes take a lock file, allocate a
monotonic `seq`, and honor `--idempotency-key`.

Worker guard: `.myflow/config.yaml`

    channel:
      worker_guard:
        max_live_workers: 3
        idle_timeout: 900      # seconds

Runtime agent definitions live in `.myflow/agents/<name>.md`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path.cwd()
HOME_STORE = Path.home() / ".myflow" / "channels"
CONFIG_PATH = PROJECT_ROOT / ".myflow" / "config.yaml"
AGENTS_DIR = PROJECT_ROOT / ".myflow" / "agents"

DEFAULT_MAX_LIVE_WORKERS = 3
DEFAULT_IDLE_TIMEOUT = 900
LOCK_TIMEOUT_SECONDS = 10
STALE_LOCK_SECONDS = 10


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
# Paths and config
# ---------------------------------------------------------------------------


def _project_key() -> str:
    code = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    root = Path(code.stdout.strip()) if code.returncode == 0 and code.stdout.strip() else PROJECT_ROOT
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", root.name).strip("._-") or "project"
    digest = hashlib.sha1(str(root).encode("utf-8")).hexdigest()[:8]
    return f"{name}-{digest}"


def store_root(scope: str) -> Path:
    return HOME_STORE / ("__global__" if scope == "global" else _project_key())


def channel_dir(name: str, scope: str) -> Path:
    return store_root(scope) / name


def events_path(name: str, scope: str) -> Path:
    return channel_dir(name, scope) / "events.jsonl"


def workers_path(scope: str) -> Path:
    return store_root(scope) / "workers.json"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_scalar(raw: str) -> str:
    value = raw.strip()
    if value.startswith(("'", '"')) and value.endswith(("'", '"')) and len(value) >= 2:
        return value[1:-1]
    return value


def read_worker_guard() -> dict:
    guard = {"max_live_workers": DEFAULT_MAX_LIVE_WORKERS, "idle_timeout": DEFAULT_IDLE_TIMEOUT}
    if not CONFIG_PATH.is_file():
        return guard
    try:
        lines = CONFIG_PATH.read_text(encoding="utf-8").splitlines()
    except OSError:
        return guard
    in_channel = False
    in_guard = False
    for raw in lines:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        stripped = raw.strip()
        if indent == 0:
            in_channel = stripped in {"channel:", "channel :"}
            in_guard = False
            continue
        if not in_channel:
            continue
        if stripped.startswith("worker_guard:"):
            in_guard = True
            continue
        if in_guard and ":" in stripped:
            key, _, value = stripped.partition(":")
            number = int(_parse_scalar(value) or 0) if value.strip().lstrip("-").isdigit() else 0
            if key.strip() == "max_live_workers" and number > 0:
                guard["max_live_workers"] = number
            elif key.strip() == "idle_timeout" and number > 0:
                guard["idle_timeout"] = number
    return guard


# ---------------------------------------------------------------------------
# Event log
# ---------------------------------------------------------------------------


def read_events(name: str, scope: str) -> list[dict]:
    path = events_path(name, scope)
    if not path.is_file():
        return []
    events: list[dict] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    except OSError:
        return []
    return events


class _Lock:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.acquired = False

    def __enter__(self):
        deadline = time.time() + LOCK_TIMEOUT_SECONDS
        while time.time() < deadline:
            try:
                descriptor = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.close(descriptor)
                self.acquired = True
                return self
            except FileExistsError:
                try:
                    if time.time() - self.path.stat().st_mtime > STALE_LOCK_SECONDS:
                        self.path.unlink(missing_ok=True)
                        continue
                except OSError:
                    pass
                time.sleep(0.05)
        raise TimeoutError(f"could not lock {self.path}")

    def __exit__(self, *_exc) -> None:
        if self.acquired:
            self.path.unlink(missing_ok=True)


def append_event(name: str, scope: str, event: dict) -> dict:
    directory = channel_dir(name, scope)
    directory.mkdir(parents=True, exist_ok=True)
    path = events_path(name, scope)
    lock = _Lock(directory / "events.lock")
    with lock:
        events = read_events(name, scope)
        if event.get("idempotency_key"):
            for existing in events:
                if existing.get("idempotency_key") == event["idempotency_key"]:
                    return existing
        event["seq"] = (events[-1]["seq"] + 1) if events else 1
        event["ts"] = _now()
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")
        return event


def read_workers(scope: str) -> list[dict]:
    path = workers_path(scope)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    return data.get("workers", []) if isinstance(data, dict) else []


def write_workers(scope: str, workers: list[dict]) -> None:
    path = workers_path(scope)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"workers": workers}, indent=2, ensure_ascii=False), encoding="utf-8")


def is_alive(pid: object) -> bool:
    """Whether the process is still running.

    Windows cannot use the POSIX `kill(pid, 0)` probe: it fails with
    `SystemError`/`OSError` for a live process owned by another process. Ask the
    kernel for the exit code instead.
    """
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except (OSError, SystemError, ValueError):
        return False
    return True


def terminate(pid: object) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x0001, False, pid)  # PROCESS_TERMINATE
        if not handle:
            return False
        try:
            return bool(kernel32.TerminateProcess(handle, 1))
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 15)
        return True
    except (OSError, SystemError, ValueError):
        return False


def last_event_time(name: str, scope: str, handle: str) -> float | None:
    latest: float | None = None
    for event in read_events(name, scope):
        if event.get("speaker") != handle:
            continue
        try:
            parsed = datetime.strptime(str(event.get("ts")), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        latest = parsed.timestamp()
    return latest


def _read_meta(name: str, scope: str) -> dict:
    path = channel_dir(name, scope) / "meta.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _write_meta(name: str, scope: str, meta: dict) -> None:
    path = channel_dir(name, scope) / "meta.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")


def _slug(text: str, max_length: int = 24) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (slug or "thread")[:max_length].strip("-") or "thread"


def fold_threads(events: list[dict]) -> list[dict]:
    """Fold thread events into ordered thread records."""
    threads: dict[str, dict] = {}
    order: list[str] = []
    for event in events:
        if event.get("kind") != "thread":
            continue
        thread_id = event.get("thread")
        if not thread_id:
            continue
        if thread_id not in threads:
            threads[thread_id] = {
                "id": thread_id,
                "title": event.get("title") or "(untitled)",
                "state": "open",
                "author": event.get("speaker"),
                "created_at": event.get("ts"),
                "updated_at": event.get("ts"),
                "posts": [],
            }
            order.append(thread_id)
        thread = threads[thread_id]
        action = event.get("action", "reply")
        if action == "open" and event.get("title"):
            thread["title"] = event["title"]
        elif action == "rename" and event.get("title"):
            thread["title"] = event["title"]
        elif action == "close":
            thread["state"] = "closed"
        elif action == "reopen":
            thread["state"] = "open"
        thread["updated_at"] = event.get("ts")
        thread["posts"].append(
            {
                "seq": event.get("seq"),
                "action": action,
                "speaker": event.get("speaker"),
                "tag": event.get("tag"),
                "text": event.get("text"),
                "ts": event.get("ts"),
            }
        )
    return [threads[thread_id] for thread_id in order]


def fold_context(events: list[dict]) -> list[dict]:
    """Fold context events into the current context set."""
    items: dict[str, dict] = {}
    for event in events:
        if event.get("kind") != "context":
            continue
        context_id = event.get("context_id")
        if not context_id:
            continue
        if event.get("action") == "delete":
            items.pop(context_id, None)
            continue
        items[context_id] = {
            "id": context_id,
            "target": event.get("target", "channel"),
            "thread": event.get("thread"),
            "kind": event.get("context_kind"),
            "label": event.get("label"),
            "value": event.get("value"),
            "added_at": event.get("ts"),
        }
    return list(items.values())


def fold_title(events: list[dict]) -> str | None:
    """The last title event wins; an empty title clears it."""
    title: str | None = None
    for event in events:
        if event.get("kind") == "title":
            title = event.get("title") or None
    return title


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def _require_channel(name: str, scope: str) -> bool:
    if not events_path(name, scope).is_file():
        print(f"error: unknown channel '{name}' in scope '{scope}'", file=sys.stderr)
        return False
    return True


def cmd_create(args: argparse.Namespace) -> int:
    directory = channel_dir(args.name, args.scope)
    if events_path(args.name, args.scope).is_file():
        print(f"error: channel '{args.name}' already exists", file=sys.stderr)
        return 1
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "meta.json").write_text(
        json.dumps({"name": args.name, "type": args.type, "scope": args.scope, "created_at": _now()}, indent=2),
        encoding="utf-8",
    )
    events_path(args.name, args.scope).touch()
    print(f"created: {args.name} ({args.type}, {args.scope})")
    print(f"store:   {directory}")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    buckets = [("global", HOME_STORE / "__global__")] if args.scope == "global" else [("project", store_root("project"))]
    if args.all:
        buckets = [("project", store_root("project")), ("global", HOME_STORE / "__global__")]

    rows: list[str] = []
    for scope, root in buckets:
        if not root.is_dir():
            continue
        for entry in sorted(root.iterdir()):
            if not entry.is_dir() or not (entry / "events.jsonl").is_file():
                continue
            kind = "chat"
            try:
                kind = json.loads((entry / "meta.json").read_text(encoding="utf-8")).get("type", "chat")
            except (json.JSONDecodeError, OSError):
                pass
            rows.append(f"{entry.name}\t{kind}\t{scope}\t{len(read_events(entry.name, scope))} event(s)")
    print("\n".join(rows) if rows else "no channels")
    return 0


def cmd_post(args: argparse.Namespace) -> int:
    if not _require_channel(args.name, args.scope):
        return 1
    meta = _read_meta(args.name, args.scope)
    if meta.get("type") != "forum":
        print(f"error: '{args.name}' is not a forum channel (create it with --type forum)", file=sys.stderr)
        return 1
    text = sys.stdin.read() if args.stdin else (args.text or "")
    text = text.strip()
    if not text:
        print("error: empty post", file=sys.stderr)
        return 1

    events = read_events(args.name, args.scope)
    taken = {thread["id"] for thread in fold_threads(events)}
    base = _slug(args.title)
    thread_id = base
    suffix = 2
    while thread_id in taken:
        thread_id = f"{base}-{suffix}"
        suffix += 1

    event = append_event(
        args.name,
        args.scope,
        {
            "kind": "thread",
            "action": "open",
            "thread": thread_id,
            "title": args.title,
            "text": text,
            "speaker": args.as_handle,
            "tag": args.tag,
            "idempotency_key": args.idempotency_key,
        },
    )
    if event.get("action") == "open" and event.get("thread") != thread_id:
        print(f"posted: #{event['seq']} thread {event['thread']} (duplicate)")
        return 0
    print(f"posted: #{event['seq']} thread {thread_id}")
    return 0


def cmd_forum(args: argparse.Namespace) -> int:
    if not _require_channel(args.name, args.scope):
        return 1
    threads = fold_threads(read_events(args.name, args.scope))
    if args.state != "all":
        threads = [thread for thread in threads if thread["state"] == args.state]
    if args.json:
        print(json.dumps({"title": fold_title(read_events(args.name, args.scope)), "threads": threads}, ensure_ascii=False))
        return 0
    if not threads:
        print("(no threads)")
        return 0
    for thread in threads:
        print(f"{thread['id']}\t{thread['state']}\t{len(thread['posts'])} post(s)\t{thread['title']}\t{thread['updated_at']}")
    return 0


def cmd_thread(args: argparse.Namespace) -> int:
    if not _require_channel(args.name, args.scope):
        return 1
    threads = {thread["id"]: thread for thread in fold_threads(read_events(args.name, args.scope))}
    thread = threads.get(args.thread)
    if thread is None:
        print(f"error: unknown thread '{args.thread}'", file=sys.stderr)
        return 1

    if args.rename:
        if not args.as_handle:
            print("error: --as is required to rename a thread", file=sys.stderr)
            return 1
        event = append_event(
            args.name,
            args.scope,
            {"kind": "thread", "action": "rename", "thread": args.thread, "title": args.rename, "speaker": args.as_handle},
        )
        print(f"#{event['seq']} renamed {args.thread}: {args.rename}")
        return 0

    if args.close or args.reopen:
        if not args.as_handle:
            print("error: --as is required to change a thread", file=sys.stderr)
            return 1
        event = append_event(
            args.name,
            args.scope,
            {
                "kind": "thread",
                "action": "close" if args.close else "reopen",
                "thread": args.thread,
                "text": args.text or "",
                "speaker": args.as_handle,
            },
        )
        print(f"#{event['seq']} {event['action']} {args.thread}")
        return 0

    if args.text:
        if not args.as_handle:
            print("error: --as is required to reply", file=sys.stderr)
            return 1
        event = append_event(
            args.name,
            args.scope,
            {
                "kind": "thread",
                "action": "reply",
                "thread": args.thread,
                "text": args.text,
                "speaker": args.as_handle,
                "tag": args.tag,
                "idempotency_key": args.idempotency_key,
            },
        )
        print(f"#{event['seq']} reply {args.thread}")
        return 0

    if args.json:
        print(json.dumps(thread, ensure_ascii=False))
        return 0
    print(f"thread: {thread['id']} [{thread['state']}] {thread['title']}")
    for post in thread["posts"]:
        tag = f" [{post['tag']}]" if post.get("tag") else ""
        print(f"#{post['seq']} {post['action']}{tag} {post['speaker']}: {post['text']}")
    return 0


def cmd_context(args: argparse.Namespace) -> int:
    if not _require_channel(args.name, args.scope):
        return 1
    events = read_events(args.name, args.scope)

    if args.action == "list":
        items = fold_context(events)
        if args.thread:
            items = [item for item in items if item.get("thread") == args.thread]
        if args.json:
            print(json.dumps({"context": items}, ensure_ascii=False))
        elif not items:
            print("(no context)")
        else:
            for item in items:
                scope_label = item["thread"] or "channel"
                print(f"{item['id']}\t{scope_label}\t{item['kind']}\t{item['label'] or '-'}\t{item['value']}")
        return 0

    if args.action == "delete":
        if not args.context_id:
            print("error: context delete needs a context id", file=sys.stderr)
            return 1
        event = append_event(
            args.name,
            args.scope,
            {"kind": "context", "action": "delete", "context_id": args.context_id, "speaker": args.as_handle or "system"},
        )
        print(f"#{event['seq']} deleted context {args.context_id}")
        return 0

    if not args.value or not args.kind:
        print("error: context add needs --kind and --value", file=sys.stderr)
        return 1
    if args.target == "thread" and not args.thread:
        print("error: context add --target thread needs --thread <id>", file=sys.stderr)
        return 1
    context_id = args.context_id or f"{_slug(args.label or args.kind, 16)}-{int(time.time())}"
    event = append_event(
        args.name,
        args.scope,
        {
            "kind": "context",
            "action": "add",
            "context_id": context_id,
            "target": args.target,
            "thread": args.thread if args.target == "thread" else None,
            "context_kind": args.kind,
            "label": args.label,
            "value": args.value,
            "speaker": args.as_handle or "system",
        },
    )
    print(f"#{event['seq']} context {context_id} ({args.target})")
    return 0


def cmd_title(args: argparse.Namespace) -> int:
    if not _require_channel(args.name, args.scope):
        return 1
    title = " ".join(args.title).strip() if args.action == "set" else ""
    if args.action == "set" and not title:
        print("error: title set needs a title", file=sys.stderr)
        return 1
    event = append_event(args.name, args.scope, {"kind": "title", "title": title, "speaker": args.as_handle or "system"})
    if title:
        meta = _read_meta(args.name, args.scope)
        meta["title"] = title
        _write_meta(args.name, args.scope, meta)
        print(f"#{event['seq']} title set: {title}")
    else:
        meta = _read_meta(args.name, args.scope)
        meta.pop("title", None)
        _write_meta(args.name, args.scope, meta)
        print(f"#{event['seq']} title cleared")
    return 0


def cmd_send(args: argparse.Namespace) -> int:
    if not _require_channel(args.name, args.scope):
        return 1
    text = args.text
    if args.stdin:
        text = sys.stdin.read()
    elif args.text_file:
        text = Path(args.text_file).read_text(encoding="utf-8")
    elif isinstance(text, list):
        text = " ".join(text)
    text = (text or "").strip()
    if not text:
        print("error: empty message", file=sys.stderr)
        return 1
    kind = args.kind or ("interrupt" if args.tag == "interrupt" else "message")
    event = append_event(
        args.name,
        args.scope,
        {
            "kind": kind,
            "speaker": args.as_handle,
            "to": args.to,
            "tag": args.tag,
            "text": text,
            "idempotency_key": args.idempotency_key,
        },
    )
    print(f"#{event['seq']} {event['kind']} {event['speaker']}")
    return 0


def _format_event(event: dict, raw: bool) -> str:
    if raw:
        return json.dumps(event, ensure_ascii=False)
    target = event.get("to") or "all"
    tag = f" [{event.get('tag')}]" if event.get("tag") else ""
    return f"#{event['seq']} {event['ts']} {event['kind']}{tag} {event['speaker']} -> {target}: {event['text']}"


def cmd_messages(args: argparse.Namespace) -> int:
    if not _require_channel(args.name, args.scope):
        return 1
    events = [event for event in read_events(args.name, args.scope) if event.get("seq", 0) > (args.since or 0)]
    if args.limit:
        events = events[-args.limit :]
    if args.json:
        print(json.dumps({"events": events}, ensure_ascii=False))
        return 0
    if not events:
        print("(no messages)")
        return 0
    for event in events:
        print(_format_event(event, args.raw))
    return 0


def cmd_wait(args: argparse.Namespace) -> int:
    if not _require_channel(args.name, args.scope):
        return 1
    wanted_kind = args.kind or "done"
    deadline = time.time() + args.timeout
    seen = args.since or 0
    while True:
        for event in read_events(args.name, args.scope):
            if event.get("seq", 0) <= seen:
                continue
            if event.get("kind") != wanted_kind:
                continue
            if args.from_handle and event.get("speaker") != args.from_handle:
                continue
            print(_format_event(event, args.raw))
            return 0
        if time.time() >= deadline:
            print(f"timeout waiting for kind='{wanted_kind}'", file=sys.stderr)
            return 1
        time.sleep(args.poll)


def _pi_command() -> str:
    return shutil.which("pi") or "pi"


def cmd_spawn(args: argparse.Namespace) -> int:
    if not _require_channel(args.name, args.scope):
        return 1
    definition = AGENTS_DIR / f"{args.agent}.md"
    if not definition.is_file():
        print(f"error: no runtime agent definition at {definition}", file=sys.stderr)
        return 1

    scope = args.scope
    guard = read_worker_guard()
    workers = [worker for worker in read_workers(scope) if is_alive(worker.get("pid"))]
    if not args.dry_run:
        live = [worker for worker in workers if worker.get("channel") == args.name]
        if len(live) >= guard["max_live_workers"]:
            print(
                f"error: worker guard: {len(live)} live worker(s) >= max_live_workers={guard['max_live_workers']}",
                file=sys.stderr,
            )
            return 1
        write_workers(scope, workers)

    handle = args.handle or f"{args.agent}-{int(time.time())}"
    events = read_events(args.name, args.scope)
    since = events[-1]["seq"] if events else 0
    task_line = f"Active task: {args.task}" if args.task else "Active task: (none)"
    instruction = args.prompt or "Read the channel inbox, follow the newest instruction addressed to you, then report."
    worker_prompt = "\n".join(
        [
            task_line,
            f"Channel: {args.name} (scope {scope})",
            f"Your handle: {handle}",
            f"Log: {events_path(args.name, scope)}",
            "",
            "Inbox:",
            f"  python3 ./.myflow/scripts/channel.py messages {args.name} --scope {scope} --json",
            "",
            "Request:",
            instruction,
            "",
            "When finished, report with:",
            f'  python3 ./.myflow/scripts/channel.py send {args.name} --scope {scope} --as {handle} '
            '--to dispatcher --kind done --text "<one-line summary>"',
        ]
    )

    log_dir = channel_dir(args.name, scope) / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{handle}.log"
    command = [_pi_command(), "-p", "--approve", "--append-system-prompt", str(definition)]
    if args.model:
        command += ["--model", args.model]
    command.append(worker_prompt)

    if args.dry_run:
        print(json.dumps({"handle": handle, "command": command, "log": str(log_path), "since": since}, ensure_ascii=False))
        return 0

    kwargs: dict = {"cwd": str(PROJECT_ROOT), "stdin": subprocess.DEVNULL, "stdout": open(log_path, "wb"), "stderr": subprocess.STDOUT}
    # A worker receives a work order, not a user turn: suppress the per-turn
    # workflow breadcrumb so it does not stop to ask about task creation.
    kwargs["env"] = {**os.environ, "MYFLOW_SKIP_BREADCRUMB": "1"}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    process = subprocess.Popen(command, **kwargs)  # noqa: SIM115 - log handle lives with the child

    workers.append(
        {
            "handle": handle,
            "channel": args.name,
            "scope": scope,
            "agent": args.agent,
            "pid": process.pid,
            "started_at": _now(),
            "log": str(log_path),
        }
    )
    write_workers(scope, workers)
    print(f"spawned: {handle} (pid {process.pid}, agent {args.agent})")
    print(f"log:     {log_path}")
    print(f"wait:    python3 ./.myflow/scripts/channel.py wait {args.name} --scope {scope} --from {handle}")
    return 0


def cmd_workers(args: argparse.Namespace) -> int:
    guard = read_worker_guard()
    workers = [
        {**worker, "alive": is_alive(worker.get("pid"))}
        for worker in read_workers(args.scope)
    ]
    if args.json:
        print(json.dumps({"workers": workers, "guard": guard}, ensure_ascii=False))
        return 0
    if not workers:
        print("no workers")
        return 0
    for worker in workers:
        state = "alive" if worker["alive"] else "dead"
        print(f"{worker.get('handle')}\t{worker.get('agent')}\t{state}\tpid={worker.get('pid')}")
    return 0


def cmd_kill(args: argparse.Namespace) -> int:
    workers = read_workers(args.scope)
    survivors: list[dict] = []
    killed = 0
    for worker in workers:
        match = args.all or worker.get("handle") == args.name or worker.get("channel") == args.name
        if match and is_alive(worker.get("pid")):
            if terminate(worker.get("pid")):
                killed += 1
            continue
        survivors.append(worker)
    write_workers(args.scope, survivors)
    print(f"killed: {killed} worker(s)")
    return 0


def cmd_rm(args: argparse.Namespace) -> int:
    directory = channel_dir(args.name, args.scope)
    if not directory.is_dir():
        print(f"error: unknown channel '{args.name}'", file=sys.stderr)
        return 1
    shutil.rmtree(directory)
    print(f"removed: {args.name}")
    return 0


def cmd_prune(args: argparse.Namespace) -> int:
    guard = read_worker_guard()
    workers = read_workers(args.scope)
    kept: list[dict] = []
    killed_idle = 0
    for worker in workers:
        if not is_alive(worker.get("pid")):
            continue
        last = last_event_time(str(worker.get("channel")), args.scope, str(worker.get("handle")))
        if last is not None and time.time() - last > guard["idle_timeout"]:
            if terminate(worker.get("pid")):
                killed_idle += 1
                continue
        kept.append(worker)
    write_workers(args.scope, kept)
    print(f"pruned: {len(workers) - len(kept)} worker record(s), killed {killed_idle} idle worker(s)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="myflow channel runtime")
    sub = parser.add_subparsers(dest="command", required=True)

    def with_scope(sub_parser: argparse.ArgumentParser) -> argparse.ArgumentParser:
        sub_parser.add_argument("--scope", choices=["project", "global"], default="project")
        return sub_parser

    p_create = with_scope(sub.add_parser("create", help="create a channel"))
    p_create.add_argument("name")
    p_create.add_argument("--type", choices=["chat", "forum"], default="chat")
    p_create.set_defaults(func=cmd_create)

    p_list = with_scope(sub.add_parser("list", help="list channels"))
    p_list.add_argument("--all", action="store_true", help="include the global bucket")
    p_list.set_defaults(func=cmd_list)

    p_post = with_scope(sub.add_parser("post", help="open a thread in a forum channel"))
    p_post.add_argument("name")
    p_post.add_argument("title")
    p_post.add_argument("--as", dest="as_handle", required=True)
    p_post.add_argument("--text", default="")
    p_post.add_argument("--stdin", action="store_true")
    p_post.add_argument("--tag", default=None)
    p_post.add_argument("--idempotency-key", default=None)
    p_post.set_defaults(func=cmd_post)

    p_forum = with_scope(sub.add_parser("forum", help="list threads in a forum channel"))
    p_forum.add_argument("name")
    p_forum.add_argument("--state", choices=["open", "closed", "all"], default="open")
    p_forum.add_argument("--json", action="store_true")
    p_forum.set_defaults(func=cmd_forum)

    p_thread = with_scope(sub.add_parser("thread", help="view, reply to, close, or reopen a thread"))
    p_thread.add_argument("name")
    p_thread.add_argument("thread")
    p_thread.add_argument("--text", default="")
    p_thread.add_argument("--rename", default=None, help="new thread title")
    p_thread.add_argument("--as", dest="as_handle", default=None)
    p_thread.add_argument("--close", action="store_true")
    p_thread.add_argument("--reopen", action="store_true")
    p_thread.add_argument("--tag", default=None)
    p_thread.add_argument("--idempotency-key", default=None)
    p_thread.add_argument("--json", action="store_true")
    p_thread.set_defaults(func=cmd_thread)

    p_context = with_scope(sub.add_parser("context", help="manage channel or thread context"))
    p_context.add_argument("action", choices=["add", "list", "delete"])
    p_context.add_argument("name")
    p_context.add_argument("context_id", nargs="?", default=None)
    p_context.add_argument("--target", choices=["channel", "thread"], default="channel")
    p_context.add_argument("--thread", default=None)
    p_context.add_argument("--kind", default=None)
    p_context.add_argument("--value", default=None)
    p_context.add_argument("--label", default=None)
    p_context.add_argument("--as", dest="as_handle", default=None)
    p_context.add_argument("--json", action="store_true")
    p_context.set_defaults(func=cmd_context)

    p_title = with_scope(sub.add_parser("title", help="set or clear the channel title"))
    p_title.add_argument("action", choices=["set", "clear"])
    p_title.add_argument("name")
    p_title.add_argument("title", nargs="*", default=[])
    p_title.add_argument("--as", dest="as_handle", default=None)
    p_title.set_defaults(func=cmd_title)

    p_send = with_scope(sub.add_parser("send", help="append a message"))
    p_send.add_argument("name")
    p_send.add_argument("text", nargs="*", default=[], help="message text; long text should use --stdin or --text-file")
    p_send.add_argument("--as", dest="as_handle", required=True)
    p_send.add_argument("--to", default=None)
    p_send.add_argument("--kind", default=None)
    p_send.add_argument("--tag", default=None)
    p_send.add_argument("--idempotency-key", default=None)
    p_send.add_argument("--stdin", action="store_true")
    p_send.add_argument("--text-file", default=None)
    p_send.set_defaults(func=cmd_send)

    p_messages = with_scope(sub.add_parser("messages", help="read messages"))
    p_messages.add_argument("name")
    p_messages.add_argument("--since", type=int, default=0)
    p_messages.add_argument("--limit", type=int, default=0)
    p_messages.add_argument("--json", action="store_true")
    p_messages.add_argument("--raw", action="store_true")
    p_messages.set_defaults(func=cmd_messages)

    p_wait = with_scope(sub.add_parser("wait", help="wait for a completion event"))
    p_wait.add_argument("name")
    p_wait.add_argument("--from", dest="from_handle", default=None)
    p_wait.add_argument("--kind", default="done")
    p_wait.add_argument("--since", type=int, default=0)
    p_wait.add_argument("--timeout", type=float, default=600)
    p_wait.add_argument("--poll", type=float, default=0.5)
    p_wait.add_argument("--raw", action="store_true")
    p_wait.set_defaults(func=cmd_wait)

    p_spawn = with_scope(sub.add_parser("spawn", help="start a runtime-agent worker"))
    p_spawn.add_argument("name")
    p_spawn.add_argument("--agent", required=True)
    p_spawn.add_argument("--task", default=None)
    p_spawn.add_argument("--prompt", default=None)
    p_spawn.add_argument("--handle", default=None)
    p_spawn.add_argument("--model", default=None)
    p_spawn.add_argument("--dry-run", action="store_true")
    p_spawn.set_defaults(func=cmd_spawn)

    p_workers = with_scope(sub.add_parser("workers", help="list spawned workers"))
    p_workers.add_argument("--json", action="store_true")
    p_workers.set_defaults(func=cmd_workers)

    p_kill = with_scope(sub.add_parser("kill", help="stop workers"))
    p_kill.add_argument("name", nargs="?", default="")
    p_kill.add_argument("--all", action="store_true")
    p_kill.set_defaults(func=cmd_kill)

    p_rm = with_scope(sub.add_parser("rm", help="delete a channel"))
    p_rm.add_argument("name")
    p_rm.set_defaults(func=cmd_rm)

    p_prune = with_scope(sub.add_parser("prune", help="drop dead workers and stop idle ones"))
    p_prune.set_defaults(func=cmd_prune)

    args, extra = parser.parse_known_args()
    if extra:
        # `send chat --as me hello world`: argparse stops matching positionals
        # once optionals are interleaved, so trailing words are collected here.
        if args.command == "send":
            args.text = [*(args.text or []), *extra]
        else:
            parser.error("unrecognized arguments: " + " ".join(extra))
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
