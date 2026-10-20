import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BACKGROUND_DIR,
  backgroundDir,
  cursorPath,
  entryPath,
  exitPath,
  isAlive,
  listEntries,
  logPath,
  newTaskId,
  prune,
  readCursor,
  readEntry,
  resolveStatus,
  writeCursor,
  writeEntry,
  writeFileAtomic,
  type BackgroundEntry,
} from "../.pi/extensions/myflow/background.ts";

// F2 — the background-task registry (`.pi/extensions/myflow/background.ts`).
//
// These tests exercise only the pure on-disk layer: id minting, entry
// read/write, the fixed status precedence, bad-file tolerance, 24h pruning and
// per-session cursors. No tool is registered here (that is F3–F6). Every case
// runs in its own temp project directory and removes it afterwards, so nothing
// is written under the repository's real `.myflow/.runtime/`.

/** A throwaway project root. The registry directory is derived from it. */
function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "myflow-bg-registry-"));
}

/**
 * Build a registry entry that matches `design.md` §3.1. `exit_file` and `log`
 * are stored relative to the project root, exactly as the tools will record
 * them, so `exitPathFor`'s relative branch is exercised rather than bypassed.
 */
function makeEntry(dir: string, id: string, overrides: Partial<BackgroundEntry> = {}): BackgroundEntry {
  return {
    id,
    command: "echo hi",
    cwd: dir,
    pid: process.pid,
    log: join(BACKGROUND_DIR, `${id}.log`),
    exit_file: join(BACKGROUND_DIR, `${id}.exit`),
    status: "running",
    exit_code: null,
    started_at: new Date().toISOString(),
    ended_at: null,
    started_by_context_key: "pi_test",
    confirmed_by: "ui-confirm",
    ...overrides,
  };
}

/** Persist an entry plus the side files a real run would leave behind. */
function seed(
  dir: string,
  root: string,
  entry: BackgroundEntry,
  options: { exit?: Record<string, unknown>; contextKeys?: string[] } = {},
): void {
  writeEntry(dir, entry);
  writeFileSync(logPath(dir, entry.id), `log for ${entry.id}\n`);
  if (options.exit) {
    writeFileSync(exitPath(dir, entry.id), JSON.stringify(options.exit));
  }
  for (const key of options.contextKeys ?? []) {
    writeCursor(cursorPath(root, key, entry.id), 16);
  }
}

test("bg registry -1: task ids have the documented shape and never repeat", () => {
  // The shape is a contract (§3): `bg-<base36 ms>-<4 hex>`. It must not depend
  // on a pid, because the OS reuses pids.
  const shape = /^bg-[0-9a-z]+-[0-9a-f]{4}$/;
  const now = Date.now();
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i += 1) {
    const id = newTaskId(now);
    assert.match(id, shape, `id ${id} must match ${shape}`);
    assert.ok(!seen.has(id), `id ${id} was generated twice`);
    seen.add(id);
  }
  assert.equal(seen.size, 2000);
  // Pinning the clock still yields the same-shaped, still-unique ids: the
  // uniqueness lives in the suffix, not in the timestamp.
  assert.notEqual(newTaskId(now), newTaskId(now));
});

