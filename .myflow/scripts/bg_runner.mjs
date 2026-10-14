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

  let child;
  try {
    child = spawn(options.command, {
      shell: true,
      cwd: process.cwd(),
      // The command writes straight to the log's descriptor. Using "pipe" and
      // forwarding by hand would buffer output and break the "read new bytes
      // while it still runs" guarantee.
      stdio: ["ignore", logFd, logFd],
    });
  } catch (error) {
    closeSync(logFd);
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

  // `error` fires when the command (or the shell) could not be started at all.
  child.on("error", (error) => {
    settle({ exit_code: null, error: messageOf(error), at: isoTimestamp() }, EXIT_SPAWN_FAILED);
  });

  child.on("exit", (code, signal) => {
    const exitCode = typeof code === "number" ? code : null;
    settle(
      { exit_code: exitCode, signal: signal ?? null, at: isoTimestamp() },
      exitCode === null ? EXIT_SPAWN_FAILED : exitCode,
    );
  });
}

// Run only when executed directly, so the helpers above stay importable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
