import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  EMPTY_SELECTION,
  buildState,
  type BackgroundView,
  type BoardState,
  type GroupView,
  type RunView,
} from "../.pi/extensions/myflow/board/state.ts";
import {
  formatDuration,
  plainTheme,
  renderBackground,
  renderBoard,
  renderMenu,
  renderTree,
  renderViewer,
} from "../.pi/extensions/myflow/board/render.ts";
import { backgroundDir, writeEntry } from "../.pi/extensions/myflow/background/registry.ts";
import { markRunning, queueGroup, runsDir, writeRun, type RunEntry } from "../.pi/extensions/myflow/runs.ts";

// S5 — the three views plus the viewer, rendered as pure functions.
//
// Colors are asserted through a fake theme (`<accent>text`), and truncation is
// injected, so these tests read like the panel without a terminal.

const theme = { fg: (name: string, text: string) => `<${name}>${text}`, bold: (text: string) => text };

function ctx(width = 240) {
  return { theme, width, truncate: (text: string) => text };
}

function run(patch: Partial<RunView> = {}): RunView {
  return {
    runId: "r-1700000000000-aaaa",
    group: "g-1700000000000-aaaa",
    index: 1,
    total: 2,
    agent: "myflow-implement",
    mode: "parallel",
    status: "running",
    elapsedMs: 12_000,
    steered: false,
    preview: "reading subagent.ts",
    logPath: ".myflow/.runtime/subagent-logs/myflow-implement-1.log",
    error: null,
    ...patch,
  };
}

function group(patch: Partial<GroupView> = {}): GroupView {
  return {
    group: "g-1700000000000-aaaa",
    mode: "parallel",
    agent: "myflow-implement",
    status: "running",
    elapsedMs: 61_000,
    runs: [run(), run({ runId: "r-1700000000000-bbbb", index: 2, status: "done", elapsedMs: 60_000 })],
    ...patch,
  };
}

function background(patch: Partial<BackgroundView> = {}): BackgroundView {
  return {
    id: "bg-abc-0001",
    command: "npm run dev -- --port 3000",
    status: "running",
    exitCode: null,
    elapsedMs: 305_000,
    logPath: ".myflow/.runtime/background/bg-abc-0001.log",
    detached: true,
    ...patch,
  };
}

function state(patch: Partial<BoardState> = {}): BoardState {
  return {
    task: ".myflow/tasks/mysubagents-board",
    runs: [run(), run({ runId: "r-1700000000000-bbbb", index: 2, status: "done", elapsedMs: 60_000 })],
    groups: [group()],
    background: [background()],
    selection: { ...EMPTY_SELECTION },
    viewer: null,
    warnings: [],
    ...patch,
  };
}

function joined(lines: string[]): string {
  return lines.join("\n");
}

test("formatDuration: seconds, minutes, hours", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(7_400), "7s");
  assert.equal(formatDuration(61_000), "1m01s");
  assert.equal(formatDuration(7_500_000), "2h05m");
});

test("renderMenu: three views with descriptions and counts, cursor on the selection", () => {
  const lines = renderMenu(state({ selection: { ...EMPTY_SELECTION, menuIndex: 1 } }), ctx());
  const text = joined(lines);
  assert.match(text, /<accent>mysubagents/);
  assert.match(text, /board/);
  assert.match(text, /2 run\(s\) · 1 background/);
  assert.match(text, /1 group\(s\)/);
  assert.match(text, /1 task\(s\)/);
  // Row 1 (tree) carries the cursor.
  assert.match(lines[2], /^> tree/);
  assert.match(lines[1], /^ {2}board/);
  assert.match(text, /Enter open/);
});

test("renderBoard: front runs in accent, background in warning, labelled detached", () => {
  const text = joined(renderBoard(state(), ctx()));
  assert.match(text, /mysubagents · board · \.myflow\/tasks\/mysubagents-board/);
  assert.match(text, /FRONT RUNS — myflow_subagent \(2\)/);
  assert.match(text, /<accent>r-170000/);
  assert.match(text, /<warning>bg-abc-0001/);
  // The background section must say, in words, that the task outlives the terminal.
  assert.match(text, /<warning>BACKGROUND — 1 · detached · 终端退出后仍在运行/);
});

