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
 *   node bg_runner.mjs --id <taskId> --log <logPath> --exit <exitPath> \
 *     --pid <pidPath> --cwd <dir> -- <command...>
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
 *     for Windows bash -> `bash` on `PATH` (skipping the three Windows
 *     `System32` / `Sysnative` / `SysWOW64` views, which hold WSL's launcher).
 *     The resolved absolute path is
 *     recorded in `<exitPath>` under `shell`, on both the success and failure
 *     records, so "which shell ran this?" is always answerable after the fact.
 *   - There is deliberately **no `cmd.exe` fallback**, and a resolved `cmd.exe`
 *     is refused. Driving `cmd.exe` would mean handing it
 *     `/d /s /c "<command> >> <log> 2>&1"` as one argv element, and Node
 *     re-quotes that element for the Windows command line: a quote inside the
 *     command becomes `\"`, which `cmd.exe` does not accept. Every quoted
 *     command would fail on that path, so offering it as a usable shell would
 *     be a lie. When nothing resolves — or the resolved path is `cmd.exe` —
 *     the wrapper records `exit_code: null` plus an `error` naming the search
 *     order, and **runs no command at all**.
 *   - The shell itself performs the redirection into the log (`>>`, append), so
 *     the command's stdout and stderr are written by the kernel and nothing is
 *     buffered in this process (`design.md` §2). Appended bytes are visible to
 *     another process that reads the file while the command is still running.
 *   - The child is started with `stdio: "ignore"` and **no descriptor of any
 *     kind is handed to it**. Passing an inherited descriptor as a standard
 *     handle makes libuv restrict the child's inherited handles, and on Windows
 *     that `CreateProcess` path can fail with `ERROR_NO_SYSTEM_RESOURCES` (232).
 *     Letting the shell open the log removes that path entirely. The log path is
 *     quoted for the shell that receives it (`quoteForBash`), so a path
 *     containing spaces or quotes cannot break out of the redirection.
 *   - On Windows the shell is also started **detached**, so libuv asks for
 *     `DETACHED_PROCESS` and the shell is created **without a console**. This
 *     wrapper is console-less, so without the flag Windows would build a fresh
 *     console — and a console window — for every background task; that is both
 *     a visible flash and an allocation out of the interactive desktop heap,
 *     whose exhaustion is reported as `ERROR_NO_SYSTEM_RESOURCES` (232).
 *     Whether that heap is what refuses these spawns is **unmeasured**, so the
 *     flag is not claimed as the fix. Off Windows the shell deliberately stays
 *     in this process's group, because that group is what `myflow_bg_stop`
 *     signals (`design.md` §4.4).
 *     The flag does not change how the command runs or how its result is
 *     observed: this process still waits for the child's `exit` event.
 *   - Creating that shell is retried on a *bounded* backoff when the OS
 *     refuses transiently (see the retry policy below).
 *   - When the command exits this script writes `<exitPath>`:
 *       `{"exit_code":N,"signal":S,"at":"<ISO>","shell":"<path>"}` on a
 *       normal exit,
 *       `{"exit_code":null,"error":"...","at":"<ISO>","shell":"<path>"}`
 *       when it could not be spawned, and the same shape with `shell: null`
 *       when no usable POSIX shell resolved (a refusal that runs nothing).
 *       The write is atomic (temp file + rename)
 *       so a concurrent reader never observes a half-written record
 *       (`design.md` §3.2).
 *   - Before the shell, the log directory or the command is touched, this
 *     script writes `--pid` (`<pidPath>`) as `{"pid":N,"at":"<ISO>"}`, also
 *     atomically. That file is the *handshake*: it is the only proof that this
 *     wrapper really started, written by the process whose pid it names. The
 *     tool writes the registry entry (`status: "starting"`) before spawning, so
 *     the sequence is "entry on disk -> spawn -> `.pid` on disk -> command". A
 *     command therefore never runs unless a pid was recorded first, which is
 *     what closes the orphan window (`design.md` ADR-8). The `.pid` file also
 *     exists on a refusal (no usable shell): it records that the wrapper ran,
 *     not that the command did.
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
  existsSync,
  mkdirSync,
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
 * Bounded backoff for a *transient* process-creation failure.
 *
 * Windows occasionally refuses to create a process with ERROR_NO_SYSTEM_RESOURCES
 * (232) while the machine is momentarily short of some resource (paged pool,
 * desktop heap, handles). The refusal is a *snapshot* of a transient condition:
 * the same command usually starts if it is attempted again a moment later, so
 * retrying turns "the task never started" into "the task started a little late".
 *
 * The schedule is deliberately finite. A retry that waited forever would turn
 * "the command genuinely cannot start" into a hung task, which is worse than a
 * clear failure, so the budget is capped: at most `MAX_SPAWN_RETRIES` retries
 * (8 attempts in total) with a growing delay, `250ms * 1.5^n` capped at `2s`,
 * for a total wait well under `SPAWN_RETRY_TOTAL_BUDGET_MS`.
 *
 * Only *transient/unknown* failures are retried. A missing program (`ENOENT`),
 * a bad argument (`EINVAL`), a permission problem (`EACCES` / `EPERM`), or one
 * of Node's own `ERR_*` codes will fail identically no matter how many times it
 * is attempted, so retrying those just wastes time and hides the real error.
 */
const MAX_SPAWN_RETRIES = 7;
const SPAWN_RETRY_BASE_DELAY_MS = 250;
const SPAWN_RETRY_BACKOFF_FACTOR = 1.5;
const SPAWN_RETRY_MAX_DELAY_MS = 2000;

/**
 * The delay before retrying after attempt number `attempts` (1-based) failed.
 *
 * Exported so a test can assert the whole backoff schedule — and its total —
 * without actually sleeping through it. The caller passes the number of
 * attempts *already made*, so the first retry gets the base delay.
 *
 * @param {number} attempts how many attempts have been made so far (>= 1)
 * @returns {number} milliseconds to wait before the next attempt
 */
export function spawnRetryDelayMs(attempts) {
  const index = Math.max(0, attempts - 1);
  const grown = SPAWN_RETRY_BASE_DELAY_MS * SPAWN_RETRY_BACKOFF_FACTOR ** index;
  return Math.min(grown, SPAWN_RETRY_MAX_DELAY_MS);
}

/**
 * The documented ceiling for the whole retry schedule. The default schedule
 * sums to about 7.2s (250 + 375 + 562.5 + 843.75 + 1265.625 + 1898.4375 +
 * 2000); this constant is the number a caller can rely on and a test asserts
 * against, with headroom for the attempts themselves.
 */
export const SPAWN_RETRY_TOTAL_BUDGET_MS = 10_000;
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
 * Node's own `ERR_*` codes (`ERR_INVALID_ARG_TYPE`, `ERR_INVALID_CALLBACK`, …)
 * are never retried either: they mean *the caller wrote the call wrong*, so no
 * amount of waiting changes the outcome. Retrying them would only delay the
 * real error by the whole ~7.2s budget. They are matched by prefix rather than
 * listed in `NON_RETRYABLE_SPAWN_CODES`, because `ERR_*` is a namespace, not a
 * handful of fixed members.
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
  if (code.startsWith("ERR_")) return false;
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
    //
    // `Sysnative` and `SysWOW64` are the other two spellings of that same
    // directory: `Sysnative` is the alias a 32-bit process uses to reach the
    // 64-bit System32, and `SysWOW64` is the 32-bit view of System32 seen by a
    // 64-bit process. All three resolve to the same `bash.exe` WSL entry point,
    // so all three are skipped. This machine has no WSL installed and does not
    // intend to: naming them here is a *refusal*, never a way to support WSL.
    if (platform === "win32") {
      const base = basename(directory).toLowerCase();
      if (base === "system32" || base === "sysnative" || base === "syswow64") continue;
    }
    for (const candidate of candidates) {
      const full = join(directory, candidate);
      if (exists(full)) return full;
    }
  }
  return null;
}

