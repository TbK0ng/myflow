import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_FINISHED_RUNS,
  STALE_AFTER_MS,
  SUBAGENTS_DIR,
  addSteer,
  deleteFinishedRuns,
  deleteRun,
  displayStatus,
  finish,
  groupRuns,
  heartbeat,
  isTerminal,
  listRuns,
  markRunning,
  newGroupId,
  newRunId,
  pruneRuns,
  queueGroup,
  readRun,
  runPath,
  runsDir,
  writeRun,
  type RunEntry,
} from "../.pi/extensions/myflow/runs.ts";
import { PRUNE_AFTER_MS } from "../.pi/extensions/myflow/background/registry.ts";

// S1 — the front-run registry (`.pi/extensions/myflow/runs.ts`).
//
// Only the on-disk layer is exercised here: id minting, the queued -> running ->
// terminal transition, grouping, bad-file tolerance, the stale heartbeat rule and
// both prune conditions. Each case gets its own throwaway project root and
// removes it afterwards, so nothing lands under the repository's real
// `.myflow/.runtime/`.

/** A throwaway project root; the registry directory is derived from it. */
function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "myflow-runs-"));
}

function withRoot(body: (root: string) => void): void {
  const root = makeRoot();
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function member(agent: string, prompt: string): { agent: string; mode: "single"; prompt: string } {
  return { agent, mode: "single", prompt };
}

test("runs: ids are prefixed and unique within one millisecond", () => {
  const now = 1_700_000_000_000;
  const ids = new Set([newRunId(now), newRunId(now), newRunId(now)]);
  assert.equal(ids.size, 3);
  assert.match(newRunId(now), /^r-1700000000000-[0-9a-f]{4}$/);
  assert.match(newGroupId(now), /^g-1700000000000-[0-9a-f]{4}$/);
});

test("runs: runsDir is the documented location under the project root", () => {
  assert.equal(runsDir(join("C:", "proj")), join("C:", "proj", SUBAGENTS_DIR));
});

test("runs: queueGroup writes every member as queued in one group", () => {
  withRoot((root) => {
    const dir = runsDir(root);
    const entries = queueGroup(dir, [member("myflow-implement", "one"), member("myflow-implement", "two")], {
      group: "g-fixed",
      contextKey: "pi_abc",
      pid: 4242,
      now: Date.parse("2024-05-01T00:00:00.000Z"),
    });

    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((entry) => entry.index),
      [1, 2],
    );
    assert.deepEqual(
      entries.map((entry) => entry.total),
      [2, 2],
    );
    assert.ok(entries.every((entry) => entry.group === "g-fixed"));
    assert.ok(entries.every((entry) => entry.status === "queued"));
    assert.ok(entries.every((entry) => entry.owner.contextKey === "pi_abc" && entry.owner.pid === 4242));
    assert.ok(entries.every((entry) => entry.startedAt === "2024-05-01T00:00:00.000Z"));

    // Round trip: what was written is what is read back.
    const read = readRun(dir, entries[1].runId);
    assert.deepEqual(read, entries[1]);

    const listed = listRuns(dir);
    assert.deepEqual(listed.warnings, []);
    assert.deepEqual(
      listed.runs.map((entry) => entry.runId),
      entries.map((entry) => entry.runId),
    );
  });
});

test("runs: listRuns orders newest group first and keeps index order inside it", () => {
  withRoot((root) => {
    const dir = runsDir(root);
    const second = queueGroup(dir, [member("a", "y"), member("a", "z")], { group: "g-2", now: 2000 });
    const first = queueGroup(dir, [member("b", "x")], { group: "g-1", now: 1000 });

    const listed = listRuns(dir);
    // Display order: the group created last comes first, so the panel opens on
    // the newest work. Inside a group the chain order (index) still wins.
    assert.deepEqual(
      listed.runs.map((entry) => `${entry.group}:${entry.index}`),
      ["g-2:1", "g-2:2", "g-1:1"],
    );

    const groups = groupRuns(listed.runs);
    assert.deepEqual(
      groups.map((group) => [group.group, group.agent, group.runs.map((run) => run.runId)]),
      [
        ["g-2", "a", [second[0].runId, second[1].runId]],
        ["g-1", "b", [first[0].runId]],
      ],
    );
  });
});

test("runs: listRuns skips unusable files and reports them", () => {
  withRoot((root) => {
    const dir = runsDir(root);
    queueGroup(dir, [member("a", "good")], { group: "g-1", now: 1000 });
    writeFileSync(join(dir, "broken.json"), '{"runId": ');
    writeFileSync(join(dir, "no-id.json"), JSON.stringify({ status: "running" }));
    writeFileSync(join(dir, "array.json"), "[]");

    const listed = listRuns(dir);
    assert.equal(listed.runs.length, 1);
    assert.equal(listed.warnings.length, 3);
    assert.equal(readRun(dir, "missing"), null);
    assert.equal(readRun(dir, "broken"), null);
  });
});

