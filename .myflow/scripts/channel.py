#!/usr/bin/env python3
"""Local multi-agent channel runtime for the Myflow Pi harness.

A channel is a durable, project-scoped event log that agents and workers use to
talk to each other. Workers are ordinary `pi` processes started with a runtime
agent definition; the dispatcher sends a request, then waits for the worker's
`done` event.

Usage:
    channel.py create <name> [--scope project|global]
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

Store: `~/.pi/myflow/channels/<project>/<channel>/events.jsonl` for project
scope and `~/.pi/myflow/channels/__global__/<channel>/events.jsonl` for global
scope. Never `~/.myflow`: that name is the project-root marker. Worker
processes and logs live beside them. Writes take a lock file, allocate a
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
# Deliberately NOT `~/.myflow`: `.myflow/` is the project-root marker, so a
# user-level store of that name would make every project under the home
# directory resolve its root to the home directory.
HOME_STORE = Path.home() / ".pi" / "myflow" / "channels"
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
        lines = CONFIG_PATH.read_text(encoding="utf-8-sig").splitlines()
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
        for line in path.read_text(encoding="utf-8-sig").splitlines():
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
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError):
        return []
    return data.get("workers", []) if isinstance(data, dict) else []


def write_workers(scope: str, workers: list[dict]) -> None:
    path = workers_path(scope)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"workers": workers}, indent=2, ensure_ascii=False), encoding="utf-8")


def is_alive(pid: object) -> bool:
    """Whether the process is still running.

    The POSIX `kill(pid, 0)` probe does not work here: Windows fails it with
    `SystemError`/`OSError` for a live process owned by another process. Ask the
    kernel for the exit code instead.
    """
    if not isinstance(pid, int) or pid <= 0:
        return False
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


def terminate_tree(pid: object) -> bool:
    """Stop a worker together with everything it started.

    A worker's own children (MCP servers, for one) inherit its log handle and
    outlive a kill aimed at the worker alone, which is why a channel could not
    be removed right after its worker stopped. Workers are started detached /
    in their own session, so the whole tree can be addressed at once.
    """
    if not isinstance(pid, int) or pid <= 0:
        return False
    completed = subprocess.run(
        ["taskkill", "/T", "/F", "/PID", str(pid)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return completed.returncode == 0


def descendant_pids(root_pid: object) -> list[int]:
    """Return every process descended from `root_pid`, nearest generation first.

    Why the snapshot has to happen *before* the kill: the Windows process table
    records a child's parent in `th32ParentProcessID`, and that link is what
    this walk follows. `taskkill /T` destroys the tree, after which the links are
    gone and nothing can reconstruct the descendants. So a caller that wants to
    wait for a whole tree must snapshot first, then kill.

    Why not parse `taskkill` output: that text is localized (a Chinese Windows
    reports the same outcome with different words), and this project has been
    bitten by gates that silently stop matching when their expected text
    changes. The process table is the same on every locale.

    Best effort, never raises: a failing snapshot, an unreadable entry, or an
    empty table yields `[]`. That degrades to "wait for the root alone", which
    is exactly the pre-existing behavior, instead of crashing `rm`.
    """
    if not isinstance(root_pid, int) or root_pid <= 0:
        return []
    try:
        import ctypes
        from ctypes import wintypes

        TH32CS_SNAPPROCESS = 0x00000002
        # `ctypes` defaults a HANDLE return to a signed 32-bit int, so the
        # INVALID_HANDLE_VALUE sentinel reads back as -1; `is_alive` relies on
        # the same convention.
        INVALID_HANDLE_VALUE = -1

        class PROCESSENTRY32(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t),  # ULONG_PTR: pointer-sized
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", ctypes.c_char * 260),
            ]

        kernel32 = ctypes.windll.kernel32
        snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if snapshot == INVALID_HANDLE_VALUE or snapshot <= 0:
            return []
        children: dict[int, list[int]] = {}
        try:
            entry = PROCESSENTRY32()
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
            if not kernel32.Process32First(snapshot, ctypes.byref(entry)):
                return []
            while True:
                child = int(entry.th32ProcessID)
                parent = int(entry.th32ParentProcessID)
                if child != parent:
                    children.setdefault(parent, []).append(child)
                if not kernel32.Process32Next(snapshot, ctypes.byref(entry)):
                    break
        finally:
            kernel32.CloseHandle(snapshot)
    except Exception:
        # Any ctypes/kernel32 surprise is a degradation, not a failure: the
        # caller still kills the tree, it just cannot wait for the descendants.
        return []

    # Breadth-first over the parent -> children map. `seen` starts with the root
    # so a reused pid cannot make the walk loop or re-list an ancestor.
    descendants: list[int] = []
    seen = {root_pid}
    frontier = [root_pid]
    while frontier:
        nxt: list[int] = []
        for parent in frontier:
            for child in children.get(parent, []):
                if child in seen:
                    continue
                seen.add(child)
                descendants.append(child)
                nxt.append(child)
        frontier = nxt
    return descendants


def wait_for_exit(pids: list[object], timeout: float = 5.0) -> None:
    """Block until exactly these pids are gone, so their handles are released.

    Terminating a process is asynchronous: the exit code and the handles it
    held stay alive for a moment, which is long enough for a delete right after
    the kill to fail with WinError 32.

    This waits for the pids it is handed and nothing more. Stopping a tree needs
    the descendants on the list too: `terminate_tree` stops them, but they
    cannot be discovered here, so a caller must snapshot the tree first (see
    `descendant_pids`) and pass the whole thing.
    """
    pending = [pid for pid in pids if isinstance(pid, int) and pid > 0]
    deadline = time.monotonic() + timeout
    while pending and time.monotonic() < deadline:
        pending = [pid for pid in pending if is_alive(pid)]
        if pending:
            time.sleep(0.1)


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
    events_path(args.name, args.scope).touch()
    print(f"created: {args.name} ({args.scope})")
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
            rows.append(f"{entry.name}\t{scope}\t{len(read_events(entry.name, scope))} event(s)")
    print("\n".join(rows) if rows else "no channels")
    return 0


def cmd_send(args: argparse.Namespace) -> int:
    if not _require_channel(args.name, args.scope):
        return 1
    # `--text` is the documented form; keep the positional form working too.
    # Explicit sources win over positional words, and the precedence is
    # deterministic when more than one is supplied.
    text = args.text_opt
    if args.stdin:
        text = sys.stdin.read()
    elif args.text_file:
        text = Path(args.text_file).read_text(encoding="utf-8")
    elif text is None:
        text = " ".join(args.text)
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
    # The guards run for --dry-run too: a plan that could not be launched is
    # worth refusing up front rather than reporting as ready.
    live = [worker for worker in workers if worker.get("channel") == args.name]
    if len(live) >= guard["max_live_workers"]:
        print(
            f"error: worker guard: {len(live)} live worker(s) >= max_live_workers={guard['max_live_workers']}",
            file=sys.stderr,
        )
        return 1
    if args.agent == "reviewer":
        # One writer per tree: a reviewer fixes files, so two of them in the
        # same project would edit the working tree at once.
        reviewers = [worker for worker in workers if worker.get("agent") == "reviewer"]
        if reviewers:
            handles = ", ".join(str(worker.get("handle")) for worker in reviewers)
            print(
                f"error: one reviewer per tree: {handles} is already live; "
                "wait for it (or stop it) before starting another",
                file=sys.stderr,
            )
            return 1
    if not args.dry_run:
        write_workers(scope, workers)

    handle = args.handle or f"{args.agent}-{int(time.time())}"
    events = read_events(args.name, args.scope)
    since = events[-1]["seq"] if events else 0
    task_line = f"Active task: {args.task}" if args.task else "Active task: (none)"
    instruction = args.prompt or "Read the channel inbox, follow the newest instruction addressed to you, then report."
    worker_prompt = "\n".join(
        [
            task_line,
            "Delegated work order: nobody is watching this session. Do not create or",
            "manage myflow tasks, and do not ask whether to create one.",
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

    # A worker receives a work order, not a user turn: suppress the per-turn
    # workflow breadcrumb so it does not stop to ask about task creation.
    worker_env = {**os.environ, "MYFLOW_SKIP_BREADCRUMB": "1"}
    if args.agent == "reviewer":
        # A channel worker is an ordinary pi process, not a dispatched
        # sub-agent, so it carries no agent type. Flag review workers so the
        # verify gate holds them to the same standard as a myflow-check
        # sub-agent.
        worker_env["MYFLOW_VERIFY_GATE"] = "1"

    if args.dry_run:
        # Never dump the whole environment: it carries provider credentials and
        # proxy configuration that must not leak into a plan or a CI log.
        safe_env = {key: value for key, value in worker_env.items() if key.startswith("MYFLOW_")}
        print(
            json.dumps(
                {"handle": handle, "command": command, "env": safe_env, "log": str(log_path), "since": since},
                ensure_ascii=False,
            )
        )
        return 0

    kwargs: dict = {"cwd": str(PROJECT_ROOT), "stdin": subprocess.DEVNULL, "stdout": open(log_path, "wb"), "stderr": subprocess.STDOUT}
    kwargs["env"] = worker_env
    kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
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
            if terminate_tree(worker.get("pid")):
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
    workers = read_workers(args.scope)
    live = [worker for worker in workers if worker.get("channel") == args.name and is_alive(worker.get("pid"))]
    if live and not args.force:
        handles = ", ".join(str(worker.get("handle")) for worker in live)
        print(
            f"error: '{args.name}' still has live worker(s): {handles}; "
            f"stop them with `kill {args.name}` or pass --force",
            file=sys.stderr,
        )
        return 1
    if live:
        # Snapshot each tree *before* killing it: `taskkill /T` erases the very
        # parent links the walk needs, so enumerating afterwards finds nothing
        # and the wait silently falls back to the root alone. Keep the root in
        # the list too -- its handles are the first the delete trips over.
        doomed: list[int] = []
        for worker in live:
            pid = worker.get("pid")
            if not isinstance(pid, int) or pid <= 0:
                continue
            for member in (pid, *descendant_pids(pid)):
                if member not in doomed:
                    doomed.append(member)
        for worker in live:
            terminate_tree(worker.get("pid"))
        stopped = {worker.get("pid") for worker in live}
        write_workers(
            args.scope,
            [worker for worker in workers if worker.get("pid") not in stopped],
        )
        wait_for_exit(doomed)
    for attempt in range(10):
        try:
            shutil.rmtree(directory)
            break
        except PermissionError:
            if attempt == 9:
                print(
                    f"error: could not delete '{args.name}': a process still holds a file inside it",
                    file=sys.stderr,
                )
                return 1
            time.sleep(0.5)
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
            if terminate_tree(worker.get("pid")):
                killed_idle += 1
                continue
        kept.append(worker)
    write_workers(args.scope, kept)
    print(f"pruned: {len(workers) - len(kept)} worker record(s), killed {killed_idle} idle worker(s)")
    return 0


def main() -> int:
    if os.name != "nt":
        print("error: myflow runs on Windows only (Git Bash required)", file=sys.stderr)
        return 1
    parser = argparse.ArgumentParser(description="myflow channel runtime")
    sub = parser.add_subparsers(dest="command", required=True)

    def with_scope(sub_parser: argparse.ArgumentParser) -> argparse.ArgumentParser:
        sub_parser.add_argument("--scope", choices=["project", "global"], default="project")
        return sub_parser

    p_create = with_scope(sub.add_parser("create", help="create a channel"))
    p_create.add_argument("name")
    p_create.set_defaults(func=cmd_create)

    p_list = with_scope(sub.add_parser("list", help="list channels"))
    p_list.add_argument("--all", action="store_true", help="include the global bucket")
    p_list.set_defaults(func=cmd_list)

    p_send = with_scope(sub.add_parser("send", help="append a message"))
    p_send.add_argument("name")
    p_send.add_argument("text", nargs="*", default=[], help="message text; long text should use --stdin or --text-file")
    p_send.add_argument("--text", dest="text_opt", default=None, help="message text (equivalent to the positional form)")
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
    p_rm.add_argument("--force", action="store_true", help="stop this channel's live workers first")
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
