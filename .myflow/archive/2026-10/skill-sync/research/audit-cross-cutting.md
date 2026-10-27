# Cross-cutting audit — the eight shipped skills vs the code

Scope: claims no single-skill audit catches — a number that has two homes, a
contract whose "mirrored in these files" list is short, an env var nobody reads,
a cross-reference to a section that changed. Read-only; sibling audits
(`audit-meta.md`, `audit-brainstorm.md`, `audit-channel.md`,
`audit-process-skills.md`, `audit-spec-skills.md`) cover the per-file detail, and
rows already reported there are marked **dup**.

Method: `read` + `grep` over `.pi/skills/**`, `.pi/extensions/myflow/**`,
`.myflow/scripts/**`, `.myflow/workflow.md`, `.myflow/spec/**`, `.pi/agents/**`,
`tests/**`, `tools/release.py`. **No shell in this session** — `rg`, `git log -S`
and `node --test` were not available, so every "old vs new" question is answered
from the live code and the tests' pinned constants, not from history.

Canonical sources used throughout:

| Thing | Canonical |
| --- | --- |
| Hook set | `pi.on(...)` calls in `.pi/extensions/myflow/index.ts`, compared by `tests/scaffold.test.ts:272-298` |
| `task.py` subcommands | `add_parser(...)` in `.myflow/scripts/task.py:1151-1219`, compared by `tests/skills-hygiene.test.ts:203-229` |
| Task statuses | `task["status"] = …` writers in `task.py:622,734,809`; blocks in `.myflow/workflow.md:111-135`; pinned by `tests/skills-hygiene.test.ts:75-88` |
| Config keys | readers in `escape-hatch.ts:52-84`, `context-injection.ts:87-116,300-345`, `task.py:215-247`, `channel.py:143-174` |
| Defaults | `escape-hatch.ts:4`, `context-injection.ts:20-24`, `subagent.ts:57,64`, `channel.py:76-77`, `registry.ts:75,87` |
| Agent tool allowlists | `tools:` frontmatter in `.pi/agents/*.md` |
| Payload list | `tools/release-payload.json`, read by `release.py` + `tests/scaffold.test.ts` |

## Findings

