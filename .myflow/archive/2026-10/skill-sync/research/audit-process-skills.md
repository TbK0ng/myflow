# Audit: `myflow-check`, `myflow-before-dev`, `myflow-break-loop`

Scope: the three process skills in `.pi/skills/`, checked against the repo as it
stands today (`.myflow/spec/` restored with a `guides/` layer, hook table +
config keys landed in `7eedda5`).

Method note: this audit was done statically (read/grep only — no bash tool in
this research scope). Every path, subcommand and file:line below was resolved
against the working tree. "Command runs green" claims are therefore *not*
measured; they are inferred from `package.json` and the scripts' own argument
parsers.

## Verdicts

| Skill | Verdict |
| --- | --- |
| `myflow-check` | **Sound in content, wrong in one command and one branch.** Its only executable gate (`npm run check`, L38) is the exact command this repo's harness spec forbids inside a sub-agent, and the check agent *is* a sub-agent. Its harness-conventions pointer is unreachable in this repo (it lives in the `NO_SPEC` branch only). Two checklist items name guarantees no test provides. |
| `myflow-before-dev` | **Correct end to end.** The spec-tree flow resolves completely after the `guides/` restoration. One descriptive claim about the area checklist's contents is false for the single area this repo owns. |
| `myflow-break-loop` | **Correct and usable.** Every knowledge-capture target exists. Two of its prevention mechanisms are not available in this repo (no linter; and its `npm run check` step inherits the sub-agent env hazard). |

## `myflow-check` — verified true

| file:line | claim | reality |
| --- | --- | --- |
| `SKILL.md:23` | `cat .myflow/spec/index.md` | exists; `NO_SPEC` fallback correct |
| `SKILL.md:26-28` | area index has a **Quality Check** section | `.myflow/spec/harness/index.md:408` (`## Quality Check`), `spec/index.md:14-15` promises it |
| `SKILL.md:38` | `npm run check` = typecheck then `node --test "tests/*.test.ts"` | `package.json:8-11` — exact |
| `SKILL.md:45` | `python3 .myflow/scripts/get_context.py` | `get_context.py:245` (`main`), accepts `--json`/`-j`, rejects others |
| `SKILL.md:46` | `task.py current --source` | `task.py:1172-1177` arg exists |
| `SKILL.md:54` | hooks: "the table in `myflow-meta`" | table exists, 8 rows, `.pi/skills/myflow-meta/SKILL.md:85-100`; guarded by `tests/scaffold.test.ts:288`. No hook **count** stated — correct (prd item 3 holds) |
| `SKILL.md:60` | `workflow.md` blocks parse, open/close match | 4 matched pairs, `.myflow/workflow.md:111-135`; guarded by `tests/skills-hygiene.test.ts:75-84` |
| `SKILL.md:88` | reuse: look in `.pi/extensions/myflow/` | directory exists |

## `myflow-check` — findings

| file:line | claim | reality | severity |
| --- | --- | --- | --- |
| `SKILL.md:38` | "Run `npm run check`" with no env guard | `.myflow/spec/harness/index.md:19-25` and its Quality Check (L412-414) say to run it **from the main session**, or with `MYFLOW_AGENT_TYPE` / `MYFLOW_CONTEXT_ID` / `MYFLOW_SKIP_BREADCRUMB` / `MYFLOW_WRITES_UNDER` cleared, because a leaked agent type makes the extension see itself as a sub-agent and unrelated tests fail. `myflow-check` is a sub-agent that `subagent.ts` *launches with those vars set* — so its own primary gate is run in the state the spec calls unsafe. | high |
| `SKILL.md:30-33` | "When the change is to the myflow harness itself, apply … `harness-conventions.md`" | this sentence is inside the `**NO_SPEC**` branch. This repo *has* a spec tree, so the line can never fire. The harness-copy rules are only reachable by following L26 into `.myflow/spec/harness/index.md` — and the command block (L23) cats only the root index, never an area index. | medium |
| `SKILL.md:61` | "`.myflow/spec/` and `workflow.md` describe only things that exist" | nothing enforces it. `tests/skills-hygiene.test.ts:157` puts `.myflow/spec/` in `RUNTIME_PREFIXES`, so **every** `.myflow/spec/...` path in an instruction file is exempt from the existence check. This is precisely why three skills could keep naming a `guides/` directory that had been dropped. | medium |
| `SKILL.md:59` | "Context-key derivation matches between extension, `get_context.py`, and `task.py`" | true on the live path (`MYFLOW_CONTEXT_ID` → sanitized, else `pi_<sanitized PID session>`, `.pi/extensions/myflow/index.ts:177-196`, `task.py:115-132`, `get_context.py:97-113`). The degenerate branches differ: TS falls back to `hashValue(...)` (`index.ts:174-179`), both Python copies return `None` for an override that sanitizes to empty. Applied literally, this box can never be ticked. | low |
| `SKILL.md:26-28` | the guided read stops at the area index | `.myflow/spec/guides/index.md` (the layer `before-dev` now reads unconditionally) is never read by the check step, although guides are where "is this claim still true" questions live. Not a false statement, a missing read. | low |
| `SKILL.md:35` | "Tests need no network, model, or installed dependencies" | true of `node --test` on `.ts` files, but the same Step runs `tsc -p tsconfig.json` first (`package.json:10`), which needs `node_modules`. Read as "the check needs nothing installed", it is wrong. | low |

