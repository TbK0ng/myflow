# Audit: `.pi/skills/myflow-channel/SKILL.md` vs `.myflow/scripts/channel.py` and `.myflow/agents/`

Scope: read-only audit. Sources: `.pi/skills/myflow-channel/SKILL.md`,
`.myflow/scripts/channel.py`, `.myflow/agents/{architect,reviewer}.md`,
`tests/channel.test.ts` (evidence that the behaviour is pinned).

## Verdict

**Mostly accurate on the command surface, wrong on two behavioural promises.**

Every subcommand and every flag the skill spells out exists in the parser, with
matching semantics; the worker-guard defaults (`3`, `900`), the config keys, the
`--task` → `Active task:` line, the one-reviewer-per-tree rule, the delegated
work order, `MYFLOW_SKIP_BREADCRUMB`, and the `~/.pi/myflow/channels` store all
match the code and (in most cases) its tests. What the script does **not** do is
interrupt a running worker: `--kind interrupt` is only an event kind, nothing
reads it, nothing signals the process — the real stop is `kill`. And the
"Spawn an implement or check worker" block omits `create review`, so it fails as
printed. Two smaller prose defects: the guard sentence reads global while the
count is per-channel, and `prune`'s idle sweep skips workers that never posted.

Verified-clean (no action): `list --all` (`channel.py:786-788`), `workers
--json` (`831-832`), `messages --json` (`803-807`), `create` (`782-783`), `send
--as/--to/--kind/--text/--stdin/--text-file` (`790-800`), `spawn
--agent/--handle/--prompt/--task` + `--scope` via `with_scope` (`779`,
`821-829`), `wait --from/--kind/--timeout` (`811-816`), `kill` (`835-836`), `rm
--force` (`840-842`), `prune` (`845`); defaults `DEFAULT_MAX_LIVE_WORKERS = 3` /
`DEFAULT_IDLE_TIMEOUT = 900` (`79-80`) read as `channel.worker_guard.
max_live_workers` / `.idle_timeout` (`143-176`); `Active task:` (`590`); reviewer
lock (`575-585`, test `tests/channel.test.ts:433-452`); work order text
(`594-615`); `MYFLOW_SKIP_BREADCRUMB=1` (`623`, test `channel.test.ts:167-182`);
store root (`74-77`, tests `channel.test.ts:480-520`); `architect.md` §Rules and
`reviewer.md` §Fix Or Report match the skill's descriptions.

## Findings

| file:line | claim | reality | severity |
|---|---|---|---|
| `SKILL.md:3`, `:13`, `:56-61` | "interrupt a stalled worker"; "when an in-flight worker needs an interrupt"; "### Interrupt and redirect" with `send --kind interrupt` | The only occurrence of `interrupt` in code is the default-kind expression `args.kind or ("interrupt" if args.tag == "interrupt" else "message")` (`channel.py:484`). No command polls the log, no code path signals a process, `wait` returns only on `kind == wanted_kind` (`526-549`). A worker is a one-shot `pi -p` process (`616-621`) that reads the inbox once at start via its prompt. `--kind interrupt` is advisory text the worker may never read; the actual stop is `kill`/`rm --force`. Promise without mechanism. | **high** |
| `SKILL.md:45-51` | Worked example: `spawn review --agent reviewer --handle checker --task …` then `wait review …` | `cmd_spawn` calls `_require_channel` (`552-553`, `430-436`); an unknown channel exits 1 with `error: unknown channel 'review' in scope 'project'`. The block never runs `create review`, so the payload's primary review workflow fails verbatim. (The brainstorm block does `create brainstorm` at `:34`, so the omission is inconsistent, not stylistic.) | **high** |
| `SKILL.md:96-98` | "The worker guard caps live workers (`max_live_workers`, default 3)" | Cap is **per channel**, not per scope/tree: `live = [w for w in workers if w.get("channel") == args.name]` then `len(live) >= guard[...]` (`563-570`). Three workers in three channels pass a limit of 3. Reads as a global cap. | medium |
| `SKILL.md:67` | `prune  # drop dead workers, stop idle ones` | Dead-record drop is real (`752-777`, test `channel.test.ts:226-247`), but the idle kill is gated on `last is not None` (`757-761`; `last_event_time` returns `None` when the handle never spoke, `376-388`). A worker that never posted is never idle-killed, only recorded as idle by omission. Sentence overstates. | medium |
| `SKILL.md:86-90` | "`--scope global` … a global channel is invisible from project listings" | True for `list` (`450-465`, test `channel.test.ts:59-75`) but the skill stops there: `workers`, `kill`, `prune`, `rm`, `messages`, `send`, `spawn`, `wait` all take `--scope` default `project` (`779`), so a global worker/channel is also invisible to `workers` and unreachable by `kill`/`rm`/`prune` without `--scope global`. `kill`/`rm` then report `killed: 0` / `unknown channel`, which reads as "already gone". | medium |
| `channel.py:20-24` (script docstring, shipped payload) | — "Store: `~/.myflow/channels/<project>/<channel>/events.jsonl`" | Contradicts `HOME_STORE = Path.home() / ".pi" / "myflow" / "channels"` (`74-77`, test `channel.test.ts:480-520`) **and** contradicts `SKILL.md:88-90`, which explicitly warns against `~/.myflow` and states why. The skill is right; the shipped script's own usage block is stale. An agent that reads the docstring instead of the skill resumes the exact mistake the skill guards against. | medium |
| `SKILL.md:77-78` | "One reviewer per tree" | Enforced over **all workers in the scope**, any channel: `reviewers = [w for w in workers if w.get("agent") == "reviewer"]`, where `workers` is the whole scope list (`582-589`). Stricter than documented — a second reviewer in a *different* channel is also refused. Harmless direction, but the error text and the doc disagree on granularity. | low |
| `SKILL.md:81-83` | "A user `--tag` is an opaque label" | Not fully: `--tag interrupt` is read as a kind synonym (`484`), so the tag changes routing-visible `kind`. Everything else about tags is opaque (`_format_event` `497-501`). | low |
| `SKILL.md:81` | "Completion signal is `--kind done`, a system event the runtime understands" | `done` gets no special handling; it is the *default value* of `wait --kind` (`814`) and a string comparison (`534`). Nothing prevents a worker from sending `done` twice or a non-worker from sending it. "System event" is prose, not behaviour. | low |
| `SKILL.md:26-27` | Peers "keep their own session" | Worker is launched `pi -p --approve --append-system-prompt <definition> <prompt>` (`616-621`) — one-shot print mode, no resume/attach and no `--session` flag on `spawn`. True only as "its own process". | low |
| `SKILL.md` (omission) | — | `spawn` for `reviewer` also sets `MYFLOW_VERIFY_GATE=1` (`627-629`, test `channel.test.ts:167`), referenced by `.myflow/workflow.md:91`; and `spawn` accepts `--model` / `--dry-run` (`827-828`) and `kill` accepts `--all` (`837`). Not required by the skill's purpose, but the dry-run flag would let a reader validate a plan without launching. | info |