| # | Claim location | Canonical source | Status |
| --- | --- | --- | --- |
| 1 | `.myflow/spec/harness/index.md:374` "Revisit if: a sub-agent gains `bash`" and `:398` "unreachable for the current agents (no `bash`, no symlink tool)" | `.pi/agents/myflow-check.md:5` and `.pi/agents/myflow-implement.md:5` both declare `tools: read, write, edit, bash, find, grep, ls` | **WRONG.** Two of the three shipped sub-agents already have `bash`. The write-scope gotcha's premise ("unreachable … no `bash`") and the design decision's revisit trigger are both false, and the spec's own Quality Check (`:435`) asks maintainers to revisit a `bash` grant that nobody noticed happening. The `writesUnder` boundary is still real for the *declared* scope, but the "cannot be worked around" reasoning does not survive. |
| 2 | `.pi/skills/myflow-meta/SKILL.md:183` "Statuses: `planning -> in_progress -> done`"; `harness-conventions.md:57-60` "Task statuses: `planning → in_progress → done` … block key equals the status"; `.pi/prompts/myflow-continue.md:37` "`completed` / `done`" | Only three values are ever written: `planning` (`task.py:622`), `in_progress` (`:734`), `completed` (`:809`). `workflow.md` has exactly four blocks and no `done` (`tests/skills-hygiene.test.ts:75-88` pins that set). `status.ts:84` merely *tolerates* `done` | **WRONG (phantom state).** `done` has no producer and no block. An agent that follows the conventions and writes `"status": "done"` gets `turn-cache.ts:119-150` passing `done` through to a missing block → the generic "Refer to workflow.md for current step." breadcrumb (`turn-cache.ts:147`), silently. Three instruction files agree with each other, so a cross-file check cannot see it — only `workflow.md` disagrees. |
| 3 | `context_injection.max_file_bytes` default `32768` in `harness-conventions.md:218` | Two **code** homes: `context-injection.ts:21` (used for truncation) and `task.py:220` (`default = 32768`, hand-copied inside `_context_max_file_bytes`, comment: "Mirrors the extension's parser and default") | **UNGUARDED.** No test compares them (`tests/context-injection.test.ts:104-114` only exercises the TS side). Editing one number makes `task.py validate` warn at a different threshold than the injection truncates at — silent two-sided behavior drift with no failing test. |
| 4 | `.myflow/spec/` is exempt from the only path guard: `tests/skills-hygiene.test.ts:151` (`RUNTIME_PREFIXES` includes `.myflow/spec/`) | The guard's own purpose (`tests/skills-hygiene.test.ts:188`, "only reference paths that exist or are created at runtime") | **MECHANISM GAP.** Any `.myflow/spec/...` path in a skill is unverified, by design (a project may have no tree). That is exactly how the `guides/` miss survived: three skills named it, this repo had no `guides/`, and the path test stayed green. The new `guides/` layer is correct now, but nothing stops the next layer name from going stale the same way. |
| 5 | `.pi/prompts/myflow-continue.md:19` "create one (Phase 1.0)"; `.pi/extensions/myflow/status.ts:169` `"(Phase 1.0)"` | `.myflow/workflow.md:7-31` Phase Index starts at **1.1**; there is no 1.0 step | **WRONG (dead step number).** Two copies agree with each other and disagree with the canonical index — the same "two homes, one stale" shape as #2, at lower stakes (the `no_task` block does say to ask for consent first). |
| 6 | `.pi/skills/myflow-meta/SKILL.md:38-52` Layout tree | `escape-hatch.ts:58`, `context-injection.ts:91,350`, `channel.py:73`, `task.py:221` all read `.myflow/config.yaml`; `SKILL.md:69-71` names it in prose, `harness-conventions.md:213` heads the table with it | **INCOMPLETE.** The tree lists `worktree.yaml` ("optional, project-owned") but never `config.yaml`, while the next paragraph says "both config files are optional". A reader using the tree to find where config lives finds only one of the two. |
| 7 | `.pi/skills/myflow-meta/SKILL.md:55-56` `release.py # … --check / --verify` / `--release bumps, changelogs, builds, commits and tags` | `tools/release.py:770-802`: `--check`, `--out`, `--verify` (and `--verify` *requires* `--out`, `:793`), `--release` + `--yes` + `--dry-run`; push only with `--yes` (`:727-735`) | **INCOMPLETE.** `--out` (the flag that actually builds) is missing from the one-line map, and the push flag that the PRD made load-bearing (`--yes`) is not mentioned. The release implementation itself is accurate. |
| 8 | `myflow-channel/SKILL.md:95-99` "The worker guard caps live workers (… default 3) and stops idle ones (… default 900s)" | `channel.py:566-570` caps live workers **per channel**; `:572-580` refuses a second reviewer **per scope**; `:761` idle stop happens only inside `prune` | **dup** (audit-channel.md:41) for the per-channel cap; **adds**: the two guards are scoped differently (per channel vs per scope) inside one Rules list, and "stops idle ones" reads as automatic when it only runs on `prune`. |
| 9 | `myflow-brainstorm/SKILL.md:542-561` "Phase 2: Prepare for Implementation" / "Phase 3 (Execute)" / "Phase 1 … skipped entirely" | `workflow.md:7-31`: 1 Plan (1.1–1.4), 2 Execute (2.1–2.3), 3 Finish (3.1–3.3); `status.ts:169-175` agrees with workflow.md | **dup** (audit-brainstorm.md:29). Listed here because it is the highest-value *cross-reference* failure: the referenced phases do not exist under those names, and the step the skill says is skipped (1.3/1.4) is exactly what remains. |
| 10 | `myflow-spec-bootstrap/SKILL.md:20` "codebase-memory — the code graph MCP already configured for this harness" | Nothing in the payload configures it; `references/mcp-setup.md:5-8` says "a tool choice, not a requirement … if it is unavailable, fall back" | **dup** (audit-spec-skills.md:40). Flagged here because the two files contradict each other: the reference correctly says optional, the skill asserts it is present. |
| 11 | `channel.py:23-24` module docstring "Store: `~/.myflow/channels/...`" (shipped payload) | `channel.py:72` `HOME_STORE = ~/.pi/myflow/channels`, `:69-71` explicitly forbids `~/.myflow`; `myflow-channel/SKILL.md:88-90` states the same prohibition | **dup** (audit-channel.md:44). The skill is right; the script's own usage block is the stale copy. |
| 12 | `.myflow/spec/harness/index.md:420-425` "No other file states a hook count; `myflow-check` points at the table" | `myflow-meta` hook table is the only count; `harness-conventions.md:147-149` restates the 8 names (no count); `myflow-check/SKILL.md:54` says "the table in `myflow-meta`"; `scaffold.test.ts:272-298` compares both to the registered handlers | **OK.** The one numeric claim that now has a single home and a two-way test. |
| 13 | `myflow-meta/SKILL.md:163` skip keyword default `no-myflow`; `harness-conventions.md:216` | `escape-hatch.ts:4` `DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD = "no-myflow"` | **OK** (two prose copies, no test — see fragile list). |
| 14 | `myflow-meta/SKILL.md:104` "`timeoutMs`, default 15 min, 0 = none"; `workflow.md:93` "default 15 minutes" | `subagent.ts:64` `SUBAGENT_TIMEOUT_MS = 900_000` (`:261,572` interpolate it into the tool description) | **OK** — 900 000 ms = 15 min. Three homes, no test. |
| 15 | `myflow-meta/SKILL.md:102-103` "`parallel` runs up to six prompts" | `subagent.ts:57` `MAX_PARALLEL_PROMPTS = 6` | **OK**; note `chain` shares the same `maxItems` (dup: audit-meta.md:40). |
| 16 | `myflow-meta/SKILL.md:26` "the four `myflow_bg_*` tools"; `harness-conventions.md:117`; `spec/harness/index.md:324` | `background/index.ts:33-38` `BG_TOOL_NAMES` (exactly 4) | **OK**, count unguarded. |
| 17 | `myflow-meta/SKILL.md:10` "one Pi extension, five scripts" | `.myflow/scripts/` = `bg_runner.mjs`, `channel.py`, `get_context.py`, `task.py`, `worktree.py`; `release-payload.json` copies the whole directory | **OK**, unguarded — a sixth script does not falsify the sentence. |
| 18 | `myflow-meta/SKILL.md:166-176` `task.py` command block (12 lines) | 12 `add_parser` calls (`task.py:1151-1219`) | **OK** — complete and correct (section 4 of the plan landed). But `tests/skills-hygiene.test.ts:203-229` only rejects *unknown* names; nothing fails when a **13th** subcommand is added and the block is not updated. |

