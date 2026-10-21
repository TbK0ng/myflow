#!/usr/bin/env python3
"""Build (and prove) a release of the myflow payload.

The payload list lives in exactly one place: ``tools/release-payload.json``.
``tests/scaffold.test.ts`` reads it too, so adding or removing a payload file is
a manifest edit, never a second list in either consumer.

Usage
-----
    python tools/release.py --check [--root DIR]
    python tools/release.py --out OUTDIR [--root DIR] [--verify]

``--check``  validate the manifest and the payload, produce nothing.
``--out``    build ``OUTDIR/myflow-<version>/`` plus a reproducible ``.zip``.
``--verify`` extract the built tree into a temporary project and smoke-test it.

Exit code is 0 only when every requested step passed.
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
import tempfile
import time
import zipfile
from pathlib import Path

#: Where the single payload manifest lives, relative to the repository root.
MANIFEST_PATH = ("tools", "release-payload.json")
#: The installer instructions, copied verbatim into the release.
INSTALL_SOURCE = ("tools", "INSTALL.md")
#: Names of the two installer documents inside a release.
INSTALL_DOC = "INSTALL.md"
RELEASE_DOC = "RELEASE.md"

#: Paths that must never enter a release, even if someone lists them in the
#: manifest: project-owned state plus harness development machinery.
FORBIDDEN = (
    "dist",
    ".git",
    ".myflow/spec",
    ".myflow/tasks",
    ".myflow/archive",
    ".myflow/.runtime",
    "tests",
    "tools",
    "package.json",
    "tsconfig.json",
)

#: Substrings in payload *content* that mean "a path from the build machine".
ABSOLUTE_NEEDLES = (
    "C:\\Users\\",
    "C:/Users/",
    "/Users/",
    "/home/",
)

#: The eight Pi hooks the extension must register, sorted.
EXPECTED_HOOKS = (
    "agent_before_settle",
    "before_agent_start",
    "context",
    "input",
    "session_before_compact",
    "session_shutdown",
    "session_start",
    "tool_call",
)
#: Tools the extension must register in the release copy.
EXPECTED_TOOLS = (
    "myflow_subagent",
    "myflow_ask_user",
    "myflow_request_approval",
    "myflow_bg_start",
    "myflow_bg_output",
    "myflow_bg_list",
    "myflow_bg_stop",
)
#: Commands the extension must register.
EXPECTED_COMMANDS = ("myflow-status",)
#: Project-owned trees a release must not contain.
FORBIDDEN_IN_RELEASE = (".myflow/spec", ".myflow/tasks", ".myflow/.runtime", "tests", "tools")


# ---------------------------------------------------------------------------
# Root, manifest, and payload selection
# ---------------------------------------------------------------------------


def repo_root(explicit: str | None = None) -> Path:
    """The tree every path in this run is relative to."""
    if explicit:
        return Path(explicit).resolve()
    return Path(__file__).resolve().parent.parent


def read_manifest(root: Path) -> dict:
    """Load and shape-check the one payload manifest."""
    path = root.joinpath(*MANIFEST_PATH)
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"{path}: missing payload manifest")
    except json.JSONDecodeError as error:
        fail(f"{path}: invalid JSON: {error}")
    for key in ("dirs", "trees", "files", "exclude"):
        if not isinstance(manifest.get(key), list):
            fail(f"{path}: `{key}` must be a list")
    return manifest


#: Characters `segment_matches` must escape before translating glob wildcards.
_REGEX_SPECIAL = re.compile(r"[.+^${}()|[\]\\]")


def segment_matches(pattern: str, segment: str) -> bool:
    """One `exclude` segment: `*` and `?` match inside the segment only."""
    source = _REGEX_SPECIAL.sub(lambda match: "\\" + match.group(0), pattern)
    source = source.replace("*", "[^/]*").replace("?", "[^/]")
    return re.fullmatch(source, segment) is not None


def path_matches(pattern: list[str], path: list[str]) -> bool:
    """Segment-wise fnmatch: a `**` segment matches any number of segments.

    Same semantics as `pathMatches` in `tests/scaffold.test.ts`; the rule *table*
    comes only from the manifest, so this implementation has no second list.
    """
    if not pattern:
        return not path
    head, rest = pattern[0], pattern[1:]
    if head == "**":
        return any(path_matches(rest, path[index:]) for index in range(len(path) + 1))
    return bool(path) and segment_matches(head, path[0]) and path_matches(rest, path[1:])


def matches_exclude(manifest: dict, rel_path: str) -> bool:
    """Whether a project-relative `/`-separated path is filtered out."""
    segments = rel_path.split("/")
    return any(path_matches(rule.split("/"), segments) for rule in manifest["exclude"])


def payload_entries(root: Path, manifest: dict) -> tuple[list[str], list[str]]:
    """The payload as `(copied, skipped)` lists of project-relative paths.

    A pruned directory drops its whole subtree, so its contents are neither
    copied nor walked - that is how `__pycache__/` never reaches a release.
    """
    copied: list[str] = []
    skipped: list[str] = []

    def visit(directory: Path, rel: str) -> None:
        for entry in sorted(directory.iterdir(), key=lambda item: item.name):
            child = f"{rel}/{entry.name}"
            if matches_exclude(manifest, child):
                skipped.append(child)
            elif entry.is_dir():
                visit(entry, child)
            elif entry.is_file():
                copied.append(child)

    for tree in [*manifest["dirs"], *manifest["trees"]]:
        visit(root / tree, tree)
    for single in manifest["files"]:
        if matches_exclude(manifest, single):
            skipped.append(single)
        else:
            copied.append(single)
    return sorted(copied), sorted(skipped)


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


def forbidden_owner(rel_path: str) -> str | None:
    """The `FORBIDDEN` entry that owns `rel_path`, if any."""
    for bad in FORBIDDEN:
        if rel_path == bad or rel_path.startswith(bad + "/"):
            return bad
    return None


def forbidden_in_payload(rel_paths: list[str]) -> list[str]:
    """The selection that must never be copied, whatever the manifest says."""
    return [rel for rel in rel_paths if forbidden_owner(rel) is not None]


def manifest_problems(root: Path, manifest: dict) -> list[str]:
    """Every manifest entry must exist and must not name a forbidden path."""
    problems: list[str] = []
    for key in ("dirs", "trees", "files"):
        for raw in manifest[key]:
            if not isinstance(raw, str) or not raw.strip():
                problems.append(f"{key}: {raw!r}: not a non-empty path")
                continue
            rel = raw.strip().strip("/")
            if ".." in rel.split("/"):
                problems.append(f"{key}: {raw}: must stay inside the repository")
                continue
            if not (root / rel).exists():
                problems.append(f"{key}: {rel}: does not exist under {root}")
            owner = forbidden_owner(rel)
            if owner:
                problems.append(f"{key}: {rel}: forbidden ({owner} never ships in a release)")
    if not [*manifest["dirs"], *manifest["trees"], *manifest["files"]]:
        problems.append(f"{'/'.join(MANIFEST_PATH)}: the payload would be empty")
    install = root.joinpath(*INSTALL_SOURCE)
    if not install.is_file():
        problems.append(f"{install}: missing (it is copied into every release)")
    return problems


def absolute_path_hits(root: Path, rel_paths: list[str]) -> list[str]:
    """`path:line: needle` for every payload line naming a machine root."""
    needles = list(ABSOLUTE_NEEDLES)
    for spelling in {str(root), root.as_posix(), str(root).replace("\\", "/")}:
        if spelling:
            needles.append(spelling)
    lowered = [(needle, needle.lower()) for needle in needles]
    hits: list[str] = []
    for rel in rel_paths:
        data = (root / rel).read_bytes()
        if b"\x00" in data:
            continue  # binary payload file: a text scan proves nothing
        text = data.decode("utf-8", "replace")
        for number, line in enumerate(text.splitlines(), start=1):
            haystack = line.lower()
            for needle, needle_lower in lowered:
                if needle_lower in haystack:
                    hits.append(f"{rel}:{number}: {needle}")
                    break
    return hits


def run_check(root: Path) -> int:
    """`--check`: validate the manifest and the payload, produce nothing."""
    manifest = read_manifest(root)
    problems = manifest_problems(root, manifest)
    if problems:
        for problem in problems:
            print(f"check: FAIL {problem}", file=sys.stderr)
        return 1

    copied, skipped = payload_entries(root, manifest)
    offenders = forbidden_in_payload(copied)
    if offenders:
        for rel in offenders:
            print(f"check: FAIL payload entry {rel} is forbidden", file=sys.stderr)
        return 1

    hits = absolute_path_hits(root, copied)
    if hits:
        for hit in hits:
            print(f"check: FAIL machine path {hit}", file=sys.stderr)
        return 1

    print(f"check: ok - would copy {len(copied)} files; {len(skipped)} excluded by the manifest")
    for rel in skipped:
        print(f"  excluded: {rel}")
    return 0


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


def version_of(root: Path) -> str:
    """The release version: `package.json`'s `version`."""
    path = root / "package.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"{path}: missing (it carries the release version)")
    except json.JSONDecodeError as error:
        fail(f"{path}: invalid JSON: {error}")
    version = data.get("version")
    if not isinstance(version, str) or not version.strip():
        fail(f"{path}: missing `version`")
    return version.strip()


