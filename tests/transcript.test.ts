import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RESULT_CLIP,
  lastLine,
  parseTranscript,
  readTail,
  readTranscript,
} from "../.pi/extensions/myflow/board/transcript.ts";

// S4 — the log → readable lines conversion behind the viewer.

/** A `message_end` record, the only record the transcript reads. */
function messageEnd(message: Record<string, unknown>): string {
  return JSON.stringify({ type: "message_end", message });
}

const HEADER = "# myflow-implement @ 2026-01-01T00:00:00.000Z\n# prompt: do it\n";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "myflow-transcript-"));
}

test("parseTranscript: assistant text, folded thinking, one-line tool call, clipped result", () => {
  const log = [
    HEADER.trimEnd(),
    messageEnd({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "first line\nsecond   line\n\nthird" },
        { type: "text", text: "here is the answer" },
        { type: "toolCall", name: "bash", arguments: { command: "ls -la" } },
      ],
      stopReason: "end",
    }),
    messageEnd({
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "a\n" + "b".repeat(400) }],
    }),
    messageEnd({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" }),
  ].join("\n");

  const lines = parseTranscript(log);
  assert.deepEqual(
    lines.map((line) => line.kind),
    ["thinking", "text", "tool", "result", "text"],
  );
  assert.equal(lines[0].text, "first line second line third");
  assert.equal(lines[1].text, "here is the answer");
  assert.equal(lines[2].text, 'bash {"command":"ls -la"}');
  assert.ok(lines[3].text.startsWith("a b"));
  assert.equal(lines[3].text.length, RESULT_CLIP + 1); // clipped + the ellipsis
  assert.equal(lines[4].text, "done");
});

test("parseTranscript: an errored assistant message yields an error line", () => {
  const log = messageEnd({
    role: "assistant",
    content: [{ type: "text", text: "partial" }],
    stopReason: "error",
    errorMessage: "provider refused\nthe call",
  });
  assert.deepEqual(parseTranscript(log), [
    { kind: "text", text: "partial" },
    { kind: "error", text: "provider refused the call" },
  ]);
});

test("parseTranscript: unknown records, bad lines and stderr are skipped", () => {
  const log = [
    HEADER.trimEnd(),
    "not json at all",
    '{"type":"agent_settled","aborted":false}',
    '{"type":"tool_execution_start","toolName":"bash"}',
    '{"broken":',
    '{"type":"message_end"}', // no message: nothing to show
    messageEnd({ role: "user", content: [{ type: "text", text: "the prompt echo" }] }),
    messageEnd({ role: "assistant", content: [{ type: "image", data: "…" }] }),
  ].join("\n");
  assert.deepEqual(parseTranscript(log), []);
});

test("parseTranscript: empty input is empty output", () => {
  assert.deepEqual(parseTranscript(""), []);
});

test("readTail: missing file reads as empty", () => {
  assert.equal(readTail(join(makeProject(), "nope.log"), 1024), "");
});

test("readTail: keeps the tail and drops the fragment the cut landed inside", () => {
  const dir = makeProject();
  try {
    const path = join(dir, "run.log");
    const first = "x".repeat(50);
    writeFileSync(path, `${first}\nsecond line\nthird line\n`, "utf-8");
    const window = 20; // cuts inside "third line"
    const tail = readTail(path, window);
    assert.ok(!tail.includes(first));
    assert.ok(!tail.startsWith("d line"));
    assert.equal(tail, "third line\n");

    // A window larger than the file returns everything (no fragment to drop).
    assert.equal(readTail(path, 4096), `${first}\nsecond line\nthird line\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTail: a window inside one line yields no partial line", () => {
  const dir = makeProject();
  try {
    const path = join(dir, "run.log");
    writeFileSync(path, "one very long line without a break\n", "utf-8");
    assert.equal(readTail(path, 10), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lastLine: the final readable line, clipped, or null when there is none", () => {
  const dir = makeProject();
  try {
    const path = join(dir, "run.log");
    assert.equal(lastLine(path), null);

    writeFileSync(
      path,
      [
        HEADER.trimEnd(),
        messageEnd({ role: "assistant", content: [{ type: "text", text: "early" }] }),
        messageEnd({ role: "assistant", content: [{ type: "text", text: "y".repeat(300) }] }),
      ].join("\n"),
      "utf-8",
    );
    const preview = lastLine(path);
    assert.ok(preview);
    assert.ok(preview.startsWith("yyyy"));
    assert.equal(preview.length, 101); // clipped to 100 + ellipsis

    // Only protocol records: no preview rather than an empty string.
    writeFileSync(path, '{"type":"agent_settled","aborted":false}\n', "utf-8");
    assert.equal(lastLine(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTranscript: whole file, and an empty list for a missing one", () => {
  const dir = makeProject();
  try {
    const path = join(dir, "run.log");
    assert.deepEqual(readTranscript(path), []);
    writeFileSync(
      path,
      messageEnd({ role: "assistant", content: [{ type: "text", text: "hello" }] }),
      "utf-8",
    );
    assert.deepEqual(readTranscript(path), [{ kind: "text", text: "hello" }]);
    assert.ok(statSync(path).size > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