## Numbers that have two (or more) homes and no test comparing them

Correct today; listed so a future edit knows it is on its own.

| Number | Homes |
| --- | --- |
| `32768` (per-file budget) | `context-injection.ts:21`, `task.py:220` — **the only code-to-code duplicate; see finding 3** |
| `65536` / `131072` | `context-injection.ts:22-23`, `harness-conventions.md:219-220` |
| `3` / `900` (worker guard) | `channel.py:76-77` (constants), `channel.py:30-33` (docstring sample), `harness-conventions.md:221-222`, `myflow-channel/SKILL.md:96-98` |
| `900_000` / 15 min | `subagent.ts:64`, `:261`, `:572`, `myflow-meta:104`, `workflow.md:93` |
| `6` (parallel cap) | `subagent.ts:57` + schema `:253` + `myflow-meta:102` |
| `4` (bg tools) | `background/index.ts:33`, three prose copies |
| `60_000` (starting self-heal) | `registry.ts:87`, `list.ts:259` (tool description), `harness-conventions.md:127-131`, `spec/harness/index.md:267-270` |
| `24h` (prune) | `registry.ts:75`, `list.ts:260`, `spec/harness/index.md:351` |
| `2`/`4` (ask options) | `ask.ts:53-54`, `myflow-meta:120`, `harness-conventions.md:156`, `myflow-brainstorm:10,356` |
| `160` (key truncation) | `index.ts:169`, `task.py:108`, `get_context.py:97` |

## Env vars named in a skill

| Var | Named at | Read / set at | Status |
| --- | --- | --- | --- |
| `MYFLOW_AGENT_TYPE` | `myflow-meta:113`, `harness-conventions.md:62` | set `subagent.ts:37`; read `index.ts:156` | OK |
| `MYFLOW_CONTEXT_ID` | `myflow-meta:113,145,149`, `harness-conventions.md:55`, `spec-writing.md:59` | `index.ts:180,198`; `task.py:124`; `get_context.py:103` | OK |
| `MYFLOW_WRITES_UNDER` | `myflow-meta:113`, `harness-conventions.md:72` | set `subagent.ts:44`; read `index.ts:533` | OK |
| `MYFLOW_SKIP_BREADCRUMB` | `harness-conventions.md:65` | `index.ts:81`; set by `channel.py:623`, `worktree.py:422,449` | OK |
| `MYFLOW_VERIFY_GATE` | `harness-conventions.md:88` | `index.ts:646`; set by `channel.py:629` | OK |
| `MYFLOW_BG_SHELL` | `harness-conventions.md:137,205` | `bg_runner.mjs:314` | OK |
| `PI_SESSION_ID` | `myflow-break-loop:20`, `myflow-update-spec:31`, `myflow-meta:148`, `harness-conventions.md:56`, `spec-writing.md:59` | `task.py:127,513`; `get_context.py:106`; fallback only in `approval.ts:333` | OK — and the "only set for shell tools" caveat in two skills is accurate (`approval.ts:331` says the same). |

