/**
 * Pure renderers for the `/mysubagents` panel.
 *
 * Every function here is `(state, ctx) => string[]`: no clock, no filesystem, no
 * `pi-tui`. That is what makes the panel's appearance testable — a test injects
 * a fake theme (`<accent>…`) and an identity `truncate`, and asserts the rows,
 * sections and colors without a terminal.
 *
 * The production caller supplies `theme` from the TUI component and
 * `truncateToWidth` from `@earendil-works/pi-tui`; nothing in this module
 * imports either.
 *
 * Two conventions are load-bearing rather than cosmetic:
 *
 *   - **Color is applied per segment, never as an outer wrapper.** A nested
 *     `theme.fg` would emit a reset sequence in the middle of the row and end the
 *     outer color early, so the status glyph is colored on its own and the rest
 *     of the row carries the view's color.
 *   - **`board` shows no operation hints.** It is the read-only view; a footer
 *     advertising `x`/`s`/`r` there would be a lie.
 */

import type { BackgroundView, BoardState, GroupView, ListView, RunView, View } from "./state.ts";
import { MENU_ITEMS, shortId } from "./state.ts";

/** The slice of the Pi theme the panel uses. */
export interface BoardTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

/** Injected by the caller: the theme, the terminal width, and its truncation. */
export interface RenderContext {
  theme: BoardTheme;
  width: number;
  /** `truncateToWidth` in production; identity in tests. */
  truncate(text: string, width: number): string;
}

/** One row per status, so the three views agree on what a run looks like. */
const GLYPHS: Record<string, string> = {
  queued: "·",
  running: "▶",
  starting: "…",
  done: "✓",
  exited: "✓",
  failed: "✗",
  timeout: "⏱",
  stopped: "■",
  stale: "⊘",
  unknown: "?",
};

const STATUS_COLORS: Record<string, string> = {
  queued: "muted",
  running: "success",
  starting: "success",
  done: "success",
  exited: "success",
  failed: "error",
  timeout: "error",
  stopped: "muted",
  stale: "muted",
  unknown: "muted",
};

/** The one-line menu description for each list view. */
const MENU_DESCRIPTIONS: Record<ListView, string> = {
  board: "read-only overview of front runs and detached tasks",
  tree: "orchestration tree: stop / cancel group / steer / rerun",
  background: "detached tasks: stop / prune / rerun",
};

function glyph(status: string): string {
  return GLYPHS[status] ?? "?";
}

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? "muted";
}

/** `▶ running`, with only the glyph colored (see the module note on nesting). */
function statusTag(theme: BoardTheme, status: string): string {
  return `${theme.fg(statusColor(status), glyph(status))} ${status}`;
}

/** A duration a human reads at a glance: `7s`, `4m13s`, `2h05m`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function fit(ctx: RenderContext, text: string): string {
  return ctx.truncate(text, ctx.width);
}

/** Split a line into width-sized chunks; color is applied after this. */
function wrapText(text: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length <= limit) {
      out.push(raw);
      continue;
    }
    for (let at = 0; at < raw.length; at += limit) out.push(raw.slice(at, at + limit));
  }
  return out;
}

function marker(selected: boolean): string {
  return selected ? ">" : " ";
}

function sectionTitle(theme: BoardTheme, color: string, text: string): string {
  return theme.bold(theme.fg(color, text));
}

/**
 * The menu: three views, each with a description and its current entry count.
 *
 * The counts are why the menu exists — "is anything running?" is answerable
 * before opening a view.
 */
export function renderMenu(state: BoardState, ctx: RenderContext): string[] {
  const { theme } = ctx;
  const counts: Record<ListView, string> = {
    board: `${state.runs.length} run(s) · ${state.background.length} background`,
    tree: `${state.groups.length} group(s)`,
    background: `${state.background.length} task(s)`,
  };
  const lines = [fit(ctx, sectionTitle(theme, "accent", "mysubagents"))];
  MENU_ITEMS.forEach((view, index) => {
    const selected = index === state.selection.menuIndex;
    lines.push(
      fit(
        ctx,
        `${marker(selected)} ${view.padEnd(11)} ${theme.fg("muted", MENU_DESCRIPTIONS[view])}  (${counts[view]})`,
      ),
    );
  });
  lines.push("");
  lines.push(fit(ctx, theme.fg("muted", "↑/↓ move · Enter open · ? help · Esc close")));
  return lines;
}