test("renderBoard: status glyphs colored, and the selected row marked", () => {
  const lines = renderBoard(state({ selection: { ...EMPTY_SELECTION, index: 1 } }), ctx());
  assert.match(lines[3], /^ {2}<success>▶/); // running first run: no cursor
  assert.match(lines[4], /^> <success>✓/); // done second run: cursor
  assert.match(lines[7], /^ {2}<success>▶ <warning>bg-abc-0001/); // the background row
});

test("renderBoard: read-only — no management key is advertised", () => {
  const text = joined(renderBoard(state(), ctx()));
  assert.doesNotMatch(text, /\bx stop\b/);
  assert.doesNotMatch(text, /steer/);
  assert.doesNotMatch(text, /rerun/);
  assert.doesNotMatch(text, /prune/);
  assert.match(text, /Enter read-only view · Esc close/);
});

test("renderBoard: failed runs read as errors, stale runs as muted", () => {
  const text = joined(
    renderBoard(
      state({
        runs: [
          run({ runId: "r-1-aaaa", status: "failed", error: "boom" }),
          run({ runId: "r-2-bbbb", status: "timeout" }),
          run({ runId: "r-3-cccc", status: "stale" }),
        ],
        groups: [],
        background: [],
      }),
      ctx(),
    ),
  );
  assert.match(text, /<error>✗ <accent>r-1-aaaa .* failed/);
  assert.match(text, /<error>⏱ <accent>r-2-bbbb .* timeout/);
  assert.match(text, /<muted>⊘ <accent>r-3-cccc .* stale/);
  assert.match(text, /\(no background task yet\)/);
});

test("renderTree: group header plus numbered members, steer mark, management footer", () => {
  const lines = renderTree(
    state({
      groups: [
        group(),
        group({
          group: "g-1700000009999-bbbb",
          mode: "single",
          status: "failed",
          elapsedMs: 5_000,
          runs: [run({ runId: "r-9-dddd", index: 1, total: 1, mode: "single", status: "failed", steered: true })],
        }),
      ],
    }),
    ctx(),
  );
  const text = joined(lines);
  assert.match(text, /▸ <success>▶ <accent>g-1700000000000-aaaa {2}myflow-implement {2}parallel {2}2 run\(s\) {2}1m01s {2}running/);
  assert.match(text, /^ {2}> <success>▶ <accent>1\/2 {2}r-170000.*running/m);
  assert.match(text, /^ {4}<success>✓ <accent>2\/2/m);
  assert.match(text, /»/); // the steered run in the second group
  assert.match(text, /x stop · X cancel group · s steer · r rerun · d delete · D clear finished · Enter view · Esc close/);
});

test("renderTree: an empty tree says so instead of rendering nothing", () => {
  const text = joined(renderTree(state({ groups: [], runs: [], background: [] }), ctx()));
  assert.match(text, /\(nothing dispatched yet\)/);
});

test("renderBackground: every entry, exit code, and the detached label", () => {
  const text = joined(
    renderBackground(
      state({
        background: [
          background(),
          background({ id: "bg-def-0002", command: "npm test", status: "exited", exitCode: 2, elapsedMs: 10_000 }),
          background({ id: "bg-ghi-0003", command: "sleep 1000", status: "stopped", elapsedMs: 1_000 }),
        ],
        selection: { ...EMPTY_SELECTION, index: 1 },
      }),
      ctx(),
    ),
  );
  assert.match(text, /mysubagents · background · detached · 终端退出后仍在运行 \(3\)/);
  assert.match(text, /<success>✓ <warning>bg-def-0002 {2}npm test {2}exited {2}exit 2/);
  assert.match(text, /<muted>■ <warning>bg-ghi-0003 {2}sleep 1000 {2}stopped/);
  assert.match(text, /x stop · c prune finished · r rerun · Enter output · Esc close/);
});