No skill names an env var that nothing reads.

## Contracts described as "mirrored across files"

Checked as "is the named set the whole set?" — the failure mode that hid the
hook-count copy.

| Contract | Files the skill names | Files that actually mirror it | Status |
| --- | --- | --- | --- |
| Context key `pi_<sanitized>`, ≤160 | `harness-conventions.md:53-55` → `buildContextKey`, `get_context.py`, `task.py` | exactly those three; the two Python copies each carry their own `_sanitize_key` (`task.py:106-116`, `get_context.py:95-113`) plus the `pi_` prefix | Complete. No cross-language test (`tests/session-context.test.ts:42-46` covers TS only). |
| Task statuses | `harness-conventions.md:57`, `myflow-meta:183` → `task.py` + `workflow.md` | also `turn-cache.ts:96-99` (pass-through), `status.ts:83-85` (phase map), `myflow-continue.md:31-37` | Set incomplete **and** the value set is wrong — see finding 2. |
| Hook set | `myflow-meta:85-97`, `harness-conventions.md:147-149`, `myflow-check:54` (pointer only), `spec/harness/index.md:420-425` | those two lists; guarded by `scaffold.test.ts:272-298` | Complete and closed. |
| Plan-approval gate | `spec/harness/index.md:431-434` → `workflow.md`, `harness-conventions.md`, `myflow-brainstorm`, `myflow-continue.md` | also `ask.ts` / `approval.ts` (writers) and `status.ts:99` (reader) — all read through `task.py gate-info`, no second implementation | Complete. Verified: `approval.ts:205`, `status.ts:99`; `task.py:434-460` is the only answered-count predicate. |
| Background-task states | `harness-conventions.md:117-145`, `spec/harness/index.md:217-221` → 4 reachable states, `.exit` precedence, 60 s heal, pid precedence | `registry.ts:604-643` matches all of it, including the `starting` / `unknown` distinction | Complete and correct. |
| Shell resolution | `harness-conventions.md:137,203-206`, `spec/harness/index.md:327-333`, `background/start.ts:81,164` | `bg_runner.mjs:314-336` (`MYFLOW_BG_SHELL` → `shellPath` → Git bash → PATH) and `:250-260` (skips `system32`/`sysnative`/`syswow64`) | Complete and correct. |
| Bounded-writer / `writesUnder` | `harness-conventions.md:68-78`, `workflow.md:77-89`, `spec/harness/index.md:51-…` | `subagent.ts:167-177,624-637`, `index.ts:524-546`, `agents.ts:33` | Behaviour matches. The **safety premise** in `spec/harness` is false — finding 1. |
| Payload list | `myflow-meta:75-78`, `harness-conventions.md:18-21` | `tools/release-payload.json`, read by `release.py` and `scaffold.test.ts` | Complete. |

## Cross-references

| From | To | Status |
| --- | --- | --- |
| `myflow-brainstorm:212` | `workflow.md` Phase 1.2 (research) | OK — 1.2 exists; `research/<topic>.md` matches |
| `myflow-brainstorm:542-561` | Phases 2 / 3 | **Stale** — dup, finding 9 |
| `myflow-check:26-30` | "the `index.md` for the area you touched", Quality Check section | OK — `.myflow/spec/harness/index.md` has both sections (`:9-35`, `:408-445`) |
| `myflow-check:54` | hook table in `myflow-meta` | OK — pointer, no count restated |
| `myflow-before-dev:28-30` | `spec/index.md`, `guides/index.md`, `<area>/index.md` | OK — all three exist; the read is unconditional again (section 5 landed) |
| `myflow-before-dev:36-39` | "the area index names the load-bearing contracts (context key, statuses, hook set, config keys)" | **Partly wrong** — dup (audit-process-skills.md:60): `harness/index.md` names them in scattered Contracts / Quality-Check lines, not as a list in the Pre-Development Checklist |
| `myflow-update-spec:42-44` | create `index.md` + `<area>/index.md` when the tree is missing | **Incomplete** — dup (audit-spec-skills.md:46): omits `guides/index.md` even though its own Minimal Tree lists it |
| `myflow-break-loop:50-53` | `spec/*/index.md`, `spec/guides/index.md` | OK |
| `myflow-meta:196-215` | `workflow.md` holds "1. Phase Index 2. routing 3. state blocks" | **Incomplete** — `workflow.md` also holds Task Artifacts (`:51-67`), Dispatch Protocol (`:69-102`) and Escape Hatch (`:104-108`); presented as a numbered contents list |
| `myflow-meta:231-234` | `.myflow/worktree.yaml` for verify commands | dup (audit-meta.md:41): this repo has no `worktree.yaml`, so the verify gate is a no-op here |
| `myflow-channel:36-48` | `channel.py` subcommands (`create/send/spawn/wait/messages/workers/prune/kill/rm`, `--all`, `--json`, `--stdin`, `--text-file`, `--timeout`) | OK — every one exists (`channel.py:782-846`); `kill <handle>` and `kill <channel>` both work (`:689`) |
| `myflow-spec-bootstrap:31-36` | the four `references/*.md` files | OK |
| `myflow-brainstorm:29,569-571` | `/skill:myflow-*`, `/myflow-finish-work` | OK — `/skill:name` is Pi's skill form (`docs/skills.md:45-51`); the three prompt templates exist under `.pi/prompts/` |