/**
 * Resolve the absolute path of the shell that runs the command, or `null` when
 * no POSIX shell can be found.
 *
 * Order (fixed; this is the only implementation of it):
 *   1. `MYFLOW_BG_SHELL` — explicit override, used verbatim.
 *   2. `~/.pi/agent/settings.json` `shellPath` — the user's own choice.
 *   3. The Git for Windows bash, at its standard install location.
 *   4. `bash` on `PATH`.
 *
 * There is **no** `cmd.exe` / `/bin/sh` last resort. Falling back to `cmd.exe`
 * would only look like a working shell: Node re-quotes the command into
 * `cmd.exe /d /s /c "..."` and escapes inner quotes as `\"`, which `cmd.exe`
 * rejects, so every quoted command would fail there (see the file header).
 * A missing shell is therefore a *refusal*, decided by `shellRejectionReason`
 * and recorded by the caller — never a silent change of shell.
 *
 * This stays a pure resolver: it never throws and never exits. `null` means
 * "nothing usable found".
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
 * @returns {string | null}
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

  return null;
}

/**
 * The search order, spelled out for the refusal message. A reader of `.exit`
 * only sees that file, so it has to say *where* to fix the configuration
 * rather than merely that something is missing.
 */
export const SHELL_SEARCH_ORDER =
  "MYFLOW_BG_SHELL, then ~/.pi/agent/settings.json's shellPath, then the Git for Windows bash, then bash on PATH";