test("renderViewer: transcript kinds carry their color, long lines wrap", () => {
  const lines = renderViewer(
    state({
      viewer: {
        target: { kind: "run", runId: "r-1700000000000-aaaa" },
        title: "r-170000 · myflow-implement · parallel 1/2",
        subtitle: "running · .myflow/.runtime/subagent-logs/x.log",
        lines: [
          { kind: "text", text: "here is the answer" },
          { kind: "thinking", text: "considering the options" },
          { kind: "tool", text: 'bash {"command":"ls"}' },
          { kind: "result", text: "a b c" },
          { kind: "error", text: "provider refused" },
          { kind: "text", text: "x".repeat(30) },
        ],
      },
    }),
    { ...ctx(20), truncate: (text: string, width: number) => (text.length > width ? text.slice(0, width) : text) },
  );
  const text = joined(lines);
  assert.match(text, /<accent>r-170000 · m/); // clipped to the injected width
  assert.match(text, /<muted>running · \.my/);
  assert.match(text, /^here is the answer$/m);
  assert.match(text, /^<muted>… considering/m);
  assert.match(text, /^<accent>→ bash/m);
  assert.match(text, /^x{20}$/m); // 30 chars at width 20, wrapped
  assert.match(text, /<error>provider refused/);
  assert.match(text, /Esc back/);
});

test("renderViewer: only the tail of a long transcript is rendered, and every line fits", () => {
  const many = Array.from({ length: 260 }, (_, index) => ({ kind: "text" as const, text: `line ${index}` }));
  const lines = renderViewer(
    state({
      viewer: {
        target: { kind: "run", runId: "r-1700000000000-aaaa" },
        title: "r-170000 · agent",
        subtitle: "running · .myflow/.runtime/subagent-logs/x.log",
        lines: many,
      },
    }),
    { ...ctx(20), truncate: (text: string, width: number) => (text.length > width ? text.slice(0, width) : text) },
  );
  const text = joined(lines);
  // 260 lines at 200 shown: the newest 200 are on screen, the rest are named.
  assert.match(text, /<muted>… 60 earlier/);
  assert.doesNotMatch(text, /^line 59$/m, "the beginning is dropped, not the tail");
  assert.match(text, /^line 259$/m, "the newest line is what the viewer must show");

  // A wide (CJK) line is 2 columns per character, so wrapping by character count
  // alone would exceed the width; the rendered line must still fit.
  const wide = renderViewer(
    state({
      viewer: {
        target: { kind: "run", runId: "r-1700000000000-aaaa" },
        title: "t",
        subtitle: "s",
        lines: [{ kind: "text", text: "实施检查子代理".repeat(4) }],
      },
    }),
    { ...ctx(10), truncate: (value: string, width: number) => (value.length > width ? value.slice(0, width) : value) },
  );
  for (const line of wide) assert.ok(line.length <= 10, `over-wide line: ${JSON.stringify(line)}`);
});

test("renderViewer: a run with no log says so", () => {
  const text = joined(
    renderViewer(
      state({
        viewer: {
          target: { kind: "background", id: "bg-abc-0001" },
          title: "bg-abc-0001 · npm run dev",
          subtitle: "running · detached · x.log",
          lines: [],
        },
      }),
      ctx(),
    ),
  );
  assert.match(text, /\(nothing logged yet\)/);
});

test("renderViewer: no target renders a placeholder rather than throwing", () => {
  const text = joined(renderViewer(state({ viewer: null }), ctx()));
  assert.match(text, /nothing selected/);
});

test("plainTheme: the non-TUI report has no escape sequences", () => {
  const plain = plainTheme();
  assert.equal(plain.fg("accent", "x"), "x");
  assert.equal(plain.bold("x"), "x");
  const text = joined(renderBoard(state(), { theme: plain, width: 80, truncate: (t) => t }));
  assert.doesNotMatch(text, /<[a-z]+>/);
  assert.match(text, /detached · 终端退出后仍在运行/);
});