## The five highest-risk

1. **`spec/harness/index.md:374,398` — "no `bash`" is false for two shipped
   agents** (finding 1). It is a spec the `myflow-before-dev` skill tells an
   implementer to trust, it contradicts `.pi/agents/*.md` frontmatter, and it
   weakens a security-adjacent argument: the `writesUnder` containment is
   described as unreachable-to-bypass when a `bash` tool is exactly the bypass.
2. **`done` is documented as a task status but nothing writes it** (finding 2).
   Three instruction files agree with each other; the code and `workflow.md`
   disagree; the failure is silent (a generic breadcrumb), and
   `tests/skills-hygiene.test.ts:75-88` pins the *blocks*, not the prose.
3. **`32768` has two code homes** (finding 3). The only number that can drift
   *behaviour* rather than prose: `task.py validate` would warn at a different
   threshold than the injection truncates at, with no failing test.
4. **The path guard exempts `.myflow/spec/`** (finding 4). The hooks now have a
   mechanism; the spec layer does not, and this is precisely the hole that
   produced the `guides/` incident in this task.
5. **`Phase 1.0` exists only in two copies of the same stale claim**
   (finding 5). Cheap to fix, and it is the exact pattern — two files agreeing
   with each other while the canonical file disagrees — that a pairwise review
   cannot catch.

## True but fragile (correct today; nothing fails when it stops being true)

- Every prose number in the "two homes" table: they all match the code, and only
  the hook table has a comparator.
- `myflow-meta:166-176`'s 12-command block: the hygiene test rejects unknown
  subcommands but not missing ones, so "every subcommand is listed" regresses
  silently.
- `harness-conventions.md:213-224`'s Config Keys table: complete for `config.yaml`
  and correct, but nothing ties it to the readers. `task.py:215-247` is a second
  reader of `context_injection.max_file_bytes` that the table does not mention
  (same key, second implementation).
- Context key: three implementations of the same charset / prefix / 160-truncation,
  no cross-language test. A change in `sanitizeKey` is caught only on the TS side.
- `myflow-channel:36-40`'s "read-mostly" architect: `.myflow/agents/*.md` carry
  **no** `tools:` frontmatter, so both channel workers inherit the host's default
  toolset. Nothing enforces read-mostly, and the "no such limit" rule rests on it.
- `myflow-meta:75-78`'s "one source" claim for the payload is true and tested;
  what is untested is the *prose inventory* of what the payload contains
  ("five scripts", "four `myflow_bg_*` tools").
- `release.py --release` behaviour matches `myflow-meta:56`'s description, but the
  description omits `--out` and `--yes` (finding 7), so a maintainer reading only
  the skill cannot reconstruct the command surface.
- `myflow-meta:163` + `harness-conventions.md:216` both state the skip keyword
  default; `escape-hatch.ts:4` is the only constant, no test compares the prose.

## What I would add as mechanism (not done here; this file is read-only)

1. One test that asserts the Config Keys table's key set equals the keys the
   readers actually parse (regex the readers, compare to the markdown rows) —
   the same shape as the hook-table assertion, and it would have caught the
   missing `channel.worker_guard` rows in this task.
2. One test that asserts every `add_parser` subcommand appears in
   `myflow-meta`'s command block (completeness, not just validity).
3. One cross-language test for `_sanitize_key` vs `sanitizeKey` (the `160`-char
   clamp plus one non-ASCII input), and one for the
   `context_injection.max_file_bytes` default on both sides.
4. Extend the path guard one step: for `.myflow/spec/<layer>/index.md`
   references, assert the layer name is one the spec tree's `index.md` lists —
   that keeps a project without a tree working while catching a dropped layer.
