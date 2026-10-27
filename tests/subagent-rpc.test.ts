import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finish, listRuns, queueGroup, readRun, runsDir } from "../.pi/extensions/myflow/runs.ts";
import { appendControl, ctlPath } from "../.pi/extensions/myflow/ctl.ts";
import { isFailedResult, killChildTree, startRun } from "../.pi/extensions/myflow/transport.ts";
import { registerMyflowSubagent } from "../.pi/extensions/myflow/subagent.ts";

// S3 — the rpc transport (`.pi/extensions/myflow/transport.ts`).
//
// Every case drives a **fake `pi`**: a Node script that speaks the rpc protocol
// on stdio, injected through `process.argv[1]` (which `getPiInvocation` prefers).
// That keeps the state machine under test while staying hermetic and fast — the
// only real processes involved are the fake child and its tree kill.
//
// Each script appends every stdin record it receives to a receipt file, so a
// test can assert what the transport actually sent (the prompt is first, a
// steer was forwarded, a dialog was cancelled) instead of inferring it.

const ROOT = join(import.meta.dirname, "..");
const LF = String.fromCharCode(10);

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "myflow-subagent-rpc-"));
}

/**
 * Write a fake `pi` script into `root`. `body` is appended after the rpc
 * prelude, which gives it `send(record)` and `read(onRecord)`.
 */
function fakePi(root: string, body: string): string {
  const receipt = join(root, "received.jsonl");
  const source = [
    'const fs = require("fs");',
    `const RECEIPT = ${JSON.stringify(receipt)};`,
    'const send = (record) => process.stdout.write(JSON.stringify(record) + "\\n");',
    "const read = (onRecord) => {",
    '  let buf = "";',
    '  process.stdin.on("data", (chunk) => {',
    "    buf += chunk.toString();",
    "    let at;",
    '    while ((at = buf.indexOf("\\n")) >= 0) {',
    "      const line = buf.slice(0, at);",
    "      buf = buf.slice(at + 1);",
    "      if (!line.trim()) continue;",
    '      fs.appendFileSync(RECEIPT, line + "\\n");',
    "      onRecord(JSON.parse(line));",
    "    }",
    "  });",
    "};",
    // Closing stdin is the documented "you may leave now"; a real pi exits.
    'process.stdin.on("end", () => process.exit(0));',
    body,
  ].join(LF);
  const path = join(root, "fake-pi.js");
  writeFileSync(path, source, "utf-8");
  return path;
}

