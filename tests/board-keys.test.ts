import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_SELECTION,
  type BackgroundView,
  type BoardState,
  type GroupView,
  type RunView,
} from "../.pi/extensions/myflow/board/state.ts";
import { applyKey, normalizeKey, type Action, type KeyMatcher } from "../.pi/extensions/myflow/board/keys.ts";

// S5 — the keyboard reducer. No component, no terminal: keys in, actions out.

function run(patch: Partial<RunView> = {}): RunView {
  return {
    runId: "r-1-aaaa",
    group: "g-1-aaaa",
    index: 1,
    total: 1,
    agent: "myflow-implement",
    mode: "single",
    status: "running",
    elapsedMs: 1_000,
    steered: false,
    preview: null,
    logPath: null,
    error: null,
    ...patch,
  };
}

function group(patch: Partial<GroupView> = {}): GroupView {
  return {
    group: "g-1-aaaa",
    mode: "single",
    agent: "myflow-implement",
    status: "running",
    elapsedMs: 1_000,
    runs: [run()],
    ...patch,
  };
}

function background(patch: Partial<BackgroundView> = {}): BackgroundView {
  return {
    id: "bg-1-0001",
    command: "npm test",
    status: "running",
    exitCode: null,
    elapsedMs: 1_000,
    logPath: ".myflow/.runtime/background/bg-1-0001.log",
    detached: true,
    ...patch,
  };
}

function state(patch: Partial<BoardState> = {}): BoardState {
  return {
    task: null,
    runs: [run()],
    groups: [group()],
    background: [background()],
    selection: { ...EMPTY_SELECTION },
    viewer: null,
    warnings: [],
    ...patch,
  };
}

/** Assert the action produced by one key press. */
function press(view: Parameters<typeof applyKey>[0], current: BoardState, key: Parameters<typeof applyKey>[2]): Action {
  return applyKey(view, current, key).action;
}

test("normalizeKey: literal keys without a matcher", () => {
  assert.equal(normalizeKey("up"), "up");
  assert.equal(normalizeKey("\u001b[A"), "up");
  assert.equal(normalizeKey("\u001b"), "esc");
  assert.equal(normalizeKey("escape"), "esc");
  assert.equal(normalizeKey("\r"), "enter");
  assert.equal(normalizeKey("X"), "X");
  assert.equal(normalizeKey("s"), "s");
  assert.equal(normalizeKey("z"), null);
  assert.equal(normalizeKey(""), null);
});

test("normalizeKey: a matcher decides the navigation keys, literals still work", () => {
  const matcher: KeyMatcher = { matches: (data, action) => action === "tui.select.up" && data === "K" };
  assert.equal(normalizeKey("K", matcher), "up");
  assert.equal(normalizeKey("J", matcher), null);
  // Single-character commands are not configurable bindings.
  assert.equal(normalizeKey("x", matcher), "x");
  assert.equal(normalizeKey("q", matcher), "q");
});

test("menu: up/down wrap, Enter opens the selected view, Esc and q close", () => {
  const base = state();
  const down = applyKey("menu", base, "down");
  assert.deepEqual(down.selection, { ...EMPTY_SELECTION, menuIndex: 1 });
  assert.equal(down.action.kind, "none");

  // Wraps forwards from the last row and backwards from the first.
  assert.equal(applyKey("menu", { ...base, selection: { ...EMPTY_SELECTION, menuIndex: 2 } }, "down").selection.menuIndex, 0);
  assert.equal(applyKey("menu", base, "up").selection.menuIndex, 2);

  assert.deepEqual(press("menu", base, "enter"), { kind: "open-view", view: "board" });
  assert.deepEqual(
    press("menu", { ...base, selection: { ...EMPTY_SELECTION, menuIndex: 2 } }, "enter"),
    { kind: "open-view", view: "background" },
  );
  assert.deepEqual(press("menu", base, "esc"), { kind: "close" });
  assert.deepEqual(press("menu", base, "q"), { kind: "close" });
});

