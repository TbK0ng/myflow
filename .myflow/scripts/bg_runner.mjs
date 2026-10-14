#!/usr/bin/env node
/**
 * Background-task wrapper for the Myflow Pi harness.
 *
 * A *background task* is a shell command that outlives the session that started
 * it. `myflow_bg_start` launches this script detached; the script runs the
 * command and records how the command ended, so a *later* session can still
 * report the exit code. That is the whole reason this wrapper exists:
 *
 *   A detached child is never waited on. If the extension spawned the command
 *   directly and called `unref()`, nobody would be left to observe `exit`, and
 *   the exit code would be lost forever. Here the wrapper is the detached
 *   process, so *it* can wait, while the extension returns immediately.
 *
 * Layout (see `design.md` §2):
 *
 *   node bg_runner.mjs --id <taskId> --log <logPath> --exit <exitPath> -- <command...>
 *
 *   - `<command...>` is reassembled into one string and handed to the resolved
 *     shell as a *single* argv element. It is deliberately **not** passed
 *     through Node's `shell: true`: on Windows that hardcodes `%ComSpec%`
 *     (`cmd.exe`) and rebuilds the command as `cmd.exe /d /s /c "<command>"`,
 *     a second round of quote parsing the caller never asked for. Spawning the
 *     shell ourselves keeps pipes, `&&`, and redirection working while passing
 *     the command through verbatim.
 *   - The shell is resolved by `resolveShellPath`, in this fixed order:
 *     `MYFLOW_BG_SHELL` -> `~/.pi/agent/settings.json`'s `shellPath` -> the Git
 *     for Windows bash -> `bash` on `PATH` -> an explicit `cmd.exe /d /s /c`
 *     fallback. The resolved absolute path is recorded in `<exitPath>` under
 *     `shell`, on both the success and failure records, so "which shell ran
 *     this?" is always answerable after the fact.
 *   - The command's stdout and stderr are pointed at the log file's descriptor
 *     directly, so the kernel writes them; nothing is buffered in this process
 *     (`design.md` §2). Appended bytes are visible to another process that
 *     reads the file while the command is still running.
 *   - **Platform trap (measured)**: that descriptor is opened `"w"`, not `"a"`.
 *     Git Bash is an MSYS program, and on this Node/Windows an append-mode
 *     (`O_APPEND`) file descriptor handed to it through `stdio` is not usable:
 *     the shell starts and every write fails with `Bad file descriptor`
 *     (`cmd.exe` accepts the same descriptor, but the shell we resolve is bash).
 *     A `"w"` descriptor works. Because a task id is unique, its log file is
 *     never reused, so truncate-on-open changes nothing observable.
 *   - When the command exits this script writes `<exitPath>`:
 *       `{"exit_code":N,"signal":S,"at":"<ISO>","shell":"<path>"}` on a
 *       normal exit,
 *       `{"exit_code":null,"error":"...","at":"<ISO>","shell":"<path>"}`
 *       when it could not be spawned. The write is atomic (temp file + rename)
 *       so a concurrent reader never observes a half-written record
 *       (`design.md` §3.2).
 *
 * Contract, not a local choice:
 *
 *   - This script is standalone. It imports nothing from `.pi/` and writes no
 *     registry entry: the *tool* owns `<taskId>.json`, the wrapper owns only
 *     `<log>` and `<exit>` (`design.md` §3.1, ADR-4).
 *   - It never writes to stdout or stderr. It is started detached with
 *     `stdio: "ignore"`; any output would be discarded, and the log is the only
 *     channel that matters. Its own exit code is the diagnostic: 0 when the
 *     command succeeded, the command's code when it failed, and a non-zero
 *     synthetic code when the command could not be started at all.
 *   - It does not `process.exit()`. Exiting early could truncate the `.exit`
 *     write; it sets `process.exitCode` and lets the event loop drain instead.
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Synthetic exit codes for failures that happen before the command runs. */
const EXIT_BAD_ARGS = 2;
const EXIT_SPAWN_FAILED = 1;

/**
 * Windows can refuse to replace a file that another process currently holds
 * open (`EPERM`/`EACCES`/`EBUSY`) even though the reader only asked for read
 * access. A reader of the output or of the `.exit` record is exactly that case,
 * so a rename that fails for one of these transient reasons is retried briefly
 * instead of being reported as a write failure. Total wait is bounded by
 * `RENAME_RETRIES * RENAME_RETRY_MS`.
 */
