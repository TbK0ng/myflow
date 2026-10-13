/**
 * Local type declaration for the `@earendil-works/pi-coding-agent` package.
 *
 * Pi loads extensions with `jiti` and aliases `@earendil-works/pi-coding-agent`
 * to its own runtime entry point, so extensions import types from here. This
 * declaration mirrors the subset of the extension API surface that the myflow
 * adapter uses, keeping the reproduction dependency-free. At runtime the
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
    ui: {
      notify(message: string, type?: "info" | "warning" | "error"): void;
      confirm(title: string, message: string): Promise<boolean>;
      select(title: string, options: string[]): Promise<string | undefined>;
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
    registerCommand(name: string, options: any): void;
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