test("runs: an entry without steers still reads as an entry", () => {
  withRoot((root) => {
    const dir = runsDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "r-hand.json"), JSON.stringify({ runId: "r-hand", status: "running", group: "g" }));
    const entry = readRun(dir, "r-hand");
    assert.deepEqual(entry?.steers, []);
  });
});

test("runs: markRunning flips to running and resets startedAt to the real start", () => {
  withRoot((root) => {
    const dir = runsDir(root);
    const [queued] = queueGroup(dir, [member("a", "p")], { group: "g-1", now: 1_000 });

    const running = markRunning(dir, queued.runId, { pid: 777, logPath: ".myflow/logs/a.log" }, 5_000);
    assert.equal(running?.status, "running");
    assert.equal(running?.pid, 777);
    assert.equal(running?.logPath, ".myflow/logs/a.log");
    assert.equal(running?.startedAt, new Date(5_000).toISOString());
    assert.equal(running?.heartbeatAt, new Date(5_000).toISOString());

    // A queued chain member that waits must not report wait time as run time.
    assert.deepEqual(markRunning(dir, "r-missing", {}, 6_000), null);
  });
});

test("runs: heartbeat moves only heartbeatAt", () => {
  withRoot((root) => {
    const dir = runsDir(root);
    const [queued] = queueGroup(dir, [member("a", "p")], { group: "g-1", now: 1_000 });
    markRunning(dir, queued.runId, { pid: 1 }, 2_000);
    const beaten = heartbeat(dir, queued.runId, 9_000);
    assert.equal(beaten?.heartbeatAt, new Date(9_000).toISOString());
    assert.equal(beaten?.startedAt, new Date(2_000).toISOString());
    assert.equal(beaten?.status, "running");
    assert.equal(heartbeat(dir, "r-missing", 9_000), null);
  });
});

test("runs: addSteer appends and keeps earlier steers", () => {
  withRoot((root) => {
    const dir = runsDir(root);
    const [queued] = queueGroup(dir, [member("a", "p")], { group: "g-1", now: 1_000 });
    addSteer(dir, queued.runId, "first", 2_000);
    const updated = addSteer(dir, queued.runId, "second", 3_000);
    assert.deepEqual(
      updated?.steers.map((steer) => steer.message),
      ["first", "second"],
    );
    assert.equal(updated?.steers[1].at, new Date(3_000).toISOString());
    assert.equal(addSteer(dir, "r-missing", "x", 4_000), null);
  });
});

test("runs: finish records a terminal state and why it ended", () => {
  withRoot((root) => {
    const dir = runsDir(root);
    const [queued] = queueGroup(dir, [member("a", "p")], { group: "g-1", now: 1_000 });
    markRunning(dir, queued.runId, { pid: 1 }, 2_000);
    const done = finish(
      dir,
      queued.runId,
      "failed",
      { exitCode: 1, stopReason: "error", errorMessage: "boom" },
      8_000,
    );
    assert.equal(done?.status, "failed");
    assert.equal(done?.endedAt, new Date(8_000).toISOString());
    assert.equal(done?.exitCode, 1);
    assert.equal(done?.errorMessage, "boom");
    assert.ok(isTerminal(done!.status));
    assert.equal(isTerminal("running"), false);
    assert.equal(finish(dir, "r-missing", "done"), null);
  });
});

test("runs: displayStatus is stale only past the threshold", () => {
  const base: RunEntry = {
    runId: "r-1",
    group: "g-1",
    index: 1,
    total: 1,
    agent: "a",
    mode: "single",
    prompt: "p",
    status: "running",
    startedAt: new Date(0).toISOString(),
    endedAt: null,
    heartbeatAt: new Date(1_000).toISOString(),
    pid: 1,
    owner: { contextKey: null, pid: 1 },
    logPath: null,
    task: null,
    model: null,
    exitCode: null,
    stopReason: null,
    errorMessage: null,
    steers: [],
  };

  assert.equal(displayStatus(base, 1_000 + 29_000), "running");
  assert.equal(displayStatus(base, 1_000 + STALE_AFTER_MS), "running");
  assert.equal(displayStatus(base, 1_000 + 31_000), "stale");

  // A terminal status is reported as recorded, however old the heartbeat is.
  assert.equal(displayStatus({ ...base, status: "done" }, 1_000 + 999_999), "done");
  // An unreadable heartbeat cannot prove the run alive, so it is not "running".
  assert.equal(displayStatus({ ...base, heartbeatAt: "not-a-date" }, 2_000), "stale");
});