const RENAME_RETRY_MS = 20;
const RENAME_RETRIES = 50;
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Bounded retry policy for a *transient* process-creation failure.
 *
 * Windows occasionally refuses to create a process with ERROR_NO_SYSTEM_RESOURCES
 * (232) while the machine is momentarily short of some resource (paged pool,
 * desktop heap, handles). The same command usually starts if it is attempted
 * again a moment later, so a small bounded number of retries turns a transient
 * refusal into a delayed success instead of a task that never started.
 *
 * Only *transient/unknown* failures are retried. A missing program (`ENOENT`),
 * a bad argument (`EINVAL`), or a permission problem (`EACCES` / `EPERM`) will
 * fail identically no matter how many times it is attempted, so retrying those
 * just wastes time and hides the real error.
 */
const MAX_SPAWN_RETRIES = 2;
const SPAWN_RETRY_DELAY_MS = 250;
const RETRYABLE_SPAWN_CODES = new Set(["EAGAIN", "ENOMEM", "EMFILE", "ENFILE"]);
const NON_RETRYABLE_SPAWN_CODES = new Set(["ENOENT", "EINVAL", "EACCES", "EPERM"]);

/**
 * Whether a failed process creation is worth one more attempt.
 *
 * `EAGAIN`, `ENOMEM`, `EMFILE` and `ENFILE` are the resource-exhaustion codes
 * the OS reports. A code we do not recognize is treated as transient too:
 * Windows errors with no POSIX mapping surface as `UNKNOWN`, and an error with
 * no `code` at all cannot be classified, so the user's 232 lands here. The four
 * codes known to be deterministic are never retried.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryableSpawnError(error) {
  const code =
    error && typeof error === "object"
      ? /** @type {{ code?: unknown }} */ (error).code
      : undefined;
  if (typeof code !== "string" || code.trim() === "") return true;
  if (RETRYABLE_SPAWN_CODES.has(code)) return true;
  if (NON_RETRYABLE_SPAWN_CODES.has(code)) return false;
  return true;
}

/**
 * Where the shell that runs a background command is configured.
 *
 * `MYFLOW_BG_SHELL` is an explicit override (tests and users), so it is taken
 * **verbatim** — deliberately without an existence check. That is what makes an
 * unspawnable shell observable: the caller asks for a path, `spawn` then fails
 * with `ENOENT`, and the wrapper records that failure with the requested path
 * in `shell`. Every later candidate is a real location, so a stale entry is
 * skipped instead of poisoning the start.
 */
const SETTINGS_REL = [".pi", "agent", "settings.json"];
const GIT_BASH_REL = ["Program Files", "Git", "bin", "bash.exe"];

/**
 * Read `shellPath` out of `~/.pi/agent/settings.json`, or null.
 *
 * A missing file, unparseable JSON, a non-string `shellPath`, or a value that
 * does not exist on disk all yield null: the caller moves on to the next
 * candidate rather than spawning a shell that is not there. The settings file
 * is the same source Pi itself reads, so a background command uses the shell
 * the user already chose for their tools.
 */
function readSettingsShellPath(settingsPath, exists, readFile) {
  try {
    if (!exists(settingsPath)) return null;
    const parsed = JSON.parse(readFile(settingsPath));
    const value =
      parsed && typeof parsed === "object" && typeof parsed.shellPath === "string"
        ? parsed.shellPath.trim()
        : "";
    return value && exists(value) ? value : null;
  } catch {
    return null;
  }
}

/** Find a bare `name` on `PATH` and return its absolute path, or null. */
function findOnPath(name, platform, pathValue, exists) {
  const candidates = platform === "win32" ? [`${name}.exe`, name] : [name];
  // The separator follows the *resolved* platform, not the host, so an injected
  // `platform` (tests) behaves like the machine it stands in for.
  const separator = platform === "win32" ? ";" : ":";
  for (const directory of String(pathValue).split(separator)) {
    if (!directory) continue;
    // Never fall back to the WSL launcher. On Windows `%SystemRoot%\System32\bash.exe`
    // is the WSL entry point, which this project forbids invoking; a Git Bash
    // lives elsewhere on PATH (and its standard location is tried before this).
    // `Sysnative` is the same thing seen by a 32-bit process.
    if (platform === "win32") {
      const base = basename(directory).toLowerCase();
      if (base === "system32" || base === "sysnative") continue;
    }
    for (const candidate of candidates) {
      const full = join(directory, candidate);
      if (exists(full)) return full;
    }
  }
  return null;
}

