/**
 * Local type declaration for the `@oh-my-pi/pi-coding-agent` package.
 *
 * The real package ships the omp extension API surface. This declaration
 * mirrors it so `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"`
 * resolves without the package installed, keeping myflow 1:1 with Myflow.
 */
declare module "@oh-my-pi/pi-coding-agent" {
  /** Message shape used by the omp event system. */
  export interface Message {
    role: string;
    customType?: string;
    content?: string;
    display?: boolean;
    timestamp?: number;
  }

  /** Context passed to event hooks. */
  export interface HookContext {
    cwd: string;
    sessionManager?: {
      getSessionId?: () => string | undefined;
      getSessionFile?: () => string | undefined;
    };
    ui?: { notify: (msg: string, level: string) => void };
  }

  /** Extension API surface. */
  export interface ExtensionAPI {
    on: (
      event: string,
      handler: (event: unknown, ctx: HookContext) => void | Promise<void>,
    ) => void;
    sendMessage: (msg: {
      customType: string;
      content: string;
      display: boolean;
    }) => Promise<void>;
  }
}
