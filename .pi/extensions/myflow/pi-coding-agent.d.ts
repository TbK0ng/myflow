/**
 * Local type declaration for the `@earendil-works/pi-coding-agent` package.
 *
 * Pi loads extensions with `jiti` and aliases `@earendil-works/pi-coding-agent`
 * to its own runtime entry point, so extensions import types from here. This
 * declaration mirrors the subset of the extension API surface that the myflow
 * adapter uses, keeping the adapter dependency-free. At runtime the
 * imports are `import type`, so Node's type stripping erases them entirely.
 */
declare module "@earendil-works/pi-coding-agent" {
  /** Context passed to extension event handlers. */
  export interface ExtensionContext {
    cwd: string;
    mode: "tui" | "rpc" | "json" | "print";
    hasUI: boolean;
    sessionManager: {
      getSessionId(): string;
      getSessionFile(): string | undefined;
      getCwd(): string;
      getSessionName(): string | undefined;
    };
    model?: { provider: string; id: string };
    thinkingLevel?: string;
    /**
     * The UI surface this adapter uses. Deliberately minimal, and partly typed
     * as `any`: the shapes below are the ones the myflow extension calls, not a
     * promise that Pi's full TUI types are reproduced here. `custom`/`input`
     * stay loose because the component contract belongs to
     * `@earendil-works/pi-tui`, which this adapter must not depend on at load
     * time (`board/index.ts` imports it dynamically, inside the command
     * handler).
     */
    ui: {
      notify(message: string, type?: "info" | "warning" | "error"): void;
      confirm(title: string, message: string): Promise<boolean>;
      select(title: string, options: string[]): Promise<string | undefined>;
      /**
       * Take over the interactive area with a component until it calls `done`.
       * `theme`/`keybindings` are passed straight to the component; `done` both
       * resolves this promise and disposes the component.
       */
      custom<T>(
        factory: (
          tui: any,
          theme: any,
          keybindings: any,
          done: (result: T) => void,
        ) => any,
        options?: any,
      ): Promise<T>;
      /** One-line text dialog (used by the board's steer key). */
      input(title: string, placeholder?: string, opts?: any): Promise<string | undefined>;
    };
    isProjectTrusted(): boolean;
    isIdle(): boolean;
  }

  export type ExtensionHandler = (
    event: any,
    ctx: ExtensionContext,
  ) => unknown | Promise<unknown>;

  /** Result shape accepted by `pi.sendMessage`. */
  export interface CustomMessageInput {
    customType: string;
    content: string;
    display: boolean;
    details?: unknown;
  }

  /** Extension API surface. */
  export interface ExtensionAPI {
    on(event: string, handler: ExtensionHandler): () => void;
    registerTool(tool: any): void;
    /** `args` is the raw text after the command name; `ctx` is a command context. */
    registerCommand(
      name: string,
      options: {
        description?: string;
        handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
      },
    ): void;
    sendMessage(message: CustomMessageInput, options?: { triggerTurn?: boolean }): void;
    sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
    appendEntry(customType: string, data?: unknown): void;
    getActiveTools(): string[];
    setActiveTools(toolNames: string[]): void;
    events: {
      emit(channel: string, data: unknown): void;
      on(channel: string, handler: (data: unknown) => void): () => void;
    };
  }
}

/**
 * The TUI package, declared only where the adapter uses it.
 *
 * `board/index.ts` imports this dynamically, inside the `/mysubagents` command
 * handler, so the extension loads without the package. Only the one function the
 * panel passes to its renderers is declared: `render.ts` takes truncation as an
 * injected `(text, width) => string`, so nothing else of the TUI surface is
 * needed here.
 */
declare module "@earendil-works/pi-tui" {
  export function truncateToWidth(text: string, maxWidth: number, ellipsis?: string): string;
}
