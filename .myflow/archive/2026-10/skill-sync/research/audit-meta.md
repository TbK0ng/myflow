# Audit: `myflow-meta` SKILL.md + references/harness-conventions.md vs code

Read-only audit at commit `7eedda5` (sections 1–4, 6, 7 of `implement.md` already
landed). Every falsifiable claim was treated as unverified and checked against
the code it names.

## Verdict per file

### `.pi/skills/myflow-meta/SKILL.md` — **mostly true, 4 stale/wrong statements**

The map is accurate: the Layout tree resolves (only `.myflow/worktree.yaml`,
which the tree itself labels optional, and the per-task `research/` directory are
absent), the hook table matches the eight registered handlers exactly (and is now
guarded by `tests/scaffold.test.ts:272-298`), the `task.py` block lists all 12
subcommands, the tool names/modes/limits match, and the `/myflow-status` and
payload claims hold. The defects are behavioural, not nominative: one claim about
Windows refusal is false for two of the five scripts, and three behavioural
descriptions are incomplete in ways that would mislead an editor.

### `.pi/skills/myflow-meta/references/harness-conventions.md` — **true, 2 imprecise statements**

Strongest file audited. Every load-bearing contract was checked against its
implementation and holds: context key, shell/session bridge, statuses, block
keys, subagent detection, delegation env, bounded writers, dispatch cap + log,
verify-gate scope, plan-approval gate, worktree session ids, project marker,
user-level store, and the whole background-task paragraph (statuses, precedence,
`taskId` shape, cursor names, 60 s self-heal, pid precedence, shell resolution,
`confirmed_by`). The Config Keys table is **complete and correct** — all four
readers (`escape-hatch.ts`, `context-injection.ts`, `task.py`, `channel.py`) were
enumerated and no key read by code is missing. Remaining issues are low-severity
imprecision, not drift.

## Mismatches

| file:line | claim | reality | severity |
| --- | --- | --- | --- |
| SKILL.md:12-16 | "each entry point refuses to start on another platform instead of half-working" | Only the extension (`index.ts:261`), `bg_runner.mjs:857`, `channel.py:772` and `worktree.py:515` refuse. **`task.py` and `get_context.py` have no platform check at all** (`grep os.name` → 0 hits in `task.py`; none in `get_context.py`), so they run on Linux/macOS against a Windows-only harness. The rest of the sentence ("no `process.platform` / `os.name` branch survives") is true — those are refusals, not branches. | wrong |
| SKILL.md:92 | `context` = "Replaces a stale `task-context`, re-adds or strips the breadcrumb" | `index.ts:404-482` also **rebuilds and replaces `session-context`** whenever the active task or status changes (`lastSessionSnapshot`, `index.ts:427-444`, `projectCustomMessage`). `session_start` is not the only sender of `session-context`. | stale |
| SKILL.md:98-99 | "Injected blocks are … `<session-context>`, `<task-context>`, `<workflow-state>`" | The workflow-state message also carries **`<session-overview>`**: `turn-cache.ts:150-152` builds `<workflow-state>…</workflow-state>\n\n<session-overview>…</session-overview>`. The list is one tag short. | stale |
| SKILL.md:102-104 | "`chain` runs them in sequence with `Previous output:` appended" (and "parallel runs up to six") | Two omissions: (a) `chain` **stops at the first failed run** (`subagent.ts:673` `if (isFailedResult(result)) break;`) and returns only the last output; (b) the 6-prompt cap is on the shared `prompts` array (`subagent.ts:251-256` `maxItems: MAX_PARALLEL_PROMPTS`), so a **chain longer than 6 is refused too**, not just parallel. | stale |
| SKILL.md:234 (also :42, :231) | "Verify gate commands → `.myflow/worktree.yaml` (`verify:`)" | This repo has **no `.myflow/worktree.yaml`** (`.myflow/` = `agents archive scripts spec tasks workflow.md .runtime`). `worktree.py:95-99` falls back to `verify: []`, so `index.ts:641-660` runs zero commands and the gate **always passes** here. The Layout line correctly says "optional"; the How-To row and the conventions' "holds … until `verify:` passes" imply a live gate and point at a file a maintainer will not find. | stale |
| harness-conventions.md:28 | "`.myflow/.runtime/` — machine state (sessions, worktree registry, worker logs, channel-adjacent records)" | Sessions (`task.py:73`), `worktrees.json` + `worktree-logs` (`worktree.py:61-63`), `subagent-logs` (`subagent.ts:67`) and `background/` are there. **Channel worker logs are not**: `channel.py:613` writes `<name>/logs/<handle>.log` under `HOME_STORE = ~/.pi/myflow/channels` (`channel.py:72,116-121`) — user-level, which the same file says separately at line 102. | stale |
| harness-conventions.md:96-101 | "`find-project-root.ts` and every script resolve it the same way by walking up … with no project above, the start directory is used as-is" | Scripts do return the start dir (`task.py:54-67`). `findProjectRoot` returns **`null`** (`find-project-root.ts:13-24`); only its callers fall back to `ctx.cwd` (`index.ts:337,367,383,404,641`; `background/start.ts:191`). Same effect, different shape. | stale (minor) |
| harness-conventions.md:184 | "Pi redirects extension console output to stderr in print mode" | Matches the code's own comment (`index.ts:314-323`) but is a claim about Pi's behaviour, not verifiable from this repo. | unverifiable |
| harness-conventions.md:196-202 | "a `.cmd` shim cannot observe a multi-line argv (cmd splits on the newline)" | Historical platform behaviour, no code to check it against. | unverifiable |

