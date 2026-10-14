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
 *   - `<command...>` is reassembled into one string and handed to the platform
 *     shell verbatim (`shell: true`), so pipes, `&&`, and redirection work.
 *   - The command's stdout and stderr are pointed at the log file's descriptor
 *     directly, so the kernel writes them; nothing is buffered in this process
 *     (`design.md` §2). Appended bytes are visible to another process that
 *     reads the file while the command is still running.
 *   - When the command exits this script writes `<exitPath>`:
 *       `{"exit_code":N,"signal":S,"at":"<ISO>"}` on a normal exit,
 *       `{"exit_code":null,"error":"...","at":"<ISO>"}` when it could not be
 *       spawned. The write is atomic (temp file + rename) so a concurrent
 *       reader never observes a half-written record (`design.md` §3.2).
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
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
function spawnFailureRecord(error, attempts) {
  return {
    exit_code: null,
    error: messageOf(error),
    at: isoTimestamp(),
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
    spawnImpl = spawn,
    wait = sleepSync,
    maxRetries = MAX_SPAWN_RETRIES,
    retryDelayMs = SPAWN_RETRY_DELAY_MS,
    isRetryable = isRetryableSpawnError,
  } = options;

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
        // while it still runs" guarantee.
        child = spawnImpl(command, { shell: true, cwd, stdio: ["ignore", logFd, logFd] });
      } catch (error) {
        // A synchronous throw from `spawn` means the process was never created,
        // so it is as safe to retry as an asynchronous `'error'`.
        if (attempts <= maxRetries && isRetryable(error)) {
          wait(retryDelayMs);
          attempt();
          return;
        }
        report(spawnFailureRecord(error, attempts), EXIT_SPAWN_FAILED);
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
        report(spawnFailureRecord(error, attempts), EXIT_SPAWN_FAILED);
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
      { exit_code: null, error: "no command provided", at: isoTimestamp() },
      EXIT_BAD_ARGS,
    );
    return;
  }

  let logFd;
  try {
    mkdirSync(dirname(options.log), { recursive: true });
    logFd = openSync(options.log, "a");
  } catch (error) {
    record({ exit_code: null, error: messageOf(error), at: isoTimestamp() }, EXIT_SPAWN_FAILED);
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

  // `runCommand` owns process creation (through the platform shell, writing
  // straight to the log's descriptor) and the bounded retry policy. `settle`
  // owns the log descriptor and the `.exit` record the outcome is written into;
  // the wrapper never sees the child directly.
  runCommand({
    command: options.command,
    cwd: process.cwd(),
    logFd,
    onOutcome: (payload, runnerCode) => settle(payload, runnerCode),
  });
}

// Run only when executed directly, so the helpers above stay importable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