/**
 * Resolve the absolute path of the shell that runs the command.
 *
 * Order (fixed; this is the only implementation of it):
 *   1. `MYFLOW_BG_SHELL` — explicit override, used verbatim.
 *   2. `~/.pi/agent/settings.json` `shellPath` — the user's own choice.
 *   3. The Git for Windows bash, at its standard install location.
 *   4. `bash` on `PATH`.
 *   5. An explicit `cmd.exe` from `%ComSpec%` (POSIX: `/bin/sh`) — the last
 *      resort, still spawned with argv so there is no nested-quote problem.
 *
 * Injectable (`env`, `platform`, `exists`, `readFile`, `homeDir`, `pathValue`)
 * so the order can be tested without touching the machine's real settings.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   exists?: (path: string) => boolean,
 *   readFile?: (path: string) => string,
 *   homeDir?: string,
 *   pathValue?: string,
 * }} [options]
 * @returns {string}
 */
export function resolveShellPath(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const readFile = options.readFile ?? ((path) => readFileSync(path, "utf-8"));
  const homeDir = options.homeDir ?? homedir();
  const pathValue = options.pathValue ?? env.PATH ?? env.Path ?? env.path ?? "";

  // 1. Explicit override, taken verbatim (see SETTINGS_REL docs above).
  const override = typeof env.MYFLOW_BG_SHELL === "string" ? env.MYFLOW_BG_SHELL.trim() : "";
  if (override) return override;

  // 2. The user's configured shell path.
  const fromSettings = readSettingsShellPath(join(homeDir, ...SETTINGS_REL), exists, readFile);
  if (fromSettings) return fromSettings;

  // 3. Git for Windows' standard install location.
  if (platform === "win32") {
    const gitBash = join("C:\\", ...GIT_BASH_REL);
    if (exists(gitBash)) return gitBash;
  }

  // 4. `bash` on PATH.
  const onPath = findOnPath("bash", platform, pathValue, exists);
  if (onPath) return onPath;

  // 5. Explicit fallback: `%ComSpec%` on Windows, `/bin/sh` elsewhere.
  const comspec = (env.ComSpec ?? env.COMSPEC ?? "").trim();
  if (comspec) return comspec;
  return platform === "win32" ? "cmd.exe" : "/bin/sh";
}

/** Whether a resolved shell should be driven as `cmd.exe` (`/d /s /c`). */
export function isCmdShell(shellPath) {
  const base = basename(shellPath).toLowerCase();
  return base === "cmd" || base === "cmd.exe";
}

/**
 * The argv a resolved shell needs to run one command string.
 *
 * The command is always a **single** element: that is the whole point of
 * spawning the shell ourselves. bash receives `-lc` (a login shell, matching
 * how the user's Git Bash runs); anything that is not `cmd.exe` is treated as a
 * POSIX shell, which is what the resolution order guarantees here.
 */
export function shellArgsFor(shellPath, command) {
  if (isCmdShell(shellPath)) return ["/d", "/s", "/c", command];
  return ["-lc", command];
}