### Checked and true (no action)

- **Layout tree (SKILL.md:19-52)**: every path exists — `index.ts`, `subagent.ts`,
  `ask.ts`, `approval.ts`, `background/{index,registry,tools,start,output,list,stop}.ts`,
  `agents.ts`, `status.ts`, the five helpers, `pi-coding-agent.d.ts`,
  `.pi/agents/myflow-{implement,check,research}.md`,
  `.pi/prompts/myflow-{continue,finish-work,parallel}.md`, the eight skills,
  `.myflow/agents/{architect,reviewer}.md`, `workflow.md`, the five scripts,
  `spec/`, `tests/`, `tools/{release-payload.json,release.py,INSTALL.md}`.
  "one Pi extension, five scripts" is exact.
- **Hook table (SKILL.md:87-97)**: 8 rows, 8 `pi.on(...)` calls, same names
  (`index.ts:335,365,382,403,484,548,574,641`). Behaviour rows (recursion guard,
  ask/approval guard, bg guard, write-scope guard, shutdown reports/no-kill/
  idempotent/`hasUI !== false`) all match.
- **`task.py` block (SKILL.md:170-184)**: 12/12 subcommands match argparse
  (`task.py:1151-1219`), including `add-context` and `validate`; the two
  post-manifest gates and `--allow-unapproved`/`started_without_approval` match
  (`task.py:665-700`).
- **`myflow_subagent`** (SKILL.md:101-118): `MAX_PARALLEL_PROMPTS=6`,
  `SUBAGENT_TIMEOUT_MS=900_000` (15 min, 0 disables),
  `SUBAGENT_LOG_DIR=.myflow/.runtime/subagent-logs` resolved against the project
  root, `--approve`/`--append-system-prompt`, `MYFLOW_AGENT_TYPE` /
  `MYFLOW_CONTEXT_ID` / `MYFLOW_WRITES_UNDER` (injected on *any* declaration,
  cleared otherwise, `subagent.ts:443`), model/thinking precedence
  params → agent → caller (`resolveRunConfig`, `subagent.ts:227-242`), parallel
  refusal for a write-capable agent with no `writesUnder` (`subagent.ts:627-637`
  — declared by `myflow-implement`/`myflow-check`: none; `myflow-research`:
  `writesUnder: research`).