function runRow(run: RunView, selected: boolean, ctx: RenderContext, paint: string): string {
  const { theme } = ctx;
  const body = [
    shortId(run.runId),
    run.agent,
    `${run.mode} ${run.index}/${run.total}`,
    formatDuration(run.elapsedMs),
    run.status,
    run.preview ?? "—",
  ];
  const tail = run.steered ? "  »" : "";
  // The status word stays inside the painted body; only the glyph carries its own
  // color, because a nested `fg` would reset the outer one mid-row.
  return fit(
    ctx,
    `${marker(selected)} ${theme.fg(statusColor(run.status), glyph(run.status))} ${theme.fg(paint, body.join("  "))}${tail}`,
  );
}

function backgroundRow(entry: BackgroundView, selected: boolean, ctx: RenderContext): string {
  const { theme } = ctx;
  const command = (entry.command.split("\n")[0] ?? "").trim();
  const exit = entry.exitCode === null ? "" : ` exit ${entry.exitCode}`;
  const body = [
    entry.id,
    command,
    entry.status,
    ...(exit ? [exit.trim()] : []),
    formatDuration(entry.elapsedMs),
  ];
  return fit(
    ctx,
    `${marker(selected)} ${theme.fg(statusColor(entry.status), glyph(entry.status))} ${theme.fg("warning", body.join("  "))}`,
  );
}

/**
 * The board: front runs (accent) above detached background tasks (warning).
 *
 * Strictly read-only — it renders no `x` / `s` / `r` hint on purpose. Enter
 * opens the read-only session viewer, which is navigation, not management.
 */
export function renderBoard(state: BoardState, ctx: RenderContext): string[] {
  const { theme } = ctx;
  const lines = [
    fit(ctx, sectionTitle(theme, "accent", `mysubagents · board${state.task ? ` · ${state.task}` : ""}`)),
    "",
    fit(ctx, sectionTitle(theme, "accent", `FRONT RUNS — myflow_subagent (${state.runs.length})`)),
  ];

  if (state.runs.length === 0) lines.push(fit(ctx, theme.fg("muted", "  (no subagent run yet)")));
  state.runs.forEach((run, index) => {
    lines.push(runRow(run, index === state.selection.index, ctx, "accent"));
  });

  lines.push("");
  lines.push(
    fit(
      ctx,
      sectionTitle(theme, "warning", `BACKGROUND — ${state.background.length} · detached · 终端退出后仍在运行`),
    ),
  );
  if (state.background.length === 0) lines.push(fit(ctx, theme.fg("muted", "  (no background task yet)")));
  state.background.forEach((entry, offset) => {
    lines.push(backgroundRow(entry, state.runs.length + offset === state.selection.index, ctx));
  });

  lines.push("");
  lines.push(fit(ctx, theme.fg("muted", "Enter read-only view · ? help · Esc close")));
  return lines;
}

function groupHeader(
  group: GroupView,
  count: number,
  active: boolean,
  ctx: RenderContext,
): string {
  const { theme } = ctx;
  const body = [
    `${group.group}`,
    group.agent,
    group.mode,
    `${count} run(s)`,
    formatDuration(group.elapsedMs),
    group.status,
  ];
  return fit(
    ctx,
    `${active ? "▸" : " "} ${theme.fg(statusColor(group.status), glyph(group.status))} ${theme.fg("accent", body.join("  "))}`,
  );
}

