import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendControl,
  clearControls,
  ctlPath,
  readNewControls,
} from "../.pi/extensions/myflow/ctl.ts";

// S2 — the control file (`.pi/extensions/myflow/ctl.ts`).
//
// What matters here is the *incremental* read: a dispatcher polls every second,
// so the offset must never consume a half-written line and a bad line must be
// skipped instead of ending the poll loop. Each case gets its own throwaway
// directory and removes it afterwards.

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "myflow-ctl-"));
}

function withDir(body: (dir: string) => void): void {
  const dir = makeDir();
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("ctl: ctlPath sits next to the run entry", () => {
  assert.equal(ctlPath(join("a", "subagents"), "r-1"), join("a", "subagents", "r-1.ctl.jsonl"));
});

test("ctl: appendControl writes one JSON line per command with an id and a timestamp", () => {
  withDir((dir) => {
    const path = ctlPath(dir, "r-1");
    const first = appendControl(path, { type: "steer", message: "focus on tests", by: "pi_abc" }, 1_000);
    assert.match(first.id, /^c-1000-[0-9a-f]{6}$/);
    assert.equal(first.at, new Date(1_000).toISOString());
    appendControl(path, { type: "abort" }, 2_000);

    const lines = readFileSync(path, "utf-8").trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).type, "steer");
    assert.equal(JSON.parse(lines[0]).message, "focus on tests");
    assert.equal(JSON.parse(lines[1]).type, "abort");
    assert.equal(JSON.parse(lines[1]).message, "");
  });
});

test("ctl: readNewControls returns everything once, then only the increment", () => {
  withDir((dir) => {
    const path = ctlPath(dir, "r-1");
    appendControl(path, { type: "steer", message: "one" }, 1_000);
    appendControl(path, { type: "steer", message: "two" }, 2_000);

    const first = readNewControls(path);
    assert.deepEqual(first.commands.map((command) => command.message), ["one", "two"]);
    assert.equal(first.skipped, 0);
    assert.equal(first.offset, readFileSync(path).length);

    const idle = readNewControls(path, first.offset);
    assert.deepEqual(idle.commands, []);
    assert.equal(idle.offset, first.offset);

    appendControl(path, { type: "abort" }, 3_000);
    const second = readNewControls(path, first.offset);
    assert.deepEqual(second.commands.map((command) => command.type), ["abort"]);
    assert.ok(second.offset > first.offset);
    assert.deepEqual(readNewControls(path, second.offset).commands, []);
  });
});

test("ctl: a half-written line is not consumed", () => {
  withDir((dir) => {
    const path = ctlPath(dir, "r-1");
    appendControl(path, { type: "steer", message: "complete" }, 1_000);
    const completeLength = readFileSync(path).length;

    // Simulate an interrupted append: JSON with no trailing newline.
    const partial = JSON.stringify({ id: "c-partial", type: "steer", message: "half", at: "" });
    appendFileSync(path, partial.slice(0, 20));

    const read = readNewControls(path);
    assert.deepEqual(read.commands.map((command) => command.message), ["complete"]);
    assert.equal(read.offset, completeLength);

    // Once the writer finishes the line, the next read picks it up whole.
    appendFileSync(path, `${partial.slice(20)}\n`);
    const next = readNewControls(path, read.offset);
    assert.deepEqual(next.commands.map((command) => command.message), ["half"]);
    assert.equal(next.offset, readFileSync(path).length);
  });
});

test("ctl: bad lines are skipped and counted, not thrown", () => {
  withDir((dir) => {
    const path = ctlPath(dir, "r-1");
    appendFileSync(
      path,
      [
        "{not json",
        JSON.stringify({ id: "c-1", type: "steer", message: "good", at: "" }),
        JSON.stringify({ id: "c-2", type: "nope", message: "", at: "" }),
        JSON.stringify([1, 2]),
        "",
        JSON.stringify({ id: "c-3", type: "abort", at: "" }),
      ].join("\n") + "\n",
    );

    const read = readNewControls(path);
    assert.deepEqual(read.commands.map((command) => command.type), ["steer", "abort"]);
    assert.equal(read.skipped, 3);
    assert.equal(read.offset, readFileSync(path).length);
  });
});

test("ctl: a missing file is empty and leaves the offset alone", () => {
  withDir((dir) => {
    const path = ctlPath(dir, "r-none");
    const read = readNewControls(path, 0);
    assert.deepEqual(read, { commands: [], offset: 0, skipped: 0 });
    assert.deepEqual(readNewControls(path, 42), { commands: [], offset: 42, skipped: 0 });
  });
});

test("ctl: an offset past the end of the file reports no commands", () => {
  withDir((dir) => {
    const path = ctlPath(dir, "r-1");
    appendControl(path, { type: "steer", message: "one" }, 1_000);
    const read = readNewControls(path, 10_000);
    assert.deepEqual(read.commands, []);
    assert.equal(read.offset, readFileSync(path).length);
  });
});

test("ctl: multi-byte messages survive an incremental read", () => {
  withDir((dir) => {
    const path = ctlPath(dir, "r-1");
    appendControl(path, { type: "steer", message: "先看测试 👀" }, 1_000);
    const first = readNewControls(path);
    assert.deepEqual(first.commands.map((command) => command.message), ["先看测试 👀"]);
    appendControl(path, { type: "steer", message: "然后提交" }, 2_000);
    const second = readNewControls(path, first.offset);
    assert.deepEqual(second.commands.map((command) => command.message), ["然后提交"]);
  });
});

test("ctl: clearControls removes the file so a fresh run starts clean", () => {
  withDir((dir) => {
    const path = ctlPath(dir, "r-1");
    appendControl(path, { type: "steer", message: "stale" }, 1_000);
    clearControls(path);
    assert.equal(existsSync(path), false);
    assert.deepEqual(readNewControls(path).commands, []);

    // Appending again after deletion must be readable from offset 0.
    appendControl(path, { type: "abort" }, 2_000);
    assert.deepEqual(readNewControls(path).commands.map((command) => command.type), ["abort"]);
  });
});

test("ctl: a writer that created the directory first is not an error", () => {
  withDir((dir) => {
    const path = join(dir, "nested", "deeper", "r-1.ctl.jsonl");
    appendControl(path, { type: "steer", message: "nested" }, 1_000);
    assert.deepEqual(readNewControls(path).commands.map((command) => command.message), ["nested"]);
  });
});

test("ctl: a file with no newline at all yields nothing and no offset advance", () => {
  withDir((dir) => {
    const path = ctlPath(dir, "r-1");
    writeFileSync(path, '{"id":"c-1","type":"steer","message":"x","at":""}');
    const read = readNewControls(path, 0);
    assert.deepEqual(read.commands, []);
    assert.equal(read.offset, 0);
  });
});