/** Every stdin record the fake child received, in order. */
function received(root: string): Array<Record<string, any>> {
  const path = join(root, "received.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** Queue one run so `startRun` has a registry entry to update. */
function queueOne(root: string, prompt = "do the thing"): string {
  const [entry] = queueGroup(runsDir(root), [{ agent: "myflow-implement", mode: "single", prompt }]);
  return entry.runId;
}

/** Point `getPiInvocation` at the fake child for the duration of the body. */
async function withFakePi<T>(script: string, body: () => Promise<T>): Promise<T> {
  const argv1 = process.argv[1];
  process.argv[1] = script;
  try {
    return await body();
  } finally {
    process.argv[1] = argv1;
  }
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForProcessGone(pid: number, deadlineMs = 15_000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() - start >= deadlineMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Remove the case's project directory.
 *
 * `settled` resolves before the child is gone, and until it is, the transport's
 * log stream and the child's cwd keep the directory locked on Windows — so one
 * `rmSync` fails with EPERM. Retrying here is what keeps `%TEMP%/myflow-*` clean;
 * `rmSync`'s own `maxRetries` burns its exponential backoff and then gives up,
 * which is how these directories used to leak.
 */
async function cleanup(root: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

test("transport: the prompt is the first stdin record, and agent_settled settles the run", async () => {
  const root = makeProject();
  try {
    const script = fakePi(
      root,
      `
      read((record) => {
        if (record.type !== "prompt") return;
        send({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
        send({ type: "extension_ui_request", id: "ui-dialog", method: "confirm", title: "continue?" });
        send({ type: "extension_ui_request", id: "ui-note", method: "notify", message: "hello" });
        send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], stopReason: "end" } });
        send({ type: "agent_settled", aborted: false });
      });`,
    );
    const runId = queueOne(root);

    const result = await withFakePi(script, () =>
      startRun({
        projectRoot: root,
        runId,
        agentName: "myflow-implement",
        systemPrompt: "You are a test agent.",
        writesUnder: null,
        prompt: "do the thing",
        config: { tools: ["read"] },
        contextKey: null,
        timeoutMs: 20_000,
        timings: { pollMs: 25, promptAcceptMs: 5_000, exitGraceMs: 300, abortGraceMs: 300 },
      }).settled,
    );

    const records = received(root);
    assert.equal(records[0].type, "prompt", "the prompt is the first stdin record");
    assert.equal(records[0].message, "do the thing");

    // A dialog must be answered, a fire-and-forget notification must not be.
    const answers = records.filter((record) => record.type === "extension_ui_response");
    assert.deepEqual(
      answers.map((record) => record.id),
      ["ui-dialog"],
      "only the dialog method is answered",
    );
    assert.equal(answers[0].cancelled, true, "a dispatched run cancels any dialog");

    // The outcome is what the child reported, not its exit code.
    assert.equal(result.stopReason, "end");
    assert.equal(isFailedResult(result), false);
    assert.match(result.logPath ?? "", /subagent-logs/);
    // The log is a stream: its bytes land a tick after the record was parsed.
    await waitFor(() => (readFileSync(result.logPath!, "utf-8").includes("first answer") ? true : undefined));

    const entry = readRun(runsDir(root), runId);
    assert.equal(entry?.status, "done");
    assert.ok(entry?.endedAt, "a settled run records when it ended");
    assert.ok(entry?.logPath, "the entry points the board at the raw log");
    assert.equal(existsSync(ctlPath(runsDir(root), runId)), false, "the control file is dropped on settle");
  } finally {
    await cleanup(root);
  }
});

test("transport: a ctl steer is forwarded to the child and recorded on the run", async () => {
  const root = makeProject();
  try {
    // The child settles only after it has seen a steer, so the poll has to
    // deliver it for the run to finish at all.
    const script = fakePi(
      root,
      `
      read((record) => {
        if (record.type === "prompt") {
          send({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
          send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "thinking" }], stopReason: "end" } });
        } else if (record.type === "steer") {
          send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "steered: " + record.message }], stopReason: "end" } });
          send({ type: "agent_settled", aborted: false });
        }
      });`,
    );
    const runId = queueOne(root);
    const dir = runsDir(root);

    const result = await withFakePi(script, async () => {
      const started = startRun({
        projectRoot: root,
        runId,
        agentName: "myflow-implement",
        systemPrompt: "",
        writesUnder: null,
        prompt: "do the thing",
        config: {},
        contextKey: "pi_test",
        timeoutMs: 20_000,
        timings: { pollMs: 25, promptAcceptMs: 5_000, exitGraceMs: 300, abortGraceMs: 300 },
      });
      // The board's write path: an append to the control file, nothing more.
      assert.equal(started.steer("focus on the tests"), true);
      return started.settled;
    });

    assert.match(
      JSON.stringify(result.messages),
      /steered: focus on the tests/,
      "the steer produced a new turn inside the same run",
    );
    const steers = received(root).filter((record) => record.type === "steer");
    assert.deepEqual(steers, [{ type: "steer", message: "focus on the tests" }]);

    const entry = readRun(dir, runId);
    assert.equal(entry?.status, "done", "a steered run is still one run with one runId");
    assert.equal(entry?.steers.length, 1);
    assert.equal(entry?.steers[0].message, "focus on the tests");
  } finally {
    await cleanup(root);
  }
});

test("transport: a steered run is only forwarded once per control line", async () => {
  const root = makeProject();
  try {
    const script = fakePi(
      root,
      `
      let steers = 0;
      read((record) => {
        if (record.type === "prompt") {
          send({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
        } else if (record.type === "steer") {
          steers += 1;
          if (steers >= 2) send({ type: "agent_settled", aborted: false });
        }
      });`,
    );
    const runId = queueOne(root);
    const dir = runsDir(root);
    const control = ctlPath(dir, runId);

    const result = await withFakePi(script, async () => {
      const started = startRun({
        projectRoot: root,
        runId,
        agentName: "myflow-implement",
        systemPrompt: "",
        writesUnder: null,
        prompt: "do the thing",
        config: {},
        contextKey: null,
        timeoutMs: 20_000,
        timings: { pollMs: 25, promptAcceptMs: 5_000, exitGraceMs: 300, abortGraceMs: 300 },
      });
      // Two writers appending the same logical command: each line is forwarded
      // once, and the offset keeps a re-read from replaying an old line.
      await waitFor(() => (readRun(dir, runId)?.pid ? true : undefined));
      appendControl(control, { type: "steer", message: "one" });
      appendControl(control, { type: "steer", message: "two" });
      return started.settled;
    });

    assert.equal(isFailedResult(result), false);
    assert.deepEqual(
      received(root).filter((record) => record.type === "steer").map((record) => record.message),
      ["one", "two"],
      "each line is forwarded exactly once, in file order",
    );
    assert.equal(readRun(dir, runId)?.steers.length, 2);
  } finally {
    await cleanup(root);
  }
});

test("transport: a run past its cap aborts, then kills the tree, and records timeout", async () => {
  const root = makeProject();
  try {
    const pidFile = join(root, "child.pid");
    const script = fakePi(
      root,
      `
      require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      read((record) => {
        if (record.type === "prompt") {
          send({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
          send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working" }], stopReason: "end" } });
        }
        // Every abort is ignored on purpose: the grace timer must be what stops it.
      });
      setInterval(() => {}, 1000);`,
    );
    const runId = queueOne(root);

    const result = await withFakePi(script, () =>
      startRun({
        projectRoot: root,
        runId,
        agentName: "myflow-implement",
        systemPrompt: "",
        writesUnder: null,
        prompt: "do the thing",
        config: {},
        contextKey: null,
        timeoutMs: 300,
        timings: { pollMs: 25, promptAcceptMs: 5_000, exitGraceMs: 300, abortGraceMs: 200 },
      }).settled,
    );

    assert.equal(result.timedOut, true);
    assert.equal(result.stopReason, "timeout");
    assert.equal(isFailedResult(result), true);
    await waitFor(() => (readFileSync(result.logPath!, "utf-8").includes("working") ? true : undefined));

    const entry = readRun(runsDir(root), runId);
    assert.equal(entry?.status, "timeout");
    assert.ok(entry?.endedAt);

    assert.ok(
      received(root).some((record) => record.type === "abort"),
      "abort is sent before the tree is killed",
    );
    const pid = Number(readFileSync(pidFile, "utf-8"));
    assert.ok(await waitForProcessGone(pid), "a run that ignores abort is killed, not orphaned");
  } finally {
    await cleanup(root);
  }
});

test("transport: a settled child that ignores the closed stdin is killed", async () => {
  const root = makeProject();
  try {
    const pidFile = join(root, "child.pid");
    const script = fakePi(
      root,
      `
      require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      read((record) => {
        if (record.type !== "prompt") return;
        send({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
        send({ type: "agent_settled", aborted: false });
      });
      // Deliberately ignores the closed stdin: the exit grace must stop it.
      setInterval(() => {}, 1000);`,
    );
    const runId = queueOne(root);

    const result = await withFakePi(script, () =>
      startRun({
        projectRoot: root,
        runId,
        agentName: "myflow-implement",
        systemPrompt: "",
        writesUnder: null,
        prompt: "do the thing",
        config: {},
        contextKey: null,
        timeoutMs: 20_000,
        timings: { pollMs: 25, promptAcceptMs: 5_000, exitGraceMs: 200, abortGraceMs: 300 },
      }).settled,
    );

    // The fake child sends no assistant message, so `stopReason` stays unset;
    // "finished cleanly" is what `isFailedResult` encodes.
    assert.equal(isFailedResult(result), false, "the run itself finished cleanly");
    const pid = Number(readFileSync(pidFile, "utf-8"));
    assert.ok(await waitForProcessGone(pid), "a child that ignores the closed stdin is killed");
  } finally {
    await cleanup(root);
  }
});

test("transport: a ctl abort stops the run", async () => {
  const root = makeProject();
  try {
    const script = fakePi(
      root,
      `
      read((record) => {
        if (record.type === "prompt") {
          send({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
          send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working" }], stopReason: "end" } });
        } else if (record.type === "abort") {
          send({ type: "agent_settled", aborted: true });
        }
      });`,
    );
    const runId = queueOne(root);
    const dir = runsDir(root);

    const result = await withFakePi(script, async () => {
      const started = startRun({
        projectRoot: root,
        runId,
        agentName: "myflow-implement",
        systemPrompt: "",
        writesUnder: null,
        prompt: "do the thing",
        config: {},
        contextKey: null,
        timeoutMs: 20_000,
        timings: { pollMs: 25, promptAcceptMs: 5_000, exitGraceMs: 300, abortGraceMs: 300 },
      });
      await waitFor(() => (readRun(dir, runId)?.pid ? true : undefined));
      appendControl(ctlPath(dir, runId), { type: "abort" });
      return started.settled;
    });

    assert.equal(result.stopReason, "aborted");
    assert.equal(readRun(dir, runId)?.status, "stopped");
    assert.ok(received(root).some((record) => record.type === "abort"));
  } finally {
    await cleanup(root);
  }
});

test("transport: a child that exits before settling is a failure, whatever its exit code", async () => {
  const root = makeProject();
  try {
    const script = fakePi(
      root,
      `
      read((record) => {
        if (record.type !== "prompt") return;
        send({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
        send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "half done" }], stopReason: "end" } });
        process.exit(0);
      });`,
    );
    const runId = queueOne(root);

    const result = await withFakePi(script, () =>
      startRun({
        projectRoot: root,
        runId,
        agentName: "myflow-implement",
        systemPrompt: "",
        writesUnder: null,
        prompt: "do the thing",
        config: {},
        contextKey: null,
        timeoutMs: 20_000,
        timings: { pollMs: 25, promptAcceptMs: 5_000, exitGraceMs: 300, abortGraceMs: 300 },
      }).settled,
    );

    assert.equal(result.exitCode, 0, "the exit code is recorded as reference information");
    assert.equal(result.stopReason, "unexpected exit");
    assert.equal(isFailedResult(result), true, "exit 0 does not make an unsettled run a success");
    const entry = readRun(runsDir(root), runId);
    assert.equal(entry?.status, "failed");
    assert.ok(entry?.endedAt);
  } finally {
    await cleanup(root);
  }
});

test("transport: a run the board already recorded as stopped keeps that verdict", async () => {
  const root = makeProject();
  try {
    const script = fakePi(
      root,
      `
      read((record) => {
        if (record.type !== "prompt") return;
        send({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
      });
      setInterval(() => {}, 1000);`,
    );
    const dir = runsDir(root);
    const runId = queueOne(root);

    const result = await withFakePi(script, async () => {
      const started = startRun({
        projectRoot: root,
        runId,
        agentName: "myflow-implement",
        systemPrompt: "",
        writesUnder: null,
        prompt: "do the thing",
        config: {},
        contextKey: null,
        timeoutMs: 20_000,
        timings: { pollMs: 5_000, promptAcceptMs: 5_000, exitGraceMs: 300, abortGraceMs: 300 },
      });
      const pid = await waitFor(() => readRun(dir, runId)?.pid || undefined);
      // What the tree view's `x` does: record the verdict, then kill the tree. The
      // control line is not polled first (the poll interval above is 5s), so this
      // side sees an unexpected exit.
      finish(dir, runId, "stopped", { stopReason: "stopped from the board" });
      killChildTree(pid);
      return started.settled;
    });

    assert.equal(result.stopReason, "aborted", "the caller still sees a stopped run");
    const entry = readRun(dir, runId);
    assert.equal(entry?.status, "stopped", "the operator's verdict is not rewritten as failed");
    assert.equal(entry?.stopReason, "stopped from the board");
  } finally {
    await cleanup(root);
  }
});

test("transport: a prompt the child refuses never waits for agent_settled", async () => {
  const root = makeProject();
  try {
    const script = fakePi(
      root,
      `
      read((record) => {
        if (record.type !== "prompt") return;
        send({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
      });
      setInterval(() => {}, 1000);`,
    );
    const runId = queueOne(root);

    const result = await withFakePi(script, () =>
      startRun({
        projectRoot: root,
        runId,
        agentName: "myflow-implement",
        systemPrompt: "",
        writesUnder: null,
        prompt: "do the thing",
        config: {},
        contextKey: null,
        timeoutMs: 20_000,
        timings: { pollMs: 25, promptAcceptMs: 5_000, exitGraceMs: 300, abortGraceMs: 300 },
      }).settled,
    );

    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /handled the prompt without starting a run/);
    assert.equal(readRun(runsDir(root), runId)?.status, "failed");
  } finally {
    await cleanup(root);
  }
});

test("transport: an unspawnable child fails the run entries instead of leaving them queued", async () => {
  const root = makeProject();
  const emptyPathDir = mkdtempSync(join(tmpdir(), "myflow-no-path-"));
  const argv1 = process.argv[1];
  const pathEnv = process.env.PATH;
  try {
    const runId = queueOne(root);
    process.argv[1] = "/nonexistent/not-a-script";
    process.env.PATH = emptyPathDir;
    const result = await startRun({
      projectRoot: root,
      runId,
      agentName: "myflow-implement",
      systemPrompt: "",
      writesUnder: null,
      prompt: "do the thing",
      config: {},
      contextKey: null,
      timeoutMs: 20_000,
    }).settled;

    assert.equal(isFailedResult(result), true);
    const entry = readRun(runsDir(root), runId);
    assert.equal(entry?.status, "failed");
    assert.ok(entry?.endedAt);
  } finally {
    process.argv[1] = argv1;
    process.env.PATH = pathEnv;
    rmSync(emptyPathDir, { recursive: true, force: true });
    assert.ok(!existsSync(emptyPathDir), `空 PATH 临时目录必须已删除：${emptyPathDir}`);
    await cleanup(root);
  }
});

test("myflow_subagent: a parallel dispatch is one group of registered runs", async () => {
  const root = makeProject();
  try {
    mkdirSync(join(root, ".pi", "agents"), { recursive: true });
    cpSync(join(ROOT, ".pi", "agents", "myflow-research.md"), join(root, ".pi", "agents", "myflow-research.md"));

    const script = fakePi(
      root,
      `
      read((record) => {
        if (record.type !== "prompt") return;
        send({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
        send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok: " + record.message }], stopReason: "end" } });
        send({ type: "agent_settled", aborted: false });
      });`,
    );

    const tools: Array<Record<string, any>> = [];
    registerMyflowSubagent({
      registerTool: (tool: Record<string, unknown>) => tools.push(tool as Record<string, any>),
      events: { emit: () => {} },
    } as any);
    const tool = tools.find((candidate) => candidate.name === "myflow_subagent")!;

    const result = (await withFakePi(script, () =>
      tool.execute(
        "id",
        { agent: "research", mode: "parallel", prompts: ["one", "two"] },
        undefined,
        undefined,
        { cwd: root },
      ),
    )) as { isError?: boolean; content: Array<{ text: string }>; details: { runs: unknown[] } };

    assert.equal(result.isError, false, "both runs settled cleanly");
    assert.equal(result.details.runs.length, 2);
    assert.match(result.content[0].text, /ok: one/);
    assert.match(result.content[0].text, /ok: two/);

    const { runs } = listRuns(runsDir(root));
    assert.equal(runs.length, 2, "one entry per run");
    assert.equal(new Set(runs.map((entry) => entry.group)).size, 1, "one dispatch call is one group");
    assert.deepEqual(
      runs.map((entry) => [entry.index, entry.total]),
      [
        [1, 2],
        [2, 2],
      ],
    );
    for (const entry of runs) {
      assert.equal(entry.status, "done");
      assert.equal(entry.mode, "parallel");
      assert.equal(entry.agent, "myflow-research");
      assert.ok(entry.endedAt, "a finished run records its end");
      assert.ok(entry.pid, "a started run records the child pid");
      assert.ok(entry.logPath, "a run points at its log");
    }
    for (const entry of runs) {
      assert.equal(existsSync(ctlPath(runsDir(root), entry.runId)), false, "control files are dropped on settle");
    }
  } finally {
    await cleanup(root);
  }
});
