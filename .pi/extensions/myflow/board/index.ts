/**
 * `/mysubagents` — the command and the only file in this tree that touches the
 * terminal.
 *
 * Three layers are deliberately kept out of here:
 *
 *   - what the registries contain (`state.ts`),
 *   - what the rows look like (`render.ts`),
 *   - which key means what (`keys.ts` / `actions.ts`).
 *
 * This module is the glue: it opens `ctx.ui.custom()`, owns the refresh timer,
 * and turns a `steer` key into the one interaction that cannot live inside the
 * component — a text dialog, which must run *after* the component closes or the
 * two would fight over focus.
 *
 * `@earendil-works/pi-tui` is imported dynamically inside the command handler, so
 * loading the extension never depends on the TUI package and `node --test` can
 * import this module. Every other import is a Node builtin or a node-only module
 * of this extension.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../agents.ts";
import { messageOf } from "../background/registry.ts";
import { findProjectRoot } from "../find-project-root.ts";
import { finish, pruneRuns, runsDir } from "../runs.ts";
import { SUBAGENT_TIMEOUT_MS, declaresWriteScope, resolveRunConfig } from "../subagent.ts";
import { startRun } from "../transport.ts";
import { createActionRunner, type ActionResult, type ActionRunner, type RestartRequest } from "./actions.ts";
import { applyKey, normalizeKey, type Action, type KeyMatcher } from "./keys.ts";
import { plainTheme, renderView, type BoardTheme } from "./render.ts";
import {
  EMPTY_SELECTION,
  buildState,
  clampSelection,
  shortId,
  type BoardState,
  type Selection,
  type View,
  type ViewTarget,
} from "./state.ts";

/** The command name, without the leading slash. */
export const COMMAND_NAME = "mysubagents";

/** How often the panel re-reads the registries; also the dispatcher's heartbeat cadence. */
export const REFRESH_MS = 1_000;

/** Width used by the plain-text report, where no terminal is measuring anything. */
export const TEXT_REPORT_WIDTH = 120;

/** The custom message type of the non-TUI report. */
export const REPORT_MESSAGE_TYPE = "myflow-subagents";

/** What the component hands back to the command: nothing, or a pending steer. */
export type PanelOutcome =
  | undefined
  | { kind: "steer"; runId: string; view: View; selection: Selection };

export interface SubagentsRegistration {
  /** Derive the calling session's context key; `index.ts` owns that rule. */
  deriveContextKey?: (ctx: unknown) => string | null;
}

/** The initial screen: an explicit view name, or the menu. */
export function parseViewArgument(args: string): View {
  const name = args.trim().toLowerCase();
  return name === "board" || name === "tree" || name === "background" ? name : "menu";
}

/** The colorless report shown when no terminal component is available. */
export function buildTextReport(projectRoot: string, view: View): string {
  const state = buildState({ projectRoot });
  return renderView(view, state, {
    theme: plainTheme(),
    width: TEXT_REPORT_WIDTH,
    // Nothing is measuring columns here, so nothing may be cut: the report is
    // read in a transcript that wraps on its own.
    truncate: (text: string) => text,
  }).join("\n");
}

const RUN_ANCHOR = "run:";
const BACKGROUND_ANCHOR = "bg:";

/**
 * The id of the row under the cursor.
 *
 * Needed because rows move while the panel is open: a run finishes, a prune drops
 * an old entry, a group re-sorts. A cursor that stayed on a line number would
 * silently point at a different run after the next tick.
 */
export function selectionAnchor(state: BoardState, view: View): string | null {
  const { selection } = state;
  if (view === "board") {
    const run = state.runs[selection.index];
    if (run) return `${RUN_ANCHOR}${run.runId}`;
    const entry = state.background[selection.index - state.runs.length];
    return entry ? `${BACKGROUND_ANCHOR}${entry.id}` : null;
  }
  if (view === "tree") {
    const run = state.groups[selection.groupIndex]?.runs[selection.runIndex];
    return run ? `${RUN_ANCHOR}${run.runId}` : null;
  }
  if (view === "background") {
    const entry = state.background[selection.index];
    return entry ? `${BACKGROUND_ANCHOR}${entry.id}` : null;
  }
  return null;
}

/**
 * Where an anchored row landed after a refresh, or null when it is gone.
 *
 * `board` numbers foreground runs first and background tasks after them, so the
 * same task id has two different indices depending on the view.
 */
export function locateAnchor(state: BoardState, view: View, anchor: string): Partial<Selection> | null {
  if (anchor.startsWith(RUN_ANCHOR)) {
    const runId = anchor.slice(RUN_ANCHOR.length);
    const index = state.runs.findIndex((run) => run.runId === runId);
    for (let groupIndex = 0; groupIndex < state.groups.length; groupIndex += 1) {
      const runIndex = state.groups[groupIndex].runs.findIndex((run) => run.runId === runId);
      if (runIndex >= 0) return { index: Math.max(0, index), groupIndex, runIndex };
    }
    return index >= 0 ? { index } : null;
  }
  const id = anchor.slice(BACKGROUND_ANCHOR.length);
  const at = state.background.findIndex((entry) => entry.id === id);
  if (at < 0) return null;
  return { index: view === "board" ? state.runs.length + at : at };
}

