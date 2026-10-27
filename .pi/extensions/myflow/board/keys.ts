/**
 * The panel's keyboard reducer: one key in, one `Action` out.
 *
 * Kept separate from the component so the panel's *policy* is testable without a
 * terminal: "which actions can the board produce?" is a question a test must be
 * able to ask, and it can only ask it if rendering and input are not entangled.
 *
 * Two rules:
 *
 *   - **The reducer never performs anything.** It returns the action; `actions.ts`
 *     executes it. That is what lets a test assert both "board cannot stop a run"
 *     and "tree `x` stops *this* run" without spawning a process.
 *   - **`normalizeKey` accepts an injected matcher.** The TUI supplies
 *     `keybindings.matches` so the user's own keymap decides what `enter` is; the
 *     fallback literals exist so tests (and a matcher-less caller) work too.
 *
 * Runtime imports are node-only, so `node --test` imports this directly.
 */

import { MENU_ITEMS, type BoardState, type ListView, type Selection, type View, type ViewTarget } from "./state.ts";

/** The keys the panel understands; anything else is `null` (ignored). */
export type NormalizedKey =
  | "up"
  | "down"
  | "enter"
  | "esc"
  | "x"
  | "X"
  | "s"
  | "r"
  | "c"
  | "d"
  | "D"
  | "q";

/** What the TUI must provide to interpret keys — `keybindings.matches`. */
export interface KeyMatcher {
  matches(data: string, action: string): boolean;
}

/** The navigation actions the TUI binds; read only with an injected matcher. */
const NAV_ACTIONS: ReadonlyArray<[string, NormalizedKey]> = [
  ["tui.select.up", "up"],
  ["tui.select.down", "down"],
  ["tui.select.confirm", "enter"],
  ["tui.select.cancel", "esc"],
];

/** Fallback bindings, used when no matcher is supplied (tests). */
const LITERAL_KEYS: Record<string, NormalizedKey> = {
  up: "up",
  down: "down",
  enter: "enter",
  esc: "esc",
  escape: "esc",
  q: "q",
  x: "x",
  X: "X",
  s: "s",
  r: "r",
  c: "c",
  d: "d",
  D: "D",
  // Arrow keys arrive as CSI (`ESC [ A`) or, once the terminal is in
  // application-cursor mode, as SS3 (`ESC O A`). Both are handled: a panel that
  // only understands one of them looks dead in exactly one terminal setup.
  "\u001b[A": "up",
  "\u001bOA": "up",
  "\u001b[B": "down",
  "\u001bOB": "down",
  // Left is "back", right is "open" — the ordinary list convention.
  "\u001b[D": "esc",
  "\u001bOD": "esc",
  "\u001b[C": "enter",
  "\u001bOC": "enter",
  "\u001b": "esc",
  "\r": "enter",
  "\n": "enter",
};

/** Map a raw terminal key to a panel key, or null when the panel ignores it. */
export function normalizeKey(data: string, keybindings?: KeyMatcher): NormalizedKey | null {
  if (keybindings) {
    for (const [action, key] of NAV_ACTIONS) {
      if (keybindings.matches(data, action)) return key;
    }
    // Single-character commands are not user-configurable bindings, so they are
    // matched literally even when a matcher is present.
    if (data === "X") return "X";
    const literal = LITERAL_KEYS[data];
    if (literal && literal !== "up" && literal !== "down" && literal !== "enter" && literal !== "esc") {
      return literal;
    }
  }
  return LITERAL_KEYS[data] ?? null;
}

/** What the caller should do in response to a key; `none` means "just redraw". */
export type Action =
  | { kind: "none" }
  | { kind: "close" }
  | { kind: "close-viewer" }
  | { kind: "open-view"; view: ListView }
  | { kind: "open-viewer"; target: ViewTarget }
  | { kind: "stop-run"; runId: string }
  | { kind: "delete-run"; runId: string }
  | { kind: "delete-finished" }
  | { kind: "cancel-group"; group: string }
  | { kind: "steer"; runId: string }
  | { kind: "restart-run"; runId: string }
  | { kind: "stop-bg"; id: string }
  | { kind: "prune-bg" }
  | { kind: "rerun-bg"; id: string };

export interface KeyResult {
  selection: Selection;
  action: Action;
}

const NONE: Action = { kind: "none" };

function clamp(value: number, max: number): number {
  if (max < 0) return 0;
  return value > max ? max : value < 0 ? 0 : value;
}

/** Prefer moving down; `-1` wraps to the last row. */
function stepDown(value: number, total: number): number {
  if (total <= 0) return 0;
  return value >= total - 1 ? 0 : value + 1;
}

/** Prefer moving up; the first row wraps to the last. */
function stepUp(value: number, total: number): number {
  if (total <= 0) return 0;
  return value <= 0 ? total - 1 : value - 1;
}

/**
 * Walk the tree: the cursor always sits on a *run*, so the group a key applies to
 * is always unambiguous (`X` cancels the group of the selected run).
 */