/** The tree: one group per dispatch call, members indented under it. */
export function renderTree(state: BoardState, ctx: RenderContext): string[] {
  const { theme } = ctx;
  const lines = [fit(ctx, sectionTitle(theme, "accent", `mysubagents · tree · ${state.groups.length} group(s)`))];
  if (state.groups.length === 0) {
    lines.push(fit(ctx, theme.fg("muted", "  (nothing dispatched yet)")));
  }
  state.groups.forEach((group, groupIndex) => {
    const active = groupIndex === state.selection.groupIndex;
    lines.push("");
    lines.push(groupHeader(group, group.runs.length, active, ctx));
    group.runs.forEach((run, runIndex) => {
      const selected = active && runIndex === state.selection.runIndex;
      const body = [
        `${run.index}/${run.total}`,
        shortId(run.runId),
        run.status,
        formatDuration(run.elapsedMs),
      ];
      lines.push(
        fit(
          ctx,
          `  ${marker(selected)} ${theme.fg(statusColor(run.status), glyph(run.status))} ${theme.fg("accent", body.join("  "))}${run.steered ? "  »" : ""}`,
        ),
      );
    });
  });
  lines.push("");
  lines.push(
    fit(
      ctx,
      theme.fg(
        "muted",
        "x stop · X cancel group · s steer · r rerun · d delete · D clear finished · Enter view · ? help · Esc close",
      ),
    ),
  );
  return lines;
}

/** The background view: every entry, finished ones included. */
export function renderBackground(state: BoardState, ctx: RenderContext): string[] {
  const { theme } = ctx;
  const lines = [
    fit(
      ctx,
      sectionTitle(theme, "warning", `mysubagents · background · detached · 终端退出后仍在运行 (${state.background.length})`),
    ),
  ];
  if (state.background.length === 0) lines.push(fit(ctx, theme.fg("muted", "  (no background task yet)")));
  state.background.forEach((entry, index) => {
    lines.push(backgroundRow(entry, index === state.selection.index, ctx));
  });
  lines.push("");
  lines.push(fit(ctx, theme.fg("muted", "x stop · d delete · D clear finished · c prune 24h · r rerun · Enter output · ? help · Esc close")));
  return lines;
}

/**
 * How many transcript lines the viewer renders. A transcript can be thousands of
 * lines (every tool result is in it) and the terminal area is fixed, so the tail
 * — the part that is still moving — is what the viewer shows; the log holds the
 * rest and the subtitle names it.
 */
export const VIEWER_MAX_LINES = 200;

/** The read-only session viewer for one run's transcript or one task's output. */
export function renderViewer(state: BoardState, ctx: RenderContext): string[] {
  const { theme } = ctx;
  if (!state.viewer) {
    return [fit(ctx, theme.fg("muted", "nothing selected")), "", fit(ctx, theme.fg("muted", "Esc back"))];
  }
  const { title, subtitle, lines } = state.viewer;
  const out = [fit(ctx, theme.bold(theme.fg("accent", title))), fit(ctx, theme.fg("muted", subtitle)), ""];
  if (lines.length === 0) {
    out.push(fit(ctx, theme.fg("muted", "(nothing logged yet)")));
  }
  if (lines.length > VIEWER_MAX_LINES) {
    out.push(fit(ctx, theme.fg("muted", `… ${lines.length - VIEWER_MAX_LINES} earlier line(s) — full log: ${subtitle}`)));
  }
  for (const line of lines.slice(-VIEWER_MAX_LINES)) {
    const color = line.kind === "error" ? "error" : line.kind === "tool" ? "accent" : line.kind === "text" ? "" : "muted";
    const prefix = line.kind === "thinking" ? "… " : line.kind === "tool" ? "→ " : line.kind === "result" ? "  " : "";
    // Every rendered line must fit the width, and `wrapText` counts characters:
    // a wide (CJK) or emoji line still needs truncating. Truncate before coloring
    // so the width measures visible text, not escape sequences.
    for (const chunk of wrapText(`${prefix}${line.text}`, ctx.width)) {
      const fitted = fit(ctx, chunk);
      out.push(color ? theme.fg(color, fitted) : fitted);
    }
  }
  out.push("");
  out.push(fit(ctx, theme.fg("muted", "Esc back")));
  return out;
}