test("buildState: reads both registries, resolves previews, and clamps the selection", () => {
  const root = mkdtempSync(join(tmpdir(), "myflow-board-state-"));
  const now = Date.parse("2026-01-02T03:04:05.000Z");
  try {
    const dir = runsDir(root);
    const [first, second] = queueGroup(
      dir,
      [
        { agent: "myflow-implement", mode: "parallel", prompt: "one" },
        { agent: "myflow-implement", mode: "parallel", prompt: "two" },
      ],
      { now: now - 5_000, contextKey: "ctx-1" },
    );
    markRunning(dir, first.runId, { pid: 4242 }, now - 4_000);
    const log = join(root, ".myflow", ".runtime", "subagent-logs", "run.log");
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(
      log,
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello from the run" }] } }),
      "utf-8",
    );
    // Give the first run a log path and a fresh heartbeat.
    const entry = JSON.parse(JSON.stringify(first)) as RunEntry;
    writeRun(dir, {
      ...entry,
      logPath: ".myflow/.runtime/subagent-logs/run.log",
      status: "running",
      heartbeatAt: new Date(now).toISOString(),
      task: ".myflow/tasks/mysubagents-board",
    });
    // A second, long-dead run: its heartbeat is past the stale threshold.
    const staleEntry = JSON.parse(JSON.stringify(second)) as RunEntry;
    writeRun(dir, {
      ...staleEntry,
      status: "running",
      heartbeatAt: new Date(now - 31_000).toISOString(),
    });

    const bgEntry = {
      id: "bg-1-0001",
      command: "npm test",
      cwd: root,
      pid: 0,
      log: ".myflow/.runtime/background/bg-1-0001.log",
      exit_file: ".myflow/.runtime/background/bg-1-0001.exit",
      status: "exited" as const,
      exit_code: 3,
      started_at: new Date(now - 10_000).toISOString(),
      ended_at: new Date(now - 1_000).toISOString(),
      started_by_context_key: null,
      confirmed_by: "ui-confirm" as const,
    };
    writeEntry(backgroundDir(root), bgEntry);

    const built = buildState({ projectRoot: root, now, selection: { groupIndex: 99, index: 99, runIndex: 99 } });
    assert.equal(built.task, ".myflow/tasks/mysubagents-board");
    assert.equal(built.runs.length, 2);
    assert.equal(built.groups.length, 1);
    assert.equal(built.groups[0].runs.length, 2);
    assert.equal(built.runs[0].preview, "hello from the run");
    assert.equal(built.runs[0].status, "running");
    assert.equal(built.runs[1].status, "stale");
    assert.equal(built.background.length, 1);
    assert.equal(built.background[0].status, "exited");
    assert.equal(built.background[0].exitCode, 3);
    assert.equal(built.background[0].elapsedMs, 9_000);
    // Clamped into the rows that actually exist.
    // 2 runs + 1 background row: the outer bound is the last of them.
    assert.deepEqual(built.selection, { menuIndex: 0, index: 2, groupIndex: 0, runIndex: 1 });
    assert.deepEqual(built.warnings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildState: the viewer opens the selected run's transcript", () => {
  const root = mkdtempSync(join(tmpdir(), "myflow-board-state-"));
  try {
    const dir = runsDir(root);
    const [entry] = queueGroup(dir, [{ agent: "myflow-implement", mode: "single", prompt: "go" }]);
    writeFileSync(
      join(root, "run.log"),
      [
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }] } }),
      ].join("\n"),
      "utf-8",
    );
    writeRun(dir, { ...(entry as RunEntry), logPath: "run.log" });

    const built = buildState({ projectRoot: root, viewer: { kind: "run", runId: entry.runId } });
    assert.ok(built.viewer);
    assert.equal(built.viewer.target.kind, "run");
    assert.match(built.viewer.title, new RegExp(entry.runId.slice(0, 8)));
    assert.deepEqual(
      built.viewer.lines.map((line) => line.kind),
      ["text", "tool"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