function stepTree(state: BoardState, delta: 1 | -1): Selection {
  const { groups } = state;
  const { groupIndex, runIndex } = state.selection;
  if (groups.length === 0) return { ...state.selection, groupIndex: 0, runIndex: 0 };
  const current = groups[clamp(groupIndex, groups.length - 1)];
  const size = Math.max(1, current.runs.length);
  if (delta === 1) {
    if (runIndex < size - 1) return { ...state.selection, groupIndex, runIndex: runIndex + 1 };
    const nextGroup = groupIndex >= groups.length - 1 ? 0 : groupIndex + 1;
    return { ...state.selection, groupIndex: nextGroup, runIndex: 0 };
  }
  if (runIndex > 0) return { ...state.selection, groupIndex, runIndex: runIndex - 1 };
  const prevGroup = groupIndex <= 0 ? groups.length - 1 : groupIndex - 1;
  return {
    ...state.selection,
    groupIndex: prevGroup,
    runIndex: Math.max(0, groups[prevGroup].runs.length - 1),
  };
}

function selectedRunId(state: BoardState): string | null {
  const group = state.groups[clamp(state.selection.groupIndex, state.groups.length - 1)];
  const run = group?.runs[clamp(state.selection.runIndex, Math.max(0, (group?.runs.length ?? 1) - 1))];
  return run?.runId ?? null;
}

function selectedGroupId(state: BoardState): string | null {
  return state.groups[clamp(state.selection.groupIndex, state.groups.length - 1)]?.group ?? null;
}

function selectedBackgroundId(state: BoardState): string | null {
  return state.background[clamp(state.selection.index, state.background.length - 1)]?.id ?? null;
}

/**
 * Reduce one key against the current view and state.
 *
 * `viewer` is handled first: while it is open the only meaningful keys are
 * "back" and "close", so a stray `x` cannot stop the run being read.
 */
export function applyKey(view: View, state: BoardState, key: NormalizedKey): KeyResult {
  const selection = state.selection;

  if (view === "viewer") {
    if (key === "esc" || key === "q") return { selection, action: { kind: "close-viewer" } };
    return { selection, action: NONE };
  }

  if (key === "q" || (key === "esc" && view !== "menu")) {
    return { selection, action: { kind: "close" } };
  }

  switch (view) {
    case "menu": {
      if (key === "esc") return { selection, action: { kind: "close" } };
      if (key === "up" || key === "down") {
        const next =
          key === "up"
            ? stepUp(selection.menuIndex, MENU_ITEMS.length)
            : stepDown(selection.menuIndex, MENU_ITEMS.length);
        return { selection: { ...selection, menuIndex: next }, action: NONE };
      }
      if (key === "enter") {
        return { selection, action: { kind: "open-view", view: MENU_ITEMS[clamp(selection.menuIndex, MENU_ITEMS.length - 1)] } };
      }
      return { selection, action: NONE };
    }

    case "board": {
      // Read-only: navigation and the read-only viewer, never a management key.
      const total = state.runs.length + state.background.length;
      if (key === "up" || key === "down") {
        const next = key === "up" ? stepUp(selection.index, total) : stepDown(selection.index, total);
        return { selection: { ...selection, index: next }, action: NONE };
      }
      if (key === "enter") {
        const index = clamp(selection.index, Math.max(0, total - 1));
        if (index < state.runs.length) {
          return { selection, action: { kind: "open-viewer", target: { kind: "run", runId: state.runs[index].runId } } };
        }
        const entry = state.background[index - state.runs.length];
        if (entry) return { selection, action: { kind: "open-viewer", target: { kind: "background", id: entry.id } } };
      }
      return { selection, action: NONE };
    }

    case "tree": {
      if (key === "up" || key === "down") {
        return { selection: stepTree(state, key === "up" ? -1 : 1), action: NONE };
      }
      const runId = selectedRunId(state);
      if (key === "enter") {
        return runId
          ? { selection, action: { kind: "open-viewer", target: { kind: "run", runId } } }
          : { selection, action: NONE };
      }
      if (key === "x") return runId ? { selection, action: { kind: "stop-run", runId } } : { selection, action: NONE };
      // Deleting is scoped to finished rows: a live one would be recreated by its
      // dispatcher, so the action (not the reducer) is what refuses it.
      if (key === "d") return runId ? { selection, action: { kind: "delete-run", runId } } : { selection, action: NONE };
      if (key === "D") return { selection, action: { kind: "delete-finished" } };
      if (key === "s") return runId ? { selection, action: { kind: "steer", runId } } : { selection, action: NONE };
      if (key === "r") return runId ? { selection, action: { kind: "restart-run", runId } } : { selection, action: NONE };
      if (key === "X") {
        const group = selectedGroupId(state);
        return group ? { selection, action: { kind: "cancel-group", group } } : { selection, action: NONE };
      }
      return { selection, action: NONE };
    }

    case "background": {
      const total = state.background.length;
      if (key === "up" || key === "down") {
        const next = key === "up" ? stepUp(selection.index, total) : stepDown(selection.index, total);
        return { selection: { ...selection, index: next }, action: NONE };
      }
      if (key === "c") return { selection, action: { kind: "prune-bg" } };
      const id = selectedBackgroundId(state);
      if (key === "enter") {
        return id ? { selection, action: { kind: "open-viewer", target: { kind: "background", id } } } : { selection, action: NONE };
      }
      if (key === "x") return id ? { selection, action: { kind: "stop-bg", id } } : { selection, action: NONE };
      if (key === "r") return id ? { selection, action: { kind: "rerun-bg", id } } : { selection, action: NONE };
      return { selection, action: NONE };
    }

    default:
      return { selection, action: NONE };
  }
}