test("runs: pruneRuns deletes only old terminal entries", () => {
  withRoot((root) => {
    const dir = runsDir(root);
    const now = 10 * PRUNE_AFTER_MS;
    const [old] = queueGroup(dir, [member("a", "old")], { group: "g-old", now: now });
    const [fresh] = queueGroup(dir, [member("a", "fresh")], { group: "g-fresh", now: now });
    const [live] = queueGroup(dir, [member("a", "live")], { group: "g-live", now: now });
    finish(dir, old.runId, "done", { endedAt: new Date(now - PRUNE_AFTER_MS - 1).toISOString() }, now);
    finish(dir, fresh.runId, "done", { endedAt: new Date(now - 1_000).toISOString() }, now);
    markRunning(dir, live.runId, { pid: 1 }, now);

    assert.equal(pruneRuns(dir, now), 1);
    const left = listRuns(dir).runs.map((entry) => entry.runId).sort();
    assert.deepEqual(left, [fresh.runId, live.runId].sort());
  });
});

test("runs: pruneRuns keeps the newest MAX_FINISHED_RUNS terminal entries", () => {
  withRoot((root) => {
    const dir = runsDir(root);
    const now = 10 * PRUNE_AFTER_MS;
    const runIds: string[] = [];
    for (let i = 0; i < MAX_FINISHED_RUNS + 5; i += 1) {
      const [entry] = queueGroup(dir, [member("a", `p${i}`)], { group: `g-${String(i).padStart(3, "0")}`, now });
      finish(dir, entry.runId, "done", { endedAt: new Date(now - (MAX_FINISHED_RUNS + 5 - i) * 1_000).toISOString() }, now);
      runIds.push(entry.runId);
    }

    assert.equal(pruneRuns(dir, now), 5);
    const left = listRuns(dir).runs.map((entry) => entry.runId);
    assert.equal(left.length, MAX_FINISHED_RUNS);
    // The five oldest (minted first) are the ones that went.
    assert.deepEqual(left, runIds.slice(5));
    assert.equal(readdirSync(dir).filter((name) => name.endsWith(".json")).length, MAX_FINISHED_RUNS);
  });
});

test("runs: pruneRuns leaves an undateable terminal entry alone", () => {
  withRoot((root) => {
    const dir = runsDir(root);
    const now = 10 * PRUNE_AFTER_MS;
    const [queued] = queueGroup(dir, [member("a", "p")], { group: "g-1", now });
    const entry: RunEntry = { ...queued, status: "done", endedAt: null };
    writeRun(dir, entry);

    assert.equal(pruneRuns(dir, now), 0);
    assert.ok(readRun(dir, queued.runId));
    assert.equal(runPath(dir, queued.runId), join(dir, `${queued.runId}.json`));
  });
});

test("runs: listRuns puts live runs first, then the finished tail newest first", () => {
  withRoot((root) => {
    const dir = runsDir(root);
    const old = queueGroup(dir, [member("a", "old")], { now: 1_000 })[0];
    const live = queueGroup(dir, [member("a", "live")], { now: 3_000 })[0];
    const newer = queueGroup(dir, [member("a", "newer")], { now: 2_000 })[0];
    assert.ok(finish(dir, old.runId, "done", {}, 4_000));
    assert.ok(finish(dir, newer.runId, "failed", {}, 5_000));

    // The panel opens on what is still moving; a page of yesterday's failures
    // must never push the live run below the fold.
    assert.deepEqual(
      listRuns(dir).runs.map((entry) => entry.runId),
      [live.runId, newer.runId, old.runId],
    );
    assert.deepEqual(
      groupRuns(listRuns(dir).runs).map((group) => group.group),
      [live.group, newer.group, old.group],
    );
  });
});

test("runs: deleteRun forgets a finished run and refuses a live one", () => {
  withRoot((root) => {
    const dir = runsDir(root);
    const live = queueGroup(dir, [member("a", "live")], { now: 1_000 })[0];
    const done = queueGroup(dir, [member("a", "done")], { now: 2_000 })[0];
    assert.ok(finish(dir, done.runId, "stopped", {}, 3_000));

    assert.match(String(deleteRun(dir, live.runId)), /still queued/);
    assert.ok(readRun(dir, live.runId), "a live entry is not deleted");

    assert.equal(deleteRun(dir, done.runId), null);
    assert.equal(readRun(dir, done.runId), null);
    assert.match(String(deleteRun(dir, done.runId)), /not in the registry/);
  });
});

test("runs: deleteFinishedRuns clears only the finished tail", () => {
  withRoot((root) => {
    const dir = runsDir(root);
    const live = queueGroup(dir, [member("a", "live")], { now: 1_000 })[0];
    const first = queueGroup(dir, [member("a", "one")], { now: 2_000 })[0];
    const second = queueGroup(dir, [member("a", "two")], { now: 3_000 })[0];
    assert.ok(finish(dir, first.runId, "done", {}, 4_000));
    assert.ok(finish(dir, second.runId, "timeout", {}, 5_000));

    assert.equal(deleteFinishedRuns(dir), 2);
    assert.deepEqual(
      listRuns(dir).runs.map((entry) => entry.runId),
      [live.runId],
    );
    assert.equal(deleteFinishedRuns(dir), 0);
  });
});