/**
 * Why a resolved shell cannot be used, or `null` when it can.
 *
 * Exactly two refusals, and neither one falls back to a different shell:
 *
 *   - nothing resolved (`null` or blank) — there is no POSIX shell to run;
 *   - the resolved path is `cmd.exe` — unsupported on purpose. Node re-quotes
 *     argv for the Windows command line and escapes an inner quote as `\"`,
 *     which `cmd.exe` does not accept, so any quoted command would fail there.
 *     This can happen when the user points `MYFLOW_BG_SHELL` (or the settings
 *     `shellPath`) at `cmd.exe`; it is reported as such instead of being
 *     driven as if it were a POSIX shell.
 *
 * @param {string | null | undefined} shellPath
 * @returns {string | null}
 */
export function shellRejectionReason(shellPath) {
  const value = typeof shellPath === "string" ? shellPath.trim() : "";
  if (!value) return "no POSIX shell could be resolved";
  const base = basename(value).toLowerCase();
  if (base === "cmd" || base === "cmd.exe") {
    return `${value} is cmd.exe, which is not supported as the background-command shell`;
  }
  return null;
}

/**
 * Quote a path for POSIX shell use with single quotes.
 *
 * A single-quoted string is literal in every POSIX shell, so spaces, `&`, `>`
 * and `$` cannot escape it. The one character it cannot contain is a single
 * quote itself, which is emitted as `'\''` (close quote, escaped quote, reopen
 * quote). The log path is project-relative, but a test temp directory — or a
 * user's checkout — can contain spaces or quotes, so this must not assume
 * otherwise.
 */
export function quoteForBash(value) {
  return `'${value.split("'").join("'\\''")}'`;
}

/**
 * The argv the resolved shell needs to run one command and append its output
 * to `logPath`.
 *
 * There is exactly one shape, because the shell is always a POSIX shell:
 * `shellRejectionReason` refuses anything else (including `cmd.exe`) before
 * this is ever called. The command is always a **single** element: that is the
 * whole point of spawning the shell ourselves. bash receives `-lc` (a login
 * shell, matching how the user's Git Bash runs) with an `exec` redirection, so
 * every command the shell runs inherits the log.
 *
 * The redirection is performed by the **shell**, not by this process handing it
 * an open descriptor. A descriptor passed through `stdio` is a *standard
 * handle*, and libuv restricts the child's inherited handles when one is set;
 * on Windows that `CreateProcess` path can fail with
 * `ERROR_NO_SYSTEM_RESOURCES`. `>>` also gives append semantics without an
 * `O_APPEND` descriptor.
 */