test("board: read-only — navigation and the viewer, never a management action", () => {
  const base = state({
    runs: [run({ runId: "r-1-aaaa" }), run({ runId: "r-2-bbbb", index: 2, total: 2 })],
    groups: [group({ runs: [run({ runId: "r-1-aaaa" }), run({ runId: "r-2-bbbb", index: 2, total: 2 })] })],
  });
  for (const key of ["x", "X", "s", "r", "c"] as const) {
    assert.deepEqual(press("board", base, key), { kind: "none" }, `board must ignore ${key}`);
  }
  assert.deepEqual(press("board", base, "enter"), { kind: "open-viewer", target: { kind: "run", runId: "r-1-aaaa" } });
  // Row 2 is the background task.
  assert.deepEqual(
    press("board", { ...base, selection: { ...EMPTY_SELECTION, index: 2 } }, "enter"),
    { kind: "open-viewer", target: { kind: "background", id: "bg-1-0001" } },
  );
  assert.equal(applyKey("board", base, "down").selection.index, 1);
  assert.equal(applyKey("board", base, "up").selection.index, 2); // wraps over runs + background
  assert.deepEqual(press("board", base, "esc"), { kind: "close" });
});

test("tree: x/s/r target the selected run, X cancels its group", () => {
  const base = state({
    runs: [run({ runId: "r-1-aaaa" }), run({ runId: "r-2-bbbb", index: 2, total: 2 }), run({ runId: "r-3-cccc", group: "g-2-bbbb" })],
    groups: [
      group({ runs: [run({ runId: "r-1-aaaa" }), run({ runId: "r-2-bbbb", index: 2, total: 2 })] }),
      group({ group: "g-2-bbbb", runs: [run({ runId: "r-3-cccc", group: "g-2-bbbb" })] }),
    ],
  });

  assert.deepEqual(press("tree", base, "x"), { kind: "stop-run", runId: "r-1-aaaa" });
  assert.deepEqual(press("tree", base, "s"), { kind: "steer", runId: "r-1-aaaa" });
  assert.deepEqual(press("tree", base, "r"), { kind: "restart-run", runId: "r-1-aaaa" });
  assert.deepEqual(press("tree", base, "X"), { kind: "cancel-group", group: "g-1-aaaa" });
  assert.deepEqual(press("tree", base, "enter"), { kind: "open-viewer", target: { kind: "run", runId: "r-1-aaaa" } });

  // The group comes from the *selected* run, not from the first one.
  const second = { ...base, selection: { ...EMPTY_SELECTION, groupIndex: 1, runIndex: 0 } };
  assert.deepEqual(press("tree", second, "x"), { kind: "stop-run", runId: "r-3-cccc" });
  assert.deepEqual(press("tree", second, "X"), { kind: "cancel-group", group: "g-2-bbbb" });
});

test("tree: navigation walks members, then the next group", () => {
  const base = state({
    runs: [run({ runId: "r-1-aaaa" }), run({ runId: "r-2-bbbb" }), run({ runId: "r-3-cccc" })],
    groups: [
      group({ runs: [run({ runId: "r-1-aaaa" }), run({ runId: "r-2-bbbb", index: 2, total: 2 })] }),
      group({ group: "g-2-bbbb", runs: [run({ runId: "r-3-cccc", group: "g-2-bbbb" })] }),
    ],
  });
  const one = applyKey("tree", base, "down").selection;
  assert.deepEqual([one.groupIndex, one.runIndex], [0, 1]);
  const two = applyKey("tree", { ...base, selection: one }, "down").selection;
  assert.deepEqual([two.groupIndex, two.runIndex], [1, 0]);
  // Down from the last member of the last group wraps to the first.
  const wrapped = applyKey("tree", { ...base, selection: two }, "down").selection;
  assert.deepEqual([wrapped.groupIndex, wrapped.runIndex], [0, 0]);
  // Up from the first member returns to the last member of the previous group.
  const back = applyKey("tree", { ...base, selection: { ...EMPTY_SELECTION, groupIndex: 1, runIndex: 0 } }, "up").selection;
  assert.deepEqual([back.groupIndex, back.runIndex], [0, 1]);
});