function sleepSync(milliseconds) {
  // `Atomics.wait` on a throwaway buffer is the only portable synchronous
  // sleep: this runs inside an `exit` handler, where there is no event loop
  // turn left to schedule a timer on.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Parse the command line.
 *
 * Flags are read until the first literal `--`; everything after it is the
 * command. The command is joined back into a single string because the caller
 * passes it as one argument (it may itself contain spaces, quotes, pipes, or
 * redirection) and a shell receives one string anyway.
 *
 * Unknown flags before `--` are a hard error rather than a silently ignored
 * typo: a mistyped `--exit` would otherwise make the wrapper "succeed" while
 * writing the record nowhere.
 *
 * @param {string[]} argv arguments after the executable, i.e. `process.argv.slice(2)`
 * @returns {{ id: string | null, log: string | null, exit: string | null, command: string | null }}
 */
export function parseArgs(argv) {
  const options = { id: null, log: null, exit: null, command: null };
  let index = 0;
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      index += 1;
      break;
    }
    if (arg === "--id") {
      options.id = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--log") {
      options.log = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--exit") {
      options.exit = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  const commandParts = argv.slice(index);
  options.command = commandParts.length > 0 ? commandParts.join(" ") : null;
  return options;
}

/**
 * Write the `.exit` record atomically: fill a sibling temp file, then rename it
 * over the destination. A reader therefore sees either the previous file or the
 * complete new one, never a partial write. Renaming also replaces an existing
 * record wholesale (used by the atomicity test, which pre-seeds one).
 *
 * @param {string} exitPath destination path
 * @param {Record<string, unknown>} payload record to persist
 */
export function writeExitRecord(exitPath, payload) {
  mkdirSync(dirname(exitPath), { recursive: true });
  const tempPath = `${exitPath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(payload), { encoding: "utf-8" });

  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tempPath, exitPath);
      return;
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : undefined;
      if (attempt < RENAME_RETRIES && TRANSIENT_RENAME_CODES.has(code)) {
        sleepSync(RENAME_RETRY_MS);
        continue;
      }
      // A failed rename must not leave the temp file behind for `list`/`prune`
      // to trip over; the caller still needs to see the original failure.
      try {
        rmSync(tempPath, { force: true });
      } catch {
        /* the rename error is the one worth reporting */
      }
      throw error;
    }
  }
}

function isoTimestamp() {
  return new Date().toISOString();
}

function messageOf(error) {
  return error && typeof error === "object" && "message" in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);
}

/** `{ retries: n }` when the command needed more than one attempt, else `{}`. */
function retriesField(attempts) {
  return attempts > 1 ? { retries: attempts - 1 } : {};
}

/** The `.exit` payload for a creation that never produced a process. */
function spawnFailureRecord(error, attempts, shellPath) {
  return {
    exit_code: null,
    error: messageOf(error),
    at: isoTimestamp(),
    shell: shellPath,
    ...retriesField(attempts),
  };
}

/**
 * Create the command's process, retrying a transient creation failure a bounded
 * number of times, and report how the command ended through `onOutcome`.
 *
 * SAFETY INVARIANT — retrying here cannot run the command twice. The `'error'`
 * event fires **only when the process was never created at all**; a command
 * that did start reports its failure through `'exit'` (a non-zero exit code),
 * which is not retried. So an attempt that fails with `'error'` is guaranteed
 * to have had no effect, and a fresh attempt cannot duplicate prior work. That
 * is exactly why the retry lives in this detached wrapper and not in
 * `myflow_bg_start`: the tool must return immediately (R1), while a retry has
 * to wait for the outcome.
 *
 * Injectable for tests: `spawnImpl` replaces `node:child_process.spawn`,
 * `wait` replaces the synchronous sleep, and `isRetryable` replaces the retry
 * predicate, so a test can simulate an OS refusal without provoking a real one.
 *
 * @param {{
 *   command: string,
 *   logFd: number,
 *   cwd: string,
 *   onOutcome: (payload: Record<string, unknown>, runnerCode: number) => void,
 *   shellPath?: string,
 *   spawnImpl?: typeof spawn,
 *   wait?: (milliseconds: number) => void,
 *   maxRetries?: number,
 *   retryDelayMs?: number,
 *   isRetryable?: (error: unknown) => boolean,
 * }} options
 * @returns {Promise<{ attempts: number }>}
 */
export function runCommand(options) {
  const {
    command,
    logFd,
    cwd,
    onOutcome,
    shellPath = resolveShellPath(),
    spawnImpl = spawn,
    wait = sleepSync,
    maxRetries = MAX_SPAWN_RETRIES,
    retryDelayMs = SPAWN_RETRY_DELAY_MS,
    isRetryable = isRetryableSpawnError,
  } = options;

  // The command is the final element of the shell's argv — never re-quoted into
  // a command string of our own (that is what `shell: true` does wrong on
  // Windows).
  const shellArgs = shellArgsFor(shellPath, command);

  return new Promise((resolve) => {
    let attempts = 0;

    const report = (payload, runnerCode) => {
      try {
        onOutcome(payload, runnerCode);
      } catch {
        // A reporting failure must not become an uncaught exception in an
        // event handler; the exit code is the only signal left to report.
      }
      resolve({ attempts });
    };

    const attempt = () => {
      attempts += 1;
      let child;
      try {
        // The command writes straight to the log's descriptor. Using "pipe" and
        // forwarding by hand would buffer output and break the "read new bytes
        // while it still runs" guarantee. The shell is started with argv, so
        // the command string reaches it as one element.
        child = spawnImpl(shellPath, shellArgs, { cwd, stdio: ["ignore", logFd, logFd] });
      } catch (error) {
        // A synchronous throw from `spawn` means the process was never created,
        // so it is as safe to retry as an asynchronous `'error'`.
        if (attempts <= maxRetries && isRetryable(error)) {
          wait(retryDelayMs);
          attempt();
          return;
        }
        report(spawnFailureRecord(error, attempts, shellPath), EXIT_SPAWN_FAILED);
        return;
      }

      let settled = false;
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        if (attempts <= maxRetries && isRetryable(error)) {
          wait(retryDelayMs);
          attempt();
          return;
        }
        report(spawnFailureRecord(error, attempts, shellPath), EXIT_SPAWN_FAILED);
      });
      child.once("spawn", () => {
        if (settled) return;
        settled = true;
        // The process was created, so this attempt is final: a later `'error'`
        // is ignored (`settled`), and only `'exit'` reports the outcome.
        child.once("exit", (code, signal) => {
          const exitCode = typeof code === "number" ? code : null;
          report(
            {
              exit_code: exitCode,
              signal: signal ?? null,
              at: isoTimestamp(),
              shell: shellPath,
              ...retriesField(attempts),
            },
            exitCode === null ? EXIT_SPAWN_FAILED : exitCode,
          );
        });
      });
    };

    attempt();
  });
}

/**
 * Run one command and record its outcome. Never throws and never writes to
 * stdio; the process exit code carries the result.
 */
function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch {
    // Without valid arguments there is no exit path to write to, and this
    // script is contractually silent. A non-zero code is the only signal.
    process.exitCode = EXIT_BAD_ARGS;
    return;
  }

  if (!options.exit) {
    process.exitCode = EXIT_BAD_ARGS;
    return;
  }

  const exitPath = options.exit;
  // Resolve the shell once, up front: every `.exit` record (including the
  // no-command and log-open failures below) then says which shell this task
  // would have used. A failure to *create* that shell is retried and reported
  // by `runCommand`, not here.
  const shellPath = resolveShellPath();
  const record = (payload, runnerCode) => {
    try {
      writeExitRecord(exitPath, payload);
    } catch {
      // Nothing better is available: the destination is unwritable. Fall
      // through and let the exit code report the failure.
    }
    process.exitCode = runnerCode;
  };

  if (!options.log || !options.command) {
    record(
      { exit_code: null, error: "no command provided", at: isoTimestamp(), shell: shellPath },
      EXIT_BAD_ARGS,
    );
    return;
  }

  let logFd;
  try {
    mkdirSync(dirname(options.log), { recursive: true });
    // Opened with "w", NOT "a" (see the platform trap below). Each task has a
    // unique id and therefore its own never-reused log, so truncating on open is
    // correct: the file is fresh, and bash writes it progressively through the
    // kernel so a reader still sees appended bytes while the command runs.
    logFd = openSync(options.log, "w");
  } catch (error) {
    record(
      { exit_code: null, error: messageOf(error), at: isoTimestamp(), shell: shellPath },
      EXIT_SPAWN_FAILED,
    );
    return;
  }

  let recorded = false;
  const settle = (payload, runnerCode) => {
    if (recorded) return;
    recorded = true;
    try {
      closeSync(logFd);
    } catch {
      /* already closed or never opened */
    }
    record(payload, runnerCode);
  };

  // `runCommand` owns process creation (through the resolved shell, writing
  // straight to the log's descriptor), the argv it is spawned with, and the
  // bounded retry policy. `settle` owns the log descriptor and the `.exit`
  // record the outcome is written into; the wrapper never sees the child
  // directly.
  runCommand({
    command: options.command,
    cwd: process.cwd(),
    logFd,
    shellPath,
    onOutcome: (payload, runnerCode) => settle(payload, runnerCode),
  });
}

// Run only when executed directly, so the helpers above stay importable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