/** Render whichever view the state says is open. */
export function renderView(view: View, state: BoardState, ctx: RenderContext): string[] {
  switch (view) {
    case "menu":
      return renderMenu(state, ctx);
    case "tree":
      return renderTree(state, ctx);
    case "background":
      return renderBackground(state, ctx);
    case "viewer":
      return renderViewer(state, ctx);
    case "help":
      return renderHelp(ctx);
    case "board":
    default:
      return renderBoard(state, ctx);
  }
}

/** A colorless theme, for the non-TUI text report (`design.md` §6). */
export function plainTheme(): BoardTheme {
  return { fg: (_name: string, text: string) => text, bold: (text: string) => text };
}

/**
 * The help screen.
 *
 * Keys alone are not enough: the panel's whole point is that a key *writes a
 * file* another session reads, that `x` really kills a process tree, and that a
 * live row cannot be deleted. None of that is discoverable from a footer, and a
 * user who assumes otherwise will think a refused key is broken.
 */
export function renderHelp(ctx: RenderContext): string[] {
  const { theme } = ctx;
  const title = theme.bold(theme.fg("accent", "mysubagents — help"));
  const section = (text: string) => theme.fg("accent", text);
  const key = (keys: string, what: string) => fit(ctx, `  ${theme.fg("accent", keys.padEnd(10))} ${what}`);

  const lines: string[] = [title, ""];

  lines.push(section("Views"));
  lines.push(fit(ctx, `  ${theme.fg("accent", "board".padEnd(10))} read-only: front runs (accent) + detached tasks (warning), Enter reads`));
  lines.push(fit(ctx, `  ${theme.fg("accent", "tree".padEnd(10))} one dispatch call = one group; manage its runs`));
  lines.push(fit(ctx, `  ${theme.fg("accent", "background".padEnd(10))} detached tasks that outlive this terminal`));
  lines.push("");

  lines.push(section("Keys"));
  lines.push(key("↑/↓", "move the cursor"));
  lines.push(key("← / →", "back / open (same as Esc / Enter)"));
  lines.push(key("Enter", "open a run's transcript or a task's output"));
  lines.push(key("x", "stop it: abort, then kill the process tree after 5s"));
  lines.push(key("X", "cancel the whole group (tree only)"));
  lines.push(key("s", "steer: queue one line for that run's next turn (tree only)"));
  lines.push(key("r", "rerun: same agent+prompt, new run id (task: replay the command)"));
  lines.push(key("d / D", "forget the selected finished row / every finished row"));
  lines.push(key("c", "prune tasks finished more than 24h ago (background only)"));
  lines.push(key("? / Esc / q", "help / close the screen"));
  lines.push("");

  lines.push(section("What the operations really do"));
  lines.push(fit(ctx, "  A run is a child `pi --mode rpc` process. `x` and `s` are written to"));
  lines.push(fit(ctx, "  .myflow/.runtime/subagents/<runId>.ctl.jsonl, which the dispatcher polls"));
  lines.push(fit(ctx, "  once a second — that file is why a second session can manage a run whose"));
  lines.push(fit(ctx, "  dispatcher is blocked in its own tool call."));
  lines.push(fit(ctx, "  A live row is refused by `d`: its dispatcher still owns the entry, so the"));
  lines.push(fit(ctx, "  next status write would resurrect it. Stop it first."));
  lines.push(fit(ctx, "  Deleting a run keeps its log (the transcript); deleting a task deletes its"));
  lines.push(fit(ctx, "  log and pid file, exactly as the 24h prune does."));
  lines.push("");

  lines.push(section("Status"));
  lines.push(fit(ctx, `  ${theme.fg("success", "▶")} running   ${theme.fg("success", "✓")} done   ${theme.fg("error", "✗")} failed   ${theme.fg("error", "⏱")} timeout`));
  lines.push(fit(ctx, `  ${theme.fg("muted", "■")} stopped   ${theme.fg("muted", "⊘")} stale (its dispatcher disappeared)   ${theme.fg("muted", "·")} queued`));
  lines.push(fit(ctx, "  A run marked » received at least one steer."));
  lines.push("");

  lines.push(fit(ctx, theme.fg("muted", "? / Esc / q back")));
  return lines;
}