## `myflow-before-dev` — verified end to end

| file:line | claim | reality |
| --- | --- | --- |
| `SKILL.md:14` | `cat .myflow/spec/index.md` | exists |
| `SKILL.md:17-22` | `NO_SPEC` branch: say so, point at `myflow-spec-bootstrap` / `myflow-update-spec`, fall back to the generic checklist | branch text is correct as written; it is simply **not this repo's path** (a tree exists), so it is inert here — no wrong claim |
| `SKILL.md:27-28` | `cat .myflow/spec/index.md` then `cat .myflow/spec/guides/index.md` | both resolve; `guides/index.md` exists and lists one guide, `.myflow/spec/guides/doc-drift-thinking-guide.md`, which also exists. Read is unconditional — no "optional" wording survives (grep for `optional|if present` over the skill: none) |
| `SKILL.md:29` | `<area>/index.md`, example `harness/` | `.myflow/spec/harness/index.md` exists and is the only area listed by `spec/index.md:10-12` |
| `SKILL.md:59` | "Mandatory whenever a spec tree exists" | consistent with the repo's state and with `harness/index.md`'s own checklist |
| `SKILL.md:61` | specs authoritative over memory; fix whichever is wrong | the rule this whole task is an instance of |

## `myflow-before-dev` — finding

| file:line | claim | reality | severity |
| --- | --- | --- | --- |
| `SKILL.md:37-38` | "It names the load-bearing contracts (**context key, statuses, hook set, config keys**) that must stay consistent" | the one area this repo has does not: `.myflow/spec/harness/index.md:14-38` (Pre-Development Checklist) names the Windows guard, contract-vs-behavior, `writesUnder`, the approval gate / plan hash, and the `myflow_bg_*` tools. Context key, hook set and config keys live in the **Contracts** sections and in the **Quality Check** (L408-430). An implementer who "works the checklist" and stops never sees the hook-table or Config-Keys rules — the two rules `7eedda5` just added. | medium |

## `myflow-break-loop` — verified true

| file:line | claim | reality |
| --- | --- | --- |
| `SKILL.md:20` | example bug: "assuming `PI_SESSION_ID` exists outside shell tools" | accurate for this repo: the shell bridge is `task.py:120-131` / `get_context.py:101-111`; the extension derives from `ctx.sessionManager` instead (`index.ts:177-196`) |
| `SKILL.md:22` | "New status added, `workflow.md` block missing" | real: four statuses in `.myflow/workflow.md:111-135`, non-empty, tested |
| `SKILL.md:50` | capture into `.myflow/spec/*/index.md` | `.myflow/spec/harness/index.md` exists; glob is satisfiable |
| `SKILL.md:52` | "add the question to `.myflow/spec/guides/index.md`" | file exists; no "optional / project has none" clause left |
| `SKILL.md:53` | add or strengthen a regression test | `tests/*.test.ts`, run by `npm run check` |
| `SKILL.md:88` | commit fix + spec + test together | compatible with `.myflow/workflow.md:128-134` (commit at 3.2, then `/myflow-finish-work`) — no contradiction |