/** The slice of the TUI component contract the panel implements. */
export interface Panel {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose(): void;
}

export interface PanelOptions {
  projectRoot: string;
  runner: ActionRunner;
  view: View;
  selection: Selection;
  viewer: ViewTarget | null;
  theme: BoardTheme;
  keybindings: KeyMatcher;
  truncate: (text: string, width: number) => string;
  requestRender: () => void;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  finish: (outcome: PanelOutcome) => void;
}

/**
 * Build the panel component.
 *
 * State is rebuilt from disk on every tick and on every key. Both registries are
 * the source of truth, so a run started by another session appears here without
 * any wiring between the sessions.
 */
export function mountPanel(options: PanelOptions): Panel {
  let view = options.view;
  // `viewer` is a sub-screen: `listView` is the list it returns to, and the one
  // the cursor indexes into.
  let listView: View = view;
  let selection = options.selection;
  let viewer = options.viewer;
  let anchor: string | null = null;
  let state: BoardState = buildState({ projectRoot: options.projectRoot, viewer, selection });
  let cachedWidth: number | null = null;
  let cachedLines: string[] | null = null;
  let closed = false;

  const invalidate = () => {
    cachedWidth = null;
    cachedLines = null;
  };

  /** Re-read both registries, keep the cursor on its row, redraw. */
  const refresh = () => {
    const next = buildState({ projectRoot: options.projectRoot, viewer, selection });
    const relocated = anchor ? locateAnchor(next, listView, anchor) : null;
    next.selection = clampSelection(relocated ? { ...next.selection, ...relocated } : next.selection, next);
    state = next;
    selection = next.selection;
    anchor = selectionAnchor(state, listView);
    invalidate();
    options.requestRender();
  };

  const timer = setInterval(() => {
    try {
      refresh();
    } catch {
      // A refresh that throws once (a directory vanishing mid-listing) must not
      // take the panel — or the session's event loop — down with it.
    }
  }, REFRESH_MS);
  if (typeof timer.unref === "function") timer.unref();

  const stop = (outcome: PanelOutcome) => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    options.finish(outcome);
  };

  refresh();

  return {
    render(width: number): string[] {
      if (cachedLines && cachedWidth === width) return cachedLines;
      cachedWidth = width;
      cachedLines = renderView(view, state, {
        theme: options.theme,
        width,
        truncate: options.truncate,
      });
      return cachedLines;
    },

    handleInput(data: string): void {
      const key = normalizeKey(data, options.keybindings);
      if (!key) return;
      const reduced = applyKey(view, state, key);
      // Adopt the navigation first: the anchor must describe the row the cursor
      // moved *to*, so the refresh below re-finds that row instead of restoring
      // the one it came from. `selectionAnchor` reads `state.selection`, so it
      // must be handed the *new* selection — passing `state` alone anchors the
      // old row and the refresh undoes every move.
      selection = reduced.selection;
      anchor = selectionAnchor({ ...state, selection }, listView);
      const action: Action = reduced.action;

      switch (action.kind) {
        case "close":
          stop(undefined);
          return;
        case "open-view":
          listView = action.view;
          view = action.view;
          viewer = null;
          refresh();
          return;
        case "open-viewer":
          viewer = action.target;
          view = "viewer";
          refresh();
          return;
        case "close-viewer":
          viewer = null;
          view = listView;
          refresh();
          return;
        case "steer":
          // Close first: the steer dialog is a second input surface, and two
          // focused inputs would fight over the keyboard.
          stop({ kind: "steer", runId: action.runId, view: listView, selection });
          return;
        case "none":
          refresh();
          return;
        default: {
          // A background stop waits (bounded) for the process to disappear, so an
          // action may answer later. Calling the runner first keeps every
          // synchronous write happening now; only the notification and the
          // redraw are deferred to the settle step.
          const settle = (result: ActionResult) => {
            if (closed) return;
            if (result.message) options.notify(result.message, result.ok ? "info" : "warning");
            refresh();
          };
          void Promise.resolve(options.runner(action)).then(settle, (error) =>
            settle({ ok: false, message: messageOf(error) }),
          );
          return;
        }
      }
    },

    invalidate,

    dispose(): void {
      closed = true;
      clearInterval(timer);
    },
  };
}