def build_epoch() -> int:
    """`SOURCE_DATE_EPOCH` when set, else now - one value per build."""
    raw = os.environ.get("SOURCE_DATE_EPOCH")
    if raw is None or not raw.strip():
        return int(time.time())
    try:
        return int(raw.strip())
    except ValueError:
        fail(f"SOURCE_DATE_EPOCH: not an integer: {raw!r}")


def stamp(epoch: int) -> str:
    """The `built_at` / zip timestamp, always UTC so it is machine-independent."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def source_commit(root: Path) -> str:
    """The commit the release was built from, `unknown` outside a git checkout."""
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return "unknown"
    if result.returncode != 0:
        return "unknown"
    return result.stdout.strip() or "unknown"


def manifest_digest(root: Path) -> str:
    """sha256 of the manifest, so a release names the exact payload list."""
    return hashlib.sha256(root.joinpath(*MANIFEST_PATH).read_bytes()).hexdigest()


def release_doc(root: Path, version: str, copied: list[str], epoch: int) -> str:
    """`RELEASE.md`: what this archive is and how to rebuild it byte-for-byte."""
    groups: dict[str, int] = {}
    for rel in copied:
        parts = rel.split("/")
        key = "/".join(parts[:2]) if parts[0] == ".myflow" and len(parts) > 1 else parts[0]
        groups[key] = groups.get(key, 0) + 1
    lines = [
        f"# myflow {version}",
        "",
        "Built from `tools/release-payload.json`, the single payload manifest.",
        "",
        f"- version: {version}",
        f"- source_commit: {source_commit(root)}",
        f"- built_at: {stamp(epoch)}",
        f"- files: {len(copied)}",
        f"- manifest_sha256: {manifest_digest(root)}",
        "",
        "## Files by path",
        "",
        "| path | files |",
        "| --- | --- |",
    ]
    lines += [f"| `{key}` | {groups[key]} |" for key in sorted(groups)]
    lines += [
        "",
        f"`{INSTALL_DOC}` and `{RELEASE_DOC}` are installer documents; they are not",
        f"counted in the {len(copied)} payload files.",
        "",
        "## Rebuild",
        "",
        "```bash",
        "python tools/release.py --out dist",
        "```",
        "",
        "Every zip entry carries the `built_at` timestamp, so a fixed",
        "`SOURCE_DATE_EPOCH` reproduces a byte-identical archive.",
        "",
    ]
    return "\n".join(lines)


def write_zip(stage: Path, archive: Path, name: str, epoch: int) -> None:
    """Write `archive` with `/`-separated entries, one fixed timestamp, sorted."""
    date_time = time.gmtime(epoch)[:6]
    entries = sorted(
        path.relative_to(stage).as_posix() for path in stage.rglob("*") if path.is_file()
    )
    if archive.exists():
        archive.unlink()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for rel in entries:
            info = zipfile.ZipInfo(f"{name}/{rel}", date_time=date_time)
            info.compress_type = zipfile.ZIP_DEFLATED
            # Fixed creation system and mode: neither may depend on the builder.
            info.create_system = 3
            info.external_attr = 0o644 << 16
            bundle.writestr(info, (stage / rel).read_bytes())


def build(root: Path, outdir: Path, manifest: dict) -> Path:
    """Build `<outdir>/myflow-<version>/` and the sibling zip; return the tree."""
    version = version_of(root)
    name = f"myflow-{version}"
    epoch = build_epoch()
    stage = outdir / name
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)

    copied, _skipped = payload_entries(root, manifest)
    offenders = forbidden_in_payload(copied)
    if offenders:
        for rel in offenders:
            print(f"build: FAIL payload entry {rel} is forbidden", file=sys.stderr)
        raise SystemExit(1)
    for rel in copied:
        destination = stage / rel
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / rel, destination)

    shutil.copyfile(root.joinpath(*INSTALL_SOURCE), stage / INSTALL_DOC)
    (stage / RELEASE_DOC).write_text(release_doc(root, version, copied, epoch), encoding="utf-8")
    write_zip(stage, outdir / f"{name}.zip", name, epoch)
    print(f"build: {stage} ({len(copied)} payload files)")
    print(f"build: {outdir / f'{name}.zip'}")
    return stage


# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

NODE_SMOKE = """
const mod = await import(process.env.MYFLOW_RELEASE_INDEX);
const handlers = Object.create(null);
const tools = [];
const commands = Object.create(null);
const api = {
  on: (name, handler) => { handlers[name] = handler; },
  registerTool: (tool) => { tools.push(tool); },
  registerCommand: (name, options) => { commands[name] = options; },
  sendMessage: () => {},
  sendUserMessage: () => {},
  appendEntry: () => {},
  getActiveTools: () => [],
  setActiveTools: () => {},
  events: { emit: () => {}, on: () => () => {} },
};
mod.default(api);
const expectedHooks = __HOOKS__;
const actualHooks = Object.keys(handlers).sort();
if (JSON.stringify(actualHooks) !== JSON.stringify(expectedHooks)) {
  console.error("hooks: expected [" + expectedHooks.join(", ") + "] got [" + actualHooks.join(", ") + "]");
  process.exit(1);
}
const names = tools.map((tool) => tool.name);
const missingTools = __TOOLS__.filter((name) => !names.includes(name));
if (missingTools.length) {
  console.error("missing tools: " + missingTools.join(", "));
  process.exit(1);
}
const missingCommands = __COMMANDS__.filter((name) => !(name in commands));
if (missingCommands.length) {
  console.error("missing commands: " + missingCommands.join(", "));
  process.exit(1);
}
console.log("ok");
"""


def child_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """The ambient environment minus inherited myflow state, plus `extra`.

    Inherited `MYFLOW_*` values would make the extracted payload think it is
    running inside this repository's session instead of a fresh project.
    """
    env = {key: value for key, value in os.environ.items() if not key.startswith("MYFLOW_")}
    env.update(extra or {})
    return env


def verify(stage: Path) -> int:
    """Extract the built tree into a temporary project and smoke-test it."""
    project = Path(tempfile.mkdtemp(prefix="myflow-verify-"))
    try:
        target = project / stage.name
        shutil.copytree(stage, target)
        checks = (
            ("extension imports and registers hooks/tools/commands", check_extension, target),
            ("task.py current reports no active task", check_task_current, target),
            ("get_context.py emits the no_task workflow state", check_get_context, target),
            ("the extracted tree carries no project-owned paths", check_clean_tree, target),
        )
        for label, check, where in checks:
            print(f"verify: {label} ...", end=" ", flush=True)
            problem = check(where)
            if problem:
                print("FAIL")
                print(f"verify: {label}: {problem}", file=sys.stderr)
                return 1
            print("ok")
        return 0
    finally:
        shutil.rmtree(project, ignore_errors=True)


def check_extension(project: Path) -> str | None:
    """Step 1: Dynamic import the released extension against a fake Pi API."""
    index = project / ".pi" / "extensions" / "myflow" / "index.ts"
    if not index.is_file():
        return f"missing {index}"
    script = (
        NODE_SMOKE.replace("__HOOKS__", json.dumps(list(EXPECTED_HOOKS)))
        .replace("__TOOLS__", json.dumps(list(EXPECTED_TOOLS)))
        .replace("__COMMANDS__", json.dumps(list(EXPECTED_COMMANDS)))
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=str(project),
        env=child_env({"MYFLOW_RELEASE_INDEX": index.as_uri()}),
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        return detail[-1] if detail else f"node exited {result.returncode}"
    return None


def run_payload_script(project: Path, name: str, *args: str) -> tuple[int, str]:
    """Run one payload script with *this* interpreter and a clean environment."""
    script = project / ".myflow" / "scripts" / name
    if not script.is_file():
        return 1, f"missing {script}"
    result = subprocess.run(
        [sys.executable, str(script), *args],
        cwd=str(project),
        env=child_env(),
        capture_output=True,
        text=True,
        timeout=300,
    )
    return result.returncode, (result.stdout or "") + (result.stderr or "")


def check_task_current(project: Path) -> str | None:
    """Step 2: `task.py current` in the extracted project."""
    code, output = run_payload_script(project, "task.py", "current")
    if code != 0:
        return f"task.py current exited {code}: {output.strip()[:400]}"
    if "no active task" not in output:
        return f"task.py current said: {output.strip()[:400]}"
    return None


def check_get_context(project: Path) -> str | None:
    """Step 3: `get_context.py` emits the no_task block and the runtime context."""
    code, output = run_payload_script(project, "get_context.py")
    if code != 0:
        return f"get_context.py exited {code}: {output.strip()[:400]}"
    for needle in ("[workflow-state:no_task]", "## Session Runtime Context"):
        if needle not in output:
            return f"get_context.py output is missing {needle!r}"
    return None


def check_clean_tree(project: Path) -> str | None:
    """Step 4: No project-owned tree rode along into the release."""
    for rel in FORBIDDEN_IN_RELEASE:
        if (project / rel).exists():
            return f"the release contains {rel}"
    stray = sorted(
        path.relative_to(project).as_posix()
        for path in project.rglob("__pycache__")
    )
    if stray:
        return f"the release contains {stray[0]}"
    for doc in (INSTALL_DOC, RELEASE_DOC):
        if not (project / doc).is_file():
            return f"the release is missing {doc}"
    return None


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def fail(message: str) -> None:
    """Print a fatal problem and exit non-zero."""
    print(f"release: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_args(argv: list[str]) -> argparse.Namespace:
    """`--check` or `--out`; `--verify` only makes sense next to `--out`."""
    parser = argparse.ArgumentParser(
        prog="release.py",
        description="Build a myflow release from tools/release-payload.json.",
    )
    parser.add_argument("--check", action="store_true", help="validate the manifest and payload only")
    parser.add_argument(
        "--out",
        metavar="OUTDIR",
        nargs="?",
        const="dist",
        type=Path,
        help="build into OUTDIR (default: dist)",
    )
    parser.add_argument("--root", metavar="DIR", help="repository root (default: the script's parent)")
    parser.add_argument("--verify", action="store_true", help="smoke-test the built tree")
    args = parser.parse_args(argv)
    if not args.check and args.out is None:
        parser.error("one of --check or --out is required")
    if args.verify and args.out is None:
        parser.error("--verify requires --out")
    return args


def main(argv: list[str]) -> int:
    """Run the requested steps; the exit code is the verdict."""
    args = parse_args(argv)
    root = repo_root(args.root)

    if args.check:
        code = run_check(root)
        if code != 0 or args.out is None:
            return code

    outdir = (args.out or Path("dist")).expanduser()
    if not outdir.is_absolute():
        outdir = (root / outdir).resolve()
    manifest = read_manifest(root)
    stage = build(root, outdir, manifest)

    if args.verify:
        return verify(stage)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
