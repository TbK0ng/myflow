import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// `tools/release.py` builds a release from `tools/release-payload.json` — the
// one payload manifest that `tests/scaffold.test.ts` also reads. These cases
// pin the four promises the release makes: it validates before building, it
// ships nothing project-owned, its zip is reproducible, and the extracted tree
// still runs.

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "tools", "release.py");
const MANIFEST = join(ROOT, "tools", "release-payload.json");
const INSTALL = join(ROOT, "tools", "INSTALL.md");
/** `package.json` is the version source; R4 bumps it, so never hardcode it. */
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version as string;
const STAGE = `myflow-${VERSION}`;

/**
 * The interpreter used to run the release script. `python3` is the harness's
 * documented spelling, but a machine may only expose `python`; probe instead of
 * assuming, and let `MYFLOW_PYTHON` override when neither is the right one.
 */
const PYTHON = (() => {
  for (const candidate of [process.env.MYFLOW_PYTHON, "python3", "python"]) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf-8" });
    if (probe.status === 0) return candidate;
  }
  throw new Error("no `python3`/`python` on PATH; tools/release.py needs one");
})();

type Run = { status: number; stdout: string; stderr: string };

/** Run `tools/release.py` with `args`, from the repository root by default. */
function release(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Run {
  const result = spawnSync(PYTHON, [SCRIPT, ...args], {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    encoding: "utf-8",
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Run a short Python program with the same interpreter (used to read the zip). */
function python(script: string, args: string[]): Run {
  const result = spawnSync(PYTHON, ["-c", script, ...args], { encoding: "utf-8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Every file and directory in `dir`, `/`-separated and relative to it. */
function entriesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map((entry) => String(entry).split(sep).join("/"))
    .sort();
}

function isInside(rel: string, prefix: string): boolean {
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

/** A copy of the payload and its manifest — a valid `--root` to mutate. */
function makePayloadRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "myflow-release-root-"));
  for (const tree of [".pi", ".myflow/scripts", ".myflow/agents"]) {
    cpSync(join(ROOT, ...tree.split("/")), join(root, ...tree.split("/")), { recursive: true });
  }
  mkdirSync(join(root, ".myflow"), { recursive: true });
  cpSync(join(ROOT, ".myflow", "workflow.md"), join(root, ".myflow", "workflow.md"));
  mkdirSync(join(root, "tools"), { recursive: true });
  cpSync(MANIFEST, join(root, "tools", "release-payload.json"));
  cpSync(INSTALL, join(root, "tools", "INSTALL.md"));
  // The version source. It is a forbidden payload entry, so it is read but
  // never copied — `-3` asserts the release has no `package.json`.
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: VERSION }));
  return root;
}

test("-1: --check passes on the repository and reports how much it would copy", () => {
  const result = release(["--check"]);
  assert.equal(result.status, 0, `--check must pass on a clean repository:\n${result.stderr}`);
  const counted = result.stdout.match(/would copy (\d+) files/);
  assert.ok(counted, `--check must report a file count, got:\n${result.stdout}`);
  // The count is a real inventory, not "0 files": a broken manifest would be 0.
  assert.ok(Number(counted[1]) > 0, `--check reported an empty payload:\n${result.stdout}`);
  // Revert point: a payload file carrying a machine path fails this (-2).
});

test("-2: --check fails, naming the file and line, when the payload carries a machine path", () => {
  const root = makePayloadRoot();
  try {
    const payloadFile = join(root, ".pi", "extensions", "myflow-local-notes.txt");
    writeFileSync(payloadFile, "backend: none\n");

    // Guard the guard: the fixture itself must pass, or the failure below
    // could come from anything.
    const clean = release(["--check", "--root", root]);
    assert.equal(clean.status, 0, `the fixture root must be clean first:\n${clean.stderr}`);

    writeFileSync(payloadFile, "binary: C:/Users/foo/x.txt\n");
    const result = release(["--check", "--root", root]);
    // Revert point: dropping `absolute_path_hits` from `run_check` makes this 0.
    assert.notEqual(result.status, 0, "a machine path must fail --check");
    assert.match(result.stderr, /myflow-local-notes\.txt:1/, "the failure must name the file and line");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("-3: --out ships the payload plus the docs, and nothing project-owned", () => {
  const work = mkdtempSync(join(tmpdir(), "myflow-release-build-"));
  try {
    const outdir = join(work, "dist");
    const result = release(["--out", outdir]);
    assert.equal(result.status, 0, `--out failed:\n${result.stderr}`);

    const stage = join(outdir, STAGE);
    assert.ok(existsSync(join(stage, ".pi", "extensions", "myflow", "index.ts")), "the extension must ship");
    assert.ok(existsSync(join(stage, ".myflow", "workflow.md")), "workflow.md must ship");
    assert.ok(existsSync(join(stage, ".myflow", "scripts", "task.py")), "the scripts must ship");
    assert.ok(existsSync(join(stage, "INSTALL.md")), "INSTALL.md must ship");
    assert.ok(existsSync(join(stage, "RELEASE.md")), "RELEASE.md must ship");

    const entries = entriesUnder(stage);
    for (const forbidden of [".myflow/spec", ".myflow/tasks", ".myflow/archive", ".myflow/.runtime", "tests", "tools", "dist", "package.json", "tsconfig.json"]) {
      assert.deepEqual(
        entries.filter((rel) => isInside(rel, forbidden)),
        [],
        `the release must not contain ${forbidden}`,
      );
    }
    // Revert point: removing `**/__pycache__/**` from the manifest's `exclude`
    // makes the seeded `__pycache__` below reach the release.
    assert.deepEqual(
      entries.filter((rel) => rel.split("/").includes("__pycache__") || rel.endsWith(".pyc")),
      [],
      "machine-generated Python files must not ride along",
    );

    // The real repository may have no `__pycache__` at this moment, which would
    // make the assertion above vacuous. Seed the same tree in a copy and build
    // again, so `exclude` is proved to work even when the source is clean.
    const seeded = makePayloadRoot();
    try {
      const cache = join(seeded, ".myflow", "scripts", "__pycache__");
      mkdirSync(cache, { recursive: true });
      writeFileSync(join(cache, "task.cpython-313.pyc"), "pyc");
      writeFileSync(join(seeded, ".myflow", "scripts", "debug.log"), "log");
      writeFileSync(join(seeded, ".myflow", "scripts", "scratch.tmp"), "tmp");
      writeFileSync(join(seeded, ".myflow", "agents", ".DS_Store"), "ds");
      const seededOut = join(work, "seeded");
      const second = release(["--out", seededOut, "--root", seeded]);
      assert.equal(second.status, 0, `--out on the seeded root failed:\n${second.stderr}`);
      const seededEntries = entriesUnder(join(seededOut, STAGE));
      assert.ok(seededEntries.includes(".myflow/scripts/task.py"), "the seeded copy must still be the payload");
      assert.deepEqual(
        seededEntries.filter((rel) => /__pycache__|\.pyc$|\.log$|\.tmp$|\.DS_Store$/.test(rel)),
        [],
        "the manifest's exclude rules must drop machine files from a seeded tree",
      );
    } finally {
      rmSync(seeded, { recursive: true, force: true });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("-4: the zip has a myflow-<version>/ prefix and only /-separated entries", () => {
  const work = mkdtempSync(join(tmpdir(), "myflow-release-zip-"));
  try {
    const outdir = join(work, "dist");
    const result = release(["--out", outdir]);
    assert.equal(result.status, 0, `--out failed:\n${result.stderr}`);

    const archive = join(outdir, `${STAGE}.zip`);
    assert.ok(existsSync(archive), `missing ${archive}`);
    assert.ok(statSync(archive).size > 0, "the zip must not be empty");

    const listed = python(
      ["import json, sys, zipfile", "with zipfile.ZipFile(sys.argv[1]) as bundle:", "    print(json.dumps(bundle.namelist()))"].join("\n"),
      [archive],
    );
    assert.equal(listed.status, 0, `reading the zip failed:\n${listed.stderr}`);
    const names = JSON.parse(listed.stdout) as string[];

    assert.ok(names.length > 0, "the zip must contain entries");
    // Revert point: writing `path.relative_to(stage)` (OS separators) or a
    // missing prefix turns this red.
    assert.deepEqual(names.filter((name) => !name.startsWith(`${STAGE}/`)), [], "every entry needs the prefix");
    assert.deepEqual(names.filter((name) => name.includes("\\")), [], "zip entries must use /");
    assert.deepEqual(
      [...new Set(names.map((name) => name.split("/")[0]))],
      [STAGE],
      "the zip must have exactly one top-level directory",
    );
    assert.ok(names.includes(`${STAGE}/INSTALL.md`), "INSTALL.md belongs in the zip");
    assert.ok(names.includes(`${STAGE}/RELEASE.md`), "RELEASE.md belongs in the zip");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("-5: two builds under one SOURCE_DATE_EPOCH are byte-identical", () => {
  const work = mkdtempSync(join(tmpdir(), "myflow-release-repro-"));
  try {
    // 1700000000 = 2023-11-14T22:13:20Z; the zip must carry exactly that.
    const env = { SOURCE_DATE_EPOCH: "1700000000" };
    const digests: string[] = [];
    for (const name of ["first", "second"]) {
      const outdir = join(work, name);
      const result = release(["--out", outdir], { env });
      assert.equal(result.status, 0, `--out (${name}) failed:\n${result.stderr}`);
      const archive = join(outdir, `${STAGE}.zip`);
      digests.push(createHash("sha256").update(readFileSync(archive)).digest("hex"));
      if (name === "first") {
        // Revert point: taking the entry timestamp from the wall clock (or from
        // the local zone) changes this tuple, whatever the build date is.
        const stamps = python(
          [
            "import json, sys, zipfile",
            "with zipfile.ZipFile(sys.argv[1]) as bundle:",
            "    print(json.dumps(sorted({info.date_time for info in bundle.infolist()})))",
          ].join("\n"),
          [archive],
        );
        assert.equal(stamps.status, 0, `reading zip timestamps failed:\n${stamps.stderr}`);
        assert.deepEqual(JSON.parse(stamps.stdout), [[2023, 11, 14, 22, 13, 20]], "every entry must carry SOURCE_DATE_EPOCH");
        const releaseDoc = readFileSync(join(outdir, STAGE, "RELEASE.md"), "utf-8");
        assert.match(releaseDoc, /built_at: 2023-11-14T22:13:20Z/, "built_at must follow SOURCE_DATE_EPOCH");
      }
    }
    // Revert point: using the wall clock for the zip entries (or letting
    // `built_at` leak it) makes the two digests differ.
    assert.equal(digests[0], digests[1], "the same SOURCE_DATE_EPOCH must reproduce the same bytes");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("-6: --verify smoke-tests the release in a throwaway project", () => {
  const work = mkdtempSync(join(tmpdir(), "myflow-release-verify-"));
  try {
    const outdir = join(work, "dist");
    const result = release(["--out", outdir, "--verify"]);
    assert.equal(result.status, 0, `--verify failed:\n${result.stderr}`);
    // The three smoke steps must actually have run, not been skipped.
    for (const step of [/extension imports/, /task\.py current reports no active task/, /get_context\.py emits/]) {
      assert.match(result.stdout, step, `--verify skipped a step (${step}):\n${result.stdout}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// `--release` is the one command from a clean tree to a tagged commit. It is
// deliberately not tested against this repository: it writes `package.json` and
// `CHANGELOG.md`, commits and tags. A temp git fixture stands in for it.

const GIT_ENV = {
  GIT_AUTHOR_NAME: "myflow test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "myflow test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** The fixture's changelog: one release's worth of Unreleased followed by a release. */
const CHANGELOG_FIXTURE = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "### Added",
  "",
  "- A fixture release.",
  "",
  "## 0.2.0 - 2026-10-21",
  "",
  "### Added",
  "",
  "- The previous release.",
  "",
].join("\n");

/** Run one git command in `root`, with an identity the fixture does not have. */
function git(root: string, args: string[]): Run {
  const result = spawnSync("git", ["-C", root, ...args], {
    env: { ...process.env, ...GIT_ENV },
    encoding: "utf-8",
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The version `current` bumped at `level` — the same arithmetic the script uses. */
function nextVersion(current: string, level: "patch" | "minor" | "major"): string {
  const [major, minor, patch] = current.split(".").map(Number);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** A payload root that is also a git checkout with one commit, ready to release. */
function makeGitRoot(): string {
  const root = makePayloadRoot();
  writeFileSync(join(root, "CHANGELOG.md"), CHANGELOG_FIXTURE);
  // The real file is indented one field per line; the release must replace only
  // the version value, so the fixture looks like it.
  writeFileSync(join(root, "package.json"), `{\n  "name": "fixture",\n  "version": "${VERSION}"\n}\n`);
  // The release builds into `dist/`; the fixture ignores it so a finished
  // release can be proved to leave a clean tree.
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  assert.equal(git(root, ["init", "--quiet"]).status, 0, "git init must succeed in the fixture");
  assert.equal(git(root, ["add", "-A"]).status, 0, "the fixture must stage");
  const commit = git(root, ["commit", "--quiet", "-m", "fixture"]);
  assert.equal(commit.status, 0, `the fixture must commit:\n${commit.stderr}`);
  return root;
}

test("-7: --release patch --dry-run prints the next version and heading, and writes nothing", () => {
  const root = makeGitRoot();
  try {
    const next = nextVersion(VERSION, "patch");
    const dotted = next.replace(/\./g, "\\.");
    const pkgBefore = readFileSync(join(root, "package.json"));
    const changelogBefore = readFileSync(join(root, "CHANGELOG.md"));

    const result = release(["--release", "patch", "--dry-run", "--root", root], { env: GIT_ENV });
    assert.equal(result.status, 0, `--dry-run failed:\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`next version ${dotted}`), "--dry-run must print the next version");
    // The heading is `<version> — <date>`: the em dash and the date both matter.
    assert.match(
      result.stdout,
      new RegExp(`## ${dotted} — \\d{4}-\\d{2}-\\d{2}`),
      "--dry-run must print the CHANGELOG heading",
    );
    assert.match(result.stdout, new RegExp(`tag v${dotted}`), "--dry-run must print the tag name");

    // Revert point: writing the bump before returning from the dry run makes
    // both byte comparisons below fail.
    assert.deepEqual(readFileSync(join(root, "package.json")), pkgBefore, "package.json must be untouched");
    assert.deepEqual(readFileSync(join(root, "CHANGELOG.md")), changelogBefore, "CHANGELOG.md must be untouched");
    assert.ok(!existsSync(join(root, "dist")), "a dry run must not build");
    assert.equal(git(root, ["status", "--porcelain"]).stdout.trim(), "", "a dry run must leave the tree clean");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("-8: --release patch bumps, commits and tags, and stops before the push", () => {
  const root = makeGitRoot();
  try {
    const next = nextVersion(VERSION, "patch");

    const result = release(["--release", "patch", "--root", root], { env: GIT_ENV });
    assert.equal(result.status, 0, `--release failed:\n${result.stderr}`);

    assert.equal(
      readFileSync(join(root, "package.json"), "utf-8"),
      `{\n  "name": "fixture",\n  "version": "${next}"\n}\n`,
      "package.json must carry the bumped version and its original formatting",
    );
    const sections = readFileSync(join(root, "CHANGELOG.md"), "utf-8").split(/^## /m);
    assert.equal(sections[1]?.trim(), "Unreleased", "a fresh empty Unreleased must sit above the release");
    assert.ok(sections[2]?.startsWith(`${next} — `), `the released section must be dated: ${sections[2]}`);
    assert.ok(
      readFileSync(join(root, "CHANGELOG.md"), "utf-8").endsWith("\n"),
      "the release must not strip the changelog's final newline",
    );

    assert.equal(git(root, ["log", "-1", "--format=%s"]).stdout.trim(), `Release ${next}`, "one release commit");
    const tags = git(root, ["tag", "--list"]).stdout.split("\n").map((tag) => tag.trim());
    assert.ok(tags.includes(`v${next}`), `the release must be tagged; got ${JSON.stringify(tags)}`);
    // Without --yes the push is printed, never run: the fixture has no remote,
    // so an attempted push would have failed the command.
    assert.match(result.stdout, /git push --follow-tags/, "the exact push command must be printed");
    // Apart from the commit and the tag, the release leaves the tree clean.
    assert.equal(git(root, ["status", "--porcelain"]).stdout.trim(), "", "a release must leave a clean tree");

    // Revert point: doing any of the writes before the dirty-tree check makes
    // this run succeed instead of refusing.
    writeFileSync(join(root, "stray.txt"), "x\n");
    const dirty = release(["--release", "patch", "--root", root], { env: GIT_ENV });
    assert.notEqual(dirty.status, 0, "a dirty tree must be refused");
    assert.match(dirty.stderr, /dirty/, "the refusal must say the tree is dirty");
    assert.equal(
      readFileSync(join(root, "package.json"), "utf-8"),
      `{\n  "name": "fixture",\n  "version": "${next}"\n}\n`,
      "a refused release must not have bumped anything",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