/**
 * Dispatch a board-triggered rerun.
 *
 * Nothing keeps the handle: the tool call that dispatched the original run is
 * long gone, and a board key must answer at once rather than hold the panel
 * until a fresh sub-agent finishes. The registry entry (written by `queueGroup`
 * before this runs) is what makes the attempt visible.
 */
function restartAgent(request: RestartRequest): void {
  const dir = runsDir(request.projectRoot);
  const { agents } = discoverAgents(request.projectRoot);
  const agent = agents.find((candidate) => candidate.name === request.agent);
  if (!agent) {
    finish(dir, request.runId, "failed", { errorMessage: `no agent definition for ${request.agent}` });
    return;
  }
  const handle = startRun({
    projectRoot: request.projectRoot,
    runId: request.runId,
    agentName: agent.name,
    systemPrompt: agent.systemPrompt,
    // Same rule as the dispatcher: any non-blank declaration is injected so the
    // child's guard activates; a blank one leaves writes unbounded.
    writesUnder: declaresWriteScope(agent) ? agent.writesUnder!.trim() : null,
    prompt: request.prompt,
    config: resolveRunConfig({ model: request.model ?? undefined }, agent),
    contextKey: request.contextKey,
    timeoutMs: SUBAGENT_TIMEOUT_MS,
  });
  handle.settled.catch(() => {
    /* the registry already carries the outcome; nobody is waiting on this promise */
  });
}

async function openPanel(
  ctx: ExtensionContext,
  options: {
    projectRoot: string;
    runner: ActionRunner;
    initial: View;
    truncate: (text: string, width: number) => string;
  },
): Promise<void> {
  let view = options.initial;
  let selection: Selection = EMPTY_SELECTION;
  let viewer: ViewTarget | null = null;
  const notify = (message: string, type?: "info" | "warning" | "error") => {
    try {
      ctx.ui.notify(message, type);
    } catch {
      /* a notify failure must not close the panel */
    }
  };

  for (;;) {
    const outcome = await ctx.ui.custom<PanelOutcome>((tui, theme, keybindings, done) =>
      mountPanel({
        projectRoot: options.projectRoot,
        runner: options.runner,
        view,
        selection,
        viewer,
        theme,
        keybindings,
        truncate: options.truncate,
        requestRender: () => tui.requestRender(),
        notify,
        finish: done,
      }),
    );
    if (!outcome || outcome.kind !== "steer") return;
    // Reopen on the same screen and row after the dialog, so steering does not
    // throw the user back to the menu.
    view = outcome.view;
    selection = outcome.selection;
    viewer = null;
    let message: string | undefined;
    try {
      message = await ctx.ui.input(`Steer ${shortId(outcome.runId)}`, "one line for the running agent");
    } catch (error) {
      notify(`could not read the steer message: ${messageOf(error)}`, "error");
      continue;
    }
    if (!message?.trim()) continue;
    const result = await options.runner({ kind: "steer", runId: outcome.runId }, { message });
    if (result.message) notify(result.message, result.ok ? "info" : "warning");
  }
}

/**
 * Register `/mysubagents`.
 *
 * The argument is one of `board` / `tree` / `background`; anything else
 * (including nothing) opens the menu, because an unreadable argument should show
 * the three choices rather than guess.
 */
export function registerMyflowSubagentsCommand(
  pi: ExtensionAPI,
  registration: SubagentsRegistration = {},
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Open the mysubagents panel: board / tree / background",
    handler: async (args: string, ctx: ExtensionContext) => {
      const projectRoot = findProjectRoot(ctx.cwd) ?? ctx.cwd;
      const contextKey = registration.deriveContextKey?.(ctx) ?? null;
      const initial = parseViewArgument(args);
      try {
        // Once per open: pruning on every tick would delete rows under the cursor
        // while the user is looking at them.
        try {
          pruneRuns(runsDir(projectRoot));
        } catch {
          /* a prune failure must not keep the panel from opening */
        }
        const runner = createActionRunner({ projectRoot, contextKey, startRun: restartAgent });
        if (ctx.mode !== "tui" || typeof ctx.ui?.custom !== "function") {
          // A menu is a terminal affordance; without one, the report answers the
          // same question directly.
          const view = initial === "menu" ? "board" : initial;
          pi.sendMessage({
            customType: REPORT_MESSAGE_TYPE,
            content: buildTextReport(projectRoot, view),
            display: true,
          });
          if (ctx.hasUI) ctx.ui?.notify(`mysubagents: ${view}`, "info");
          return;
        }
        const { truncateToWidth } = await import("@earendil-works/pi-tui");
        await openPanel(ctx, { projectRoot, runner, initial, truncate: truncateToWidth });
      } catch (error) {
        const message = `mysubagents could not open: ${messageOf(error)}`;
        pi.sendMessage({ customType: REPORT_MESSAGE_TYPE, content: message, display: true });
        if (ctx.hasUI) ctx.ui?.notify(message, "error");
      }
    },
  });
}