## `myflow-break-loop` — findings

| file:line | claim | reality | severity |
| --- | --- | --- | --- |
| `SKILL.md:87` | "Run `npm run check` and confirm it passes" | same env hazard as `myflow-check:38`: correct from the main session, potentially false-red from a sub-agent. Lower risk than `myflow-check` because this skill is main-session, but the skill states no condition. | low |
| `SKILL.md:35` | prevention type "Compile/lint — strict types, no escape hatch" | this repo has **no linter** (`package.json:6-10`: only `test`, `typecheck`, `check`). The available mechanism is `tsc --strict` (`tsconfig.json:6`) plus the "no `as any`" hygiene item — which is currently honoured (`as any` appears only in the ambient `pi-coding-agent.d.ts:34-50`). The table offers a mechanism the repo cannot supply. | low |

## Adjacent repo-state facts that change how these skills land

Not defects in the three files, but they decide whether the instructions bite:

1. **`.myflow/worktree.yaml` does not exist** (`.myflow/` contains `runtime/ agents/ archive/ scripts/ spec/ tasks/ workflow.md`). `worktree.py verify` therefore prints `no verify commands configured` and exits 0 (`worktree.py:469-498`), so the extension's `agent_before_settle` gate (`.pi/extensions/myflow/index.ts:239-256, 636-668`) never holds a check sub-agent here. The consequence: `myflow-check`'s own `npm run check` step is the *only* verification gate in this repo — which is why the env hazard above matters more than it looks.
2. **CI cannot see spec-tree drift.** `tests/skills-hygiene.test.ts:157` exempts `.myflow/spec/` wholesale, and no test asserts that the files `spec/index.md` lists exist. The `guides/` restoration is now correct but still unguarded: delete `.myflow/spec/guides/index.md` tomorrow and the whole suite stays green while `before-dev:28` tells the agent to `cat` a missing file. The narrow fix — assert that every `guides|harness` layout entry in the spec index resolves — would also cover prd user story 6 for this class.

## Top 5 by risk

1. **`myflow-check/SKILL.md:38` — `npm run check` run from inside a sub-agent, with no env clearing.** The skill's primary gate is executed in the state `.myflow/spec/harness/index.md:19-25` explicitly warns causes unrelated failures. Failure modes: an agent "fixes" phantom failures, or learns to disregard the suite. Fix: point at the cleared-env invocation the spec already spells out.
2. **`tests/skills-hygiene.test.ts:157` — `.myflow/spec/` paths are exempt from the existence check.** The `guides/` fix has no mechanism behind it and neither does any other spec-tree read in these three skills (user story 6 unmet for this class). Cheapest fix: resolve layout entries named in `.myflow/spec/index.md` and any `.myflow/spec/<dir>/index.md` an instruction file names.
3. **`myflow-check/SKILL.md:30-33` — the harness-conventions rule is parked in the `NO_SPEC` branch, and no command opens the area index.** In this repo (tree present) the contract-copy rules are reachable only by inference from L26. Fix: one line under the "spec tree present" bullet — cat the area index, and for harness work apply `harness-conventions.md`.
4. **`myflow-before-dev/SKILL.md:37-38` — the promised checklist contents do not match the harness area's checklist,** so hook-set and config-key rules (the ones this task just centralised) are the easiest to skip. Fix: drop the four-item list, or say the checklist *and* the surrounding Contracts/Quality Check sections name them.
5. **No verify configuration in this repo** (`.myflow/worktree.yaml` absent → `worktree.py verify` exits 0). The advertised check-agent settle gate is a no-op, so nothing backstops item 1. Fix is config, not prose: add a `.myflow/worktree.yaml` with `verify:` running the cleared-env `npm run check`.

Low-severity leftovers, worth one line each if the file is touched anyway:
`myflow-check:59` (context-key boxes differ in the degenerate branch),
`myflow-check:35` (the check needs `node_modules` for `tsc`),
`myflow-check:26-28` (never reads `guides/`),
`myflow-break-loop:35` (no linter exists),
`myflow-break-loop:87` (same env condition as item 1).