export function shellArgsFor(command, logPath) {
  return ["-lc", `exec >> ${quoteForBash(logPath)} 2>&1; ${command}`];
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
 * writing the record nowhere. `--pid` and `--cwd` additionally treat a missing
 * value as a hard error (see below), because both change what the wrapper
 * promises: one is the handshake that proves the task started, the other is the
 * directory the command runs in.
 *
 * @param {string[]} argv arguments after the executable, i.e. `process.argv.slice(2)`
 * @returns {{ id: string | null, log: string | null, exit: string | null, pid: string | null, cwd: string | null, command: string | null }}
 */
export function parseArgs(argv) {
  const options = { id: null, log: null, exit: null, pid: null, cwd: null, command: null };
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
    if (arg === "--pid") {
      // Same rule as `--cwd`: a missing value is a hard error. Silently
      // skipping the pid handshake would reopen the orphan window while every
      // other part of the start still looked successful.
      const value = argv[index + 1];
      if (typeof value !== "string" || value === "") {
        throw new Error("--pid requires a value");
      }
      options.pid = value;
      index += 1;
      continue;
    }
    if (arg === "--cwd") {
      // A missing value is a hard error, unlike the other flags: silently
      // falling back to this process's cwd would run the command in a
      // directory nobody asked for, and the confirmation the user saw named a
      // different one. `--cwd` is therefore never "absent by accident".
      const value = argv[index + 1];
      if (typeof value !== "string" || value === "") {
        throw new Error("--cwd requires a value");
      }
      options.cwd = value;
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
 * Write a JSON record atomically: fill a sibling temp file, then rename it over
 * the destination. A reader therefore sees either the previous file or the
 * complete new one, never a partial write. Renaming also replaces an existing
 * record wholesale (used by the atomicity test, which pre-seeds one).
 *
 * Both `<exitPath>` and `<pidPath>` go through this: they are the two files this
 * wrapper writes, and both are read concurrently by the tools.
 *
 * @param {string} destination destination path
 * @param {Record<string, unknown>} payload record to persist
 */
export function writeJsonAtomic(destination, payload) {
  mkdirSync(dirname(destination), { recursive: true });
  const tempPath = `${destination}.tmp`;
  writeFileSync(tempPath, JSON.stringify(payload), { encoding: "utf-8" });

  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tempPath, destination);
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

/**
 * Write the `.exit` record atomically. Kept as its own export because it is the
 * documented file contract (`design.md` §3.2) and the name tests refer to.
 *
 * @param {string} exitPath destination path
 * @param {Record<string, unknown>} payload record to persist
 */
export function writeExitRecord(exitPath, payload) {
  writeJsonAtomic(exitPath, payload);
}

/**
 * Write the pid handshake atomically: `{"pid": <this process>, "at": <ISO>}`.
 *
 * Called before anything else can run a command (see the header contract). The
 * payload names *this* process on purpose: the file is written by the wrapper
 * for the wrapper, so a reader can tell "the wrapper is alive" from "the tool
 * believes a pid was handed back by `spawn`".
 *
 * @param {string} pidPath destination path (`--pid`)
 */
export function writePidRecord(pidPath) {
  writeJsonAtomic(pidPath, { pid: process.pid, at: isoTimestamp() });
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

/** The error code (`ENOENT`, `EAGAIN`, `UNKNOWN`, ...) if the error carries one. */
function errorCodeOf(error) {
  return error && typeof error === "object" && "code" in error
    ? String(/** @type {{ code: unknown }} */ (error).code)
    : "";
}

/**
 * A readable description of a creation failure: the OS message plus the raw
 * `code` and numeric `errno` when they are not already part of it. Windows
 * errors with no POSIX mapping surface as `spawn UNKNOWN`; the numeric errno is
 * then the only place the original NTSTATUS/Win32 value is preserved, so it has
 * to travel with the message.
 */
function describeSpawnError(error) {
  const message = messageOf(error);
  const code = errorCodeOf(error);
  const errno =
    error && typeof error === "object" && "errno" in error
      ? /** @type {{ errno: unknown }} */ (error).errno
      : undefined;
  const extras = [];
  if (code && !message.includes(code)) extras.push(`code ${code}`);
  if (typeof errno === "number" && !message.includes(String(errno))) extras.push(`errno ${errno}`);
  return extras.length > 0 ? `${message} (${extras.join(", ")})` : message;
}

/**
 * The `.exit` payload for a creation that never produced a process.
 *
 * When the creation was retried and every attempt was refused, the message has
 * to say plainly that the *environment* refused to create a process — not that
 * the command was mistyped — and it has to carry the raw code/errno, so a
 * reader is not left debugging a command that was never the problem. A
 * single-attempt deterministic failure (`ENOENT` and friends) keeps the raw OS
 * message, which already names the cause.
 */
function spawnFailureRecord(error, attempts, shellPath) {
  const detail = describeSpawnError(error);
  const errorText =
    attempts > 1
      ? [
          `the operating system refused to create the process after ${attempts} attempts: ${detail}.`,
          "This is an environment condition — the OS was momentarily out of a resource",
          "such as memory, handles, or desktop heap — not a mistyped command.",
          "Retry later; to confirm the command itself is fine, run it in the foreground.",
        ].join(" ")
      : detail;
  return {
    exit_code: null,
    error: errorText,
    at: isoTimestamp(),
    shell: shellPath,
    ...retriesField(attempts),
  };
}

/**
 * The `.exit` payload for "there is no usable POSIX shell, so nothing ran".
 *
 * Two facts have to be unambiguous in this file, because the reader of `.exit`
 * sees nothing else: *the command was not executed*, and *where the shell is
 * looked for* (so the configuration can be fixed). Neither is a spawn failure —
 * no process was ever requested.
 *
 * @param {string | null | undefined} shellPath the rejected candidate, if any
 * @param {string} reason from `shellRejectionReason`
 */
export function shellUnavailableRecord(shellPath, reason) {
  const rejected = typeof shellPath === "string" && shellPath.trim() ? shellPath : null;
  return {
    exit_code: null,
    error: [
      `Cannot run the background command: ${reason}.`,
      `Looked for a shell in this order: ${SHELL_SEARCH_ORDER}.`,
      "No command was executed. Set MYFLOW_BG_SHELL (or the shellPath in",
      "~/.pi/agent/settings.json) to a bash executable, then start the task again.",
    ].join(" "),
    at: isoTimestamp(),
    shell: rejected,
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
 * A `shellPath` that is `null` or `cmd.exe` is a *refusal*: `onOutcome` gets
 * the `shellUnavailableRecord` payload and no process is created at all. That
 * guard is repeated here (not only in `runWrapper`) so a direct caller cannot
 * drive the wrapper into the unsupported `cmd.exe` path either.
 *
 * @param {{
 *   command: string,
 *   logPath: string,
 *   cwd: string,
 *   onOutcome: (payload: Record<string, unknown>, runnerCode: number) => void,
 *   shellPath?: string | null,
 *   spawnImpl?: typeof spawn,
 *   wait?: (milliseconds: number) => void,
 *   maxRetries?: number,
 *   isRetryable?: (error: unknown) => boolean,
 * }} options
 * @returns {Promise<{ attempts: number }>}
 */
export function runCommand(options) {
  const {
    command,
    logPath,
    cwd,
    onOutcome,
    shellPath = resolveShellPath(),
    spawnImpl = spawn,
    wait = sleepSync,
    maxRetries = MAX_SPAWN_RETRIES,
    isRetryable = isRetryableSpawnError,
  } = options;

  const rejection = shellRejectionReason(shellPath);
  if (rejection) {
    try {
      onOutcome(shellUnavailableRecord(shellPath, rejection), EXIT_SPAWN_FAILED);
    } catch {
      /* a reporting failure must not throw out of here */
    }
    return Promise.resolve({ attempts: 0 });
  }

  // The command is the final element of the shell's argv — never re-quoted into
  // a command string of our own (that is what `shell: true` does wrong on
  // Windows). There is one argv shape because the shell is always POSIX here.
  const shellArgs = shellArgsFor(command, logPath);

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
        // The shell opens the log itself (`>>`) and the command inherits that
        // redirection. Using "pipe" and forwarding by hand would buffer output
        // and break the "read new bytes while it still runs" guarantee; handing
        // a descriptor over as a standard handle would push libuv onto the
        // Windows handle-list path that can fail with ERROR_NO_SYSTEM_RESOURCES.
        //
        // On Windows the shell is started detached, i.e. with
        // `DETACHED_PROCESS`, so it gets no console. This wrapper has none
        // either, so without the flag Windows would build a fresh console --
        // and a console window -- for every background task: a visible flash,
        // and an allocation from the interactive desktop heap, the resource
        // whose exhaustion is reported as ERROR_NO_SYSTEM_RESOURCES (232).
        // Whether that heap is what refuses these spawns is unmeasured, so this
        // is not claimed as the fix.
        //
        // Windows only. `detached` also moves the child into a new process
        // group, and off Windows `myflow_bg_stop` signals this process's group
        // (`process.kill(-pid)`, design.md §4.4); a detached shell would sit
        // outside that group and survive the stop.
        const detachShell = process.platform === "win32";
        child = spawnImpl(shellPath, shellArgs, { cwd, stdio: "ignore", detached: detachShell });
      } catch (error) {
        // A synchronous throw from `spawn` means the process was never created,
        // so it is as safe to retry as an asynchronous `'error'`.
        if (attempts <= maxRetries && isRetryable(error)) {
          wait(spawnRetryDelayMs(attempts));
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
          wait(spawnRetryDelayMs(attempts));
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
 *
 * `argv` and `resolveShell` are injectable so a test can drive the
 * "no usable shell" refusal in a *real* child process: the Git for Windows bash
 * exists on every supported Windows machine, so that branch is otherwise
 * unreachable there without editing the machine's configuration. Production
 * calls this with no arguments.
 */
export function runWrapper(injected = {}) {
  let options;
  try {
    options = parseArgs(injected.argv ?? process.argv.slice(2));
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

  // The pid handshake (ADR-8). This is deliberately the *first* thing written:
  // before the shell is resolved, before the log directory exists, and long
  // before a command can run. The tool has already written the registry entry
  // (`status: "starting"`, `pid: 0`), so once this file exists the task is
  // addressable by pid and can never be an invisible orphan. A failure to write
  // it is fatal *for the command*: running anyway would restore exactly the
  // orphan window this handshake exists to close.
  if (options.pid) {
    try {
      writePidRecord(options.pid);
    } catch (error) {
      try {
        writeExitRecord(options.exit, {
          exit_code: null,
          error:
            `Cannot record the pid handshake at ${options.pid}: ${messageOf(error)}. ` +
            "No command was executed.",
          at: isoTimestamp(),
          shell: null,
        });
      } catch {
        /* the destination is unwritable; the exit code is the only signal left */
      }
      process.exitCode = EXIT_SPAWN_FAILED;
      return;
    }
  }

  const exitPath = options.exit;
  // Resolve the shell once, up front: every `.exit` record (including the
  // no-command and log-directory failures below) then says which shell this
  // task would have used. A failure to *create* a resolved shell is retried and
  // reported by `runCommand`; a failure to *resolve* one is refused below.
  const resolveShell = injected.resolveShell ?? resolveShellPath;
  const shellPath = resolveShell();
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

  // No usable POSIX shell is a refusal, not a silent change of shell: it is
  // checked *before* the log directory and the process, so a refused task
  // leaves no log file at all — "nothing ran" is observable, not a claim.
  const rejection = shellRejectionReason(shellPath);
  if (rejection) {
    record(shellUnavailableRecord(shellPath, rejection), EXIT_SPAWN_FAILED);
    return;
  }

  // The shell creates the log file with its own `>>` redirection, so this
  // process hands no descriptor to the child at all. The directory still has to
  // exist: `>>` creates the file, not the folders leading to it.
  try {
    mkdirSync(dirname(options.log), { recursive: true });
  } catch (error) {
    record(
      { exit_code: null, error: messageOf(error), at: isoTimestamp(), shell: shellPath },
      EXIT_SPAWN_FAILED,
    );
    return;
  }

  // `runCommand` owns process creation (through the resolved shell, which
  // performs the redirection into the log), the argv it is spawned with, and
  // the bounded retry policy. `record` writes the `.exit` outcome; the wrapper
  // never sees the child directly.
  //
  // `--cwd` is where the *command* runs; this wrapper's own cwd stays whatever
  // the caller picked (the project root), so `--log`/`--exit` paths and this
  // script's own location are unaffected by it. `myflow_bg_start` resolves and
  // validates the directory before spawning; the wrapper only forwards it.
  runCommand({
    command: options.command,
    cwd: options.cwd ?? process.cwd(),
    logPath: options.log,
    shellPath,
    onOutcome: (payload, runnerCode) => record(payload, runnerCode),
  });
}

// Run only when executed directly, so the helpers above stay importable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWrapper();
}
