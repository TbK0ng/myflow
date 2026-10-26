import type { BgToolRegistration } from "./tools.ts";
import { BG_START_TOOL_NAME, createBgStartTool } from "./start.ts";
import { BG_OUTPUT_TOOL_NAME, createBgOutputTool } from "./output.ts";
import { BG_LIST_TOOL_NAME, createBgListTool } from "./list.ts";
import { BG_STOP_TOOL_NAME, createBgStopTool } from "./stop.ts";

export * from "./registry.ts";
export * from "./tools.ts";
export * from "./start.ts";
export * from "./output.ts";
export * from "./list.ts";
export * from "./stop.ts";

// ---------------------------------------------------------------------------
// Registration
//
// The four tools above are exported individually so a test can drive one
// `execute` with a stub context. Production goes through
// `registerMyflowBackground`, the single place that puts them on Pi's API.
//
// Dependency injection, not an import of `./index.ts`: `index.ts` calls this
// function, so importing it back would close the `index.ts` -> `background/`
// -> `index.ts` cycle. Everything session-specific (the context-key deriver,
// the sub-agent flag, the started-id hook) is passed in by the caller, exactly
// as `ask.ts` / `approval.ts` do it.
//
// The factory registers tools and nothing else: it starts no process and no
// timer, because an extension factory runs before any session exists
// (`docs/extensions.md`: "Do not start processes or timers in the factory").
// ---------------------------------------------------------------------------

/** The four `myflow_bg_*` tool names, as one set for the main-session guard. */
export const BG_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  BG_START_TOOL_NAME,
  BG_OUTPUT_TOOL_NAME,
  BG_LIST_TOOL_NAME,
  BG_STOP_TOOL_NAME,
]);

/** Minimal `pi` surface used by the registration function. */
export interface BgPi {
  registerTool(tool: Record<string, unknown>): void;
}

/**
 * Register all four background tools on the Pi extension API.
 *
 * `registration` is forwarded verbatim to every builder, so all four share one
 * `isSubAgent` and one `deriveContextKey`. `onStarted` is only consulted by
 * `myflow_bg_start`, which calls it after the registry entry is written.
 */
export function registerMyflowBackground(pi: BgPi, registration: BgToolRegistration = {}): void {
  pi.registerTool(createBgStartTool(registration));
  pi.registerTool(createBgOutputTool(registration));
  pi.registerTool(createBgListTool(registration));
  pi.registerTool(createBgStopTool(registration));
}