Not findings: `kill <handle>` (`:68`) and `kill <channel>` (`:94`) both work —
`match = args.all or handle == args.name or worker.channel == args.name`
(`686-690`). `rm` refusing while a worker holds the log is correctly described
(`700-712`, tests `channel.test.ts:249-353`). `--stdin`/`--text-file`
precedence matches (`471-483`).

## Five highest-risk items

1. **`interrupt` is documented, not implemented** (`SKILL.md:3,13,56-61` vs
   `channel.py:484`). The skill's own description sells "interrupt a stalled
   worker"; a user redirecting a runaway worker gets a log line and a worker that
   keeps running. Fix by making the section say what exists (`send` for
   redirect-if-it-reads, `kill` to actually stop) or by giving `wait`/`prune` a
   real interrupt path — but not by leaving the promise in the description.
2. **The review workflow snippet fails as printed** (`SKILL.md:48`). `create
   review` is missing; `spawn` requires the channel. First-command failure in the
   most likely path a new user takes.
3. **Guard scope is misdescribed** (`SKILL.md:96-98` vs `channel.py:563-570`): a
   reader who spawns 4 workers across 3 channels under `max_live_workers: 3`
   expects a refusal and gets none, then wonders why the guard "does not work".
4. **Global scope has no inspection/stop story** (`SKILL.md:86-90`). Global
   workers are the ones most likely to leak (shared bucket, no project listing);
   the cleanup block (`:65-71`) has no `--scope global` and reports success while
   doing nothing.
5. **The script's own docstring teaches the wrong store path**
   (`channel.py:20-24`). It directly contradicts the skill and `HOME_STORE`, and
   both files ship. Whichever an agent reads first decides where it looks.

## Recommendations

- Rewrite "Interrupt and redirect" around what works: `send --kind interrupt`
  is a *request* the worker may read; `kill <handle>` is the stop. Drop
  "interrupt a stalled worker" from the front-matter description if `kill` is
  meant.
- Add `create review` to the review block (or note "once per channel").
- Say "caps live workers **per channel**" and qualify the idle sweep
  ("workers that have posted"). Code-level `if last is not None` should get a
  `shortcut:`-style note if the never-posted case is acceptable.
- One line in the scope rule: "for a global channel, pass `--scope global` on
  every command — `workers`, `kill`, `prune` included."
- Fix `channel.py:20-24` to `~/.pi/myflow/channels/<project-key>/<channel>/`
  (the docstring also omits `--model`, `--dry-run`, `kill --all`, and
  `messages --since/--limit/--raw`).
- Add a note that a reviewer worker also carries `MYFLOW_VERIFY_GATE=1`, so the
  peer review story matches `workflow.md:91`.

_Not checked:_ whether a real `pi -p` worker actually calls `messages` mid-run
(platform behaviour, not visible in this repo); `channel.py` behaviour on
non-Windows hosts beyond the `main()` guard; `.myflow/agents/` definitions are
read only for the two claims the skill makes about them.