test("bg registry -2: resolveStatus covers exit, stopped, running, and self-heals a dead pid", () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    mkdirSync(dir, { recursive: true });

    // Liveness primitives this test relies on.
    assert.equal(isAlive(process.pid), true, "the test's own pid must read as alive");
    assert.equal(isAlive(0), false, "pid 0 targets the process group, never a task");
    assert.equal(isAlive(-1), false);
    assert.equal(isAlive("123"), false, "a non-number pid is not alive");

    // (a) `.exit` present -> exited, with the recorded code.
    const withExit = makeEntry(dir, newTaskId(1));
    writeFileSync(
      exitPath(dir, withExit.id),
      JSON.stringify({ exit_code: 5, signal: null, at: new Date().toISOString() }),
    );
    assert.deepEqual(resolveStatus(dir, withExit), { status: "exited", exit_code: 5 });

    // (b) explicitly stopped -> stopped.
    const stopped = makeEntry(dir, newTaskId(2), { status: "stopped", pid: 999_999_999 });
    assert.deepEqual(resolveStatus(dir, stopped), { status: "stopped", exit_code: null });

    // (c) no record, live pid -> running.
    const running = makeEntry(dir, newTaskId(3), { pid: process.pid });
    assert.deepEqual(resolveStatus(dir, running), { status: "running", exit_code: null });

    // (d) no record, dead pid -> self-healed exited with a null code.
    const dead = makeEntry(dir, newTaskId(4), { status: "running", pid: 999_999_999 });
    assert.deepEqual(resolveStatus(dir, dead), { status: "exited", exit_code: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bg registry -3: an .exit record outranks a still-live pid", () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    mkdirSync(dir, { recursive: true });

    // The pid is deliberately alive: this models the OS having reused a pid
    // after the task really exited. The `.exit` record must win, or a
    // long-dead task would report as running forever.
    const entry = makeEntry(dir, newTaskId(10), { pid: process.pid });
    assert.equal(isAlive(entry.pid), true, "precondition: the pid is alive");
    writeFileSync(
      exitPath(dir, entry.id),
      JSON.stringify({ exit_code: 0, signal: null, at: new Date().toISOString() }),
    );

    const resolved = resolveStatus(dir, entry);
    assert.equal(resolved.status, "exited");
    assert.equal(resolved.exit_code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bg registry -4: listEntries tolerates a truncated entry and still lists the rest", () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    mkdirSync(dir, { recursive: true });

    const good = makeEntry(dir, newTaskId(20), { command: "npm run dev" });
    writeEntry(dir, good);

    // A half-written file: invalid JSON.
    writeFileSync(entryPath(dir, newTaskId(21)), '{"id":"bg-x-0000","command":');
    // Valid JSON, but not a registry entry.
    writeFileSync(entryPath(dir, newTaskId(22)), "[]");
    // Valid JSON object, no id.
    writeFileSync(entryPath(dir, newTaskId(23)), JSON.stringify({ command: "no id here" }));

    const { entries, warnings } = listEntries(dir);

    assert.equal(entries.length, 1, "only the usable entry is returned");
    assert.equal(entries[0].id, good.id);
    assert.deepEqual(readEntry(dir, good.id), good, "writeEntry/readEntry round-trip");
    assert.equal(warnings.length, 3, "each bad file is reported once");
    for (const warning of warnings) {
      assert.equal(typeof warning.file, "string");
      assert.ok(warning.reason.length > 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bg registry -5: prune deletes only finished tasks older than 24h, with their files and cursors", () => {
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const hour = 60 * 60 * 1000;

    // 1. Still running: never pruned.
    const running = makeEntry(dir, newTaskId(100), { status: "running", pid: process.pid });
    // 2. Finished one hour ago: too recent.
    const fresh = makeEntry(dir, newTaskId(101), {
      status: "exited",
      pid: 999_999_999,
      ended_at: iso(now - hour),
    });
    // 3. Finished 25 hours ago via an exit record.
    const oldExit = makeEntry(dir, newTaskId(102), {
      status: "exited",
      pid: 999_999_999,
      ended_at: iso(now - 25 * hour),
    });
    // 4. Stopped 25 hours ago with no exit record: the status alone dates it.
    const oldStopped = makeEntry(dir, newTaskId(103), {
      status: "stopped",
      pid: 999_999_999,
      ended_at: iso(now - 25 * hour),
    });

    seed(dir, root, running, { contextKeys: ["pi_a", "pi_b"] });
    seed(dir, root, fresh, { exit: { exit_code: 0, signal: null, at: iso(now - hour) }, contextKeys: ["pi_a"] });
    seed(dir, root, oldExit, { exit: { exit_code: 1, signal: null, at: iso(now - 25 * hour) }, contextKeys: ["pi_a"] });
    seed(dir, root, oldStopped, { contextKeys: ["pi_a"] });

    assert.equal(prune(dir, now), 2, "exactly the two old, finished tasks are removed");

    // The running task is untouched in every respect.
    assert.ok(existsSync(entryPath(dir, running.id)));
    assert.ok(existsSync(logPath(dir, running.id)));
    assert.ok(existsSync(cursorPath(root, "pi_a", running.id)));
    assert.ok(existsSync(cursorPath(root, "pi_b", running.id)));

    // The recent finished task is kept.
    assert.ok(existsSync(entryPath(dir, fresh.id)));
    assert.ok(existsSync(exitPath(dir, fresh.id)));
    assert.ok(existsSync(cursorPath(root, "pi_a", fresh.id)));

    // The old finished tasks are gone, together with log, exit and cursors.
    for (const gone of [oldExit, oldStopped]) {
      assert.ok(!existsSync(entryPath(dir, gone.id)), `${gone.id} entry must be deleted`);
      assert.ok(!existsSync(logPath(dir, gone.id)), `${gone.id} log must be deleted`);
      assert.ok(!existsSync(cursorPath(root, "pi_a", gone.id)), `${gone.id} cursor must be deleted`);
    }
    assert.ok(!existsSync(exitPath(dir, oldExit.id)), "the exit record of a pruned task must be deleted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bg registry -6: the per-session cursor round-trips and a missing cursor reads 0", () => {
  const root = makeRoot();
  try {
    const taskId = newTaskId(30);
    const path = cursorPath(root, "pi_ctxA", taskId);

    assert.ok(path.endsWith(`pi_ctxA__${taskId}.json`), "the cursor file is <contextKey>__<taskId>.json");
    assert.equal(readCursor(path), 0, "a cursor that does not exist reads as offset 0");

    writeCursor(path, 4096);
    assert.equal(readCursor(path), 4096);
    writeCursor(path, 8192);
    assert.equal(readCursor(path), 8192);

    // A second session's cursor is independent: reading there does not consume
    // bytes the first session has yet to read (ADR-5).
    const other = cursorPath(root, "pi_ctxB", taskId);
    assert.equal(readCursor(other), 0);

    // A corrupt cursor also degrades to 0 rather than throwing.
    writeFileSync(other, "{not json");
    assert.equal(readCursor(other), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- D1 / D3 (review fixes) -------------------------------------------------

test("bg registry -7: a recorded `exited` stays exited even when its pid reads alive (D1)", () => {
  // 回退点：删掉 `resolveStatus` 里 `entry.status === "exited"` 那一档 →
  // 下面的 pid 活分支把它报回 running，本用例红。
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    mkdirSync(dir, { recursive: true });

    // (a) A verdict already written to disk (a `list` self-heal, or the
    // `spawn_error` listener) must stick. The pid is deliberately alive — that
    // is the OS having reused it, and it is what used to resurrect the entry.
    const sticky = makeEntry(dir, newTaskId(40), { status: "exited", pid: process.pid });
    assert.equal(isAlive(sticky.pid), true, "precondition: the reused pid is alive");
    assert.deepEqual(resolveStatus(dir, sticky), { status: "exited", exit_code: null });

    // The recorded exit code survives the sticky branch instead of being lost.
    const coded = makeEntry(dir, newTaskId(41), {
      status: "exited",
      exit_code: 3,
      pid: process.pid,
    });
    assert.deepEqual(resolveStatus(dir, coded), { status: "exited", exit_code: 3 });

    // (b) The sticky branch must not outrank a real `.exit` record: even with
    // `status: "exited"` on disk, the record's code and reasons are the truth.
    const withExit = makeEntry(dir, newTaskId(42), {
      status: "exited",
      exit_code: 3,
      pid: process.pid,
    });
    writeFileSync(
      exitPath(dir, withExit.id),
      JSON.stringify({ exit_code: 7, signal: "SIGTERM", at: new Date().toISOString() }),
    );
    assert.deepEqual(resolveStatus(dir, withExit), {
      status: "exited",
      exit_code: 7,
      signal: "SIGTERM",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bg registry -8: an atomic write retries a transient rename failure and never leaves a .tmp (D3)", () => {
  // 回退点：删掉 `writeFileAtomic` 的 rename 重试循环 → attempts 停在 1 且抛错，红；
  // 删掉 catch 里的 `rmSync(tempPath)` → `.tmp` 残留断言红。
  const root = makeRoot();
  try {
    const dir = backgroundDir(root);
    const target = entryPath(dir, "bg-atomic-0000");

    // Two transient (Windows sharing) failures, then success. The sleep is
    // injected so the retry schedule is asserted without waiting ~1s.
    let attempts = 0;
    const sleeps: number[] = [];
    writeFileAtomic(target, '{"id":"bg-atomic-0000"}', {
      rename: (from, to) => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error("resource busy or locked") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
        renameSync(from, to);
      },
      sleep: (ms) => sleeps.push(ms),
    });
    assert.equal(attempts, 3, "a transient failure must be retried, not thrown");
    assert.deepEqual(sleeps, [20, 20], "each retry waits the documented 20ms");
    assert.equal(readFileSync(target, "utf-8"), '{"id":"bg-atomic-0000"}');
    assert.ok(!existsSync(`${target}.tmp`), "a successful write leaves no .tmp behind");

    // A permanent error is not retried and still cleans the temp file up.
    let permanentAttempts = 0;
    assert.throws(
      () =>
        writeFileAtomic(target, "payload", {
          rename: () => {
            permanentAttempts += 1;
            const error = new Error("not a transient code") as NodeJS.ErrnoException;
            error.code = "EISDIR";
            throw error;
          },
          sleep: () => {
            throw new Error("a permanent error must not be retried");
          },
        }),
      /not a transient code/,
    );
    assert.equal(permanentAttempts, 1, "a non-transient code is attempted exactly once");
    assert.ok(!existsSync(`${target}.tmp`), "a failed write still removes its .tmp");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