- **ask/approval** (SKILL.md:120-126): `myflow_ask_user` = 2-4 options via
  `ctx.ui.select` + `questions.jsonl`; `myflow_request_approval` = `ctx.ui.confirm`
  + `approval.json` only on consent, gate numbers read once through
  `task.py gate-info` (`approval.ts:204-233`).
- **`/myflow-status`** (SKILL.md:129-131, 227): task, phase, approval, git — plus a
  `Next:` line the skill does not mention (harmless omission). Registered as a
  real command with no model call (`index.ts:290-333`, `release.py:93`).
- **Config table (conventions:213-224)**: 8 rows, complete and correct —
  `no-myflow` (`escape-hatch.ts:4`), 32768/65536/131072
  (`context-injection.ts:20-24`), `trusted_context_dirs` `[]` and
  `auto_trust_myflow_symlinks` default-true (`context-injection.ts:295-346,369`,
  `AUTO_TRUST_ENTRIES=["tasks"]`), `worker_guard` 3 / 900
  (`channel.py:76-77,143-174`). `task.py:214-244` mirrors `max_file_bytes`
  only, same default.
- **Payload (SKILL.md:56-80, conventions:7-40)**: `tools/release-payload.json` =
  `dirs: [".pi"]`, `trees: [".myflow/scripts", ".myflow/agents"]`,
  `files: [".myflow/workflow.md"]` + `exclude`; the prose copies match, and both
  `tests/scaffold.test.ts` and `tools/release.py` read it.
- **Background contract (conventions:117-145)**: statuses + precedence
  (`registry.ts:566-643`), `bg-<base36ms>-<4hex>` (`:203-211`),
  `cursors/<contextKey>__<taskId>.json` (`:72,651-652`), `STARTING_TIMEOUT_MS=60_000`
  (`:87`), pid from `.pid` → entry → 0, shell order + no `cmd.exe` + all three
  WSL views skipped (`bg_runner.mjs:254-364`), `unconfirmed` surfaced by `list`
  (`list.ts:183,222`), `taskkill` via argv (`stop.ts:96-99`).
- **How To Change What (SKILL.md:219-239)**: every target exists and is the right
  file, except the two `worktree.yaml` rows noted above.

## 5 highest-risk mismatches, ranked

1. **SKILL.md:12-16 — "each entry point refuses to start on another platform"**
   is false for `task.py` and `get_context.py`. This is the file's load-bearing
   Windows-only guarantee, and it is the one claim a maintainer would act on when
   adding a new script ("the pattern is already there") — so the drift reproduces
   itself. Fix the sentence to name which entry points refuse, or add the guard to
   the two scripts (the `channel.py`/`worktree.py` 3-liner) and keep the claim.
2. **SKILL.md:234 — "Verify gate commands → `.myflow/worktree.yaml`"** points at a
   file that does not exist in the payload repo, while the gate silently no-ops
   (`verify: []`). Highest practical risk: someone believes `myflow-check` is held
   to a verify command and ships unverified work, or edits a file that isn't there
   and sees no effect.
3. **SKILL.md:92 — the `context` row omits `session-context` refresh.** This table
   is the canonical map for changing behaviour; it states that `context` touches
   only `task-context` + breadcrumb. Anyone touching session-context propagation
   is told the wrong function set and may add a second, drifting sender.
4. **SKILL.md:102-104 — chain stops at the first failed run, and the 6-prompt cap
   also applies to chain.** "Runs them in sequence" reads as "runs all of them";
   a maintainer planning a 7-step chain gets a schema rejection they cannot
   explain from the skill.
5. **harness-conventions:28 — "worker logs / channel-adjacent records" placed in
   `.myflow/.runtime/`,** when channel worker logs are user-level under
   `~/.pi/myflow/channels/<key>/<name>/logs/`. Two agents debugging a channel
   worker will look in the project runtime directory and find nothing; the same
   file states the correct location 74 lines later, so the two statements can
   contradict each other during a merge.