test("tree: an empty registry produces no action instead of a bogus target", () => {
  const empty = state({ runs: [], groups: [], background: [] });
  for (const key of ["x", "X", "s", "r", "enter"] as const) {
    assert.deepEqual(press("tree", empty, key), { kind: "none" });
  }
  assert.deepEqual(applyKey("tree", empty, "down").selection, EMPTY_SELECTION);
});

test("background: x stops, c prunes, r reruns, Enter opens the output", () => {
  const base = state({
    background: [background({ id: "bg-1-0001" }), background({ id: "bg-2-0002" })],
  });
  assert.deepEqual(press("background", base, "x"), { kind: "stop-bg", id: "bg-1-0001" });
  assert.deepEqual(press("background", base, "c"), { kind: "prune-bg" });
  assert.deepEqual(press("background", base, "r"), { kind: "rerun-bg", id: "bg-1-0001" });
  assert.deepEqual(press("background", base, "enter"), {
    kind: "open-viewer",
    target: { kind: "background", id: "bg-1-0001" },
  });

  const second = { ...base, selection: { ...EMPTY_SELECTION, index: 1 } };
  assert.deepEqual(press("background", second, "x"), { kind: "stop-bg", id: "bg-2-0002" });
  assert.deepEqual(press("background", second, "r"), { kind: "rerun-bg", id: "bg-2-0002" });
  assert.equal(applyKey("background", base, "down").selection.index, 1);
});

test("background: an empty list ignores the management keys", () => {
  const empty = state({ runs: [], groups: [], background: [] });
  for (const key of ["x", "r", "enter"] as const) {
    assert.deepEqual(press("background", empty, key), { kind: "none" });
  }
  // Pruning an empty list is still harmless and idempotent.
  assert.deepEqual(press("background", empty, "c"), { kind: "prune-bg" });
});

test("viewer: Esc goes back to the list, and no key reaches a run", () => {
  const base = state({
    viewer: { target: { kind: "run", runId: "r-1-aaaa" }, title: "t", subtitle: "s", lines: [] },
  });
  assert.deepEqual(press("viewer", base, "esc"), { kind: "close-viewer" });
  assert.deepEqual(press("viewer", base, "q"), { kind: "close-viewer" });
  for (const key of ["x", "X", "s", "r", "c", "enter"] as const) {
    assert.deepEqual(press("viewer", base, key), { kind: "none" }, `viewer must ignore ${key}`);
  }
});

test("esc closes every list view; q closes too", () => {
  for (const view of ["board", "tree", "background"] as const) {
    assert.deepEqual(press(view, state(), "esc"), { kind: "close" });
    assert.deepEqual(press(view, state(), "q"), { kind: "close" });
  }
});

test("normalizeKey: SS3 arrows (application cursor mode) and left/right", () => {
  // A terminal in application-cursor mode sends ESC O A instead of ESC [ A; a
  // panel that only knows the CSI form looks dead in exactly one setup.
  assert.equal(normalizeKey("\u001bOA"), "up");
  assert.equal(normalizeKey("\u001bOB"), "down");
  assert.equal(normalizeKey("\u001bOD"), "esc", "left is back");
  assert.equal(normalizeKey("\u001bOC"), "enter", "right is open");
  assert.equal(normalizeKey("\u001b[A"), "up");
  assert.equal(normalizeKey("\u001b[B"), "down");
});

test("tree: d deletes the selected run, D clears the finished tail", () => {
  const base = state({ groups: [group({ runs: [run({ runId: "r-1-aaaa", status: "done" })] })] });
  assert.deepEqual(press("tree", base, "d"), { kind: "delete-run", runId: "r-1-aaaa" });
  assert.deepEqual(press("tree", base, "D"), { kind: "delete-finished" });
});

test("board: the read-only view cannot reach a delete", () => {
  for (const key of ["d", "D"] as const) {
    const action = press("board", state(), key);
    assert.notEqual(action.kind, "delete-run");
    assert.notEqual(action.kind, "delete-finished");
  }
});
