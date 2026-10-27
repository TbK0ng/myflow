# Audit: `.pi/skills/myflow-brainstorm/SKILL.md` vs the current harness

Scope: the whole skill (570 lines), checked against `task.py` argparse, the
approval/ask mechanisms, the jsonl manifests, `myflow_subagent`, and
`workflow.md`. Read-only audit; the only artefact is this file.

## Verdict

**Drifts.** The tool-mechanics prose is mostly right (ask-user, approval,
`writesUnder`/parallel), but everything the skill says about *task creation* and
about *where the plan lives* is wrong, and its phase map is from a workflow that
no longer exists. The skill is the entry point of Phase 1, so its two worst
defects are load-bearing: the `create` invocations cannot be copied and run, and
a plan that lives only in the chat is neither hashed by the approval gate nor
injected into `myflow-implement`.

What holds up (do not touch): `questions.jsonl` / `approval.json` semantics,
plan-hash staleness on editing `prd.md`/`design.md`/`implement.md`,
`myflow_request_approval` + `task.py approve` fallback, `writesUnder: research`
and the parallel-rejection rule, `workflow.md` Phase 1.2 as the research
contract, `/skill:myflow-brainstorm` as an invocation.

## Findings

| file:line | claim | reality | severity |
| --- | --- | --- | --- |
| `SKILL.md:73` | `TASK_DIR=$(python3 ./.myflow/scripts/task.py create "…" --slug <auto>)` | Two defects. (a) `--slug <auto>` is a shell redirect in bash (`<auto` reads stdin from a file named `auto`), not a placeholder; the flag is `--slug`, optional, and defaults to the slugified title (`task.py:1154`, `task.py:609`). (b) `cmd_create` prints `created: .myflow/tasks/<slug>` (`task.py:638`), so `$TASK_DIR` becomes the string `created: .myflow/tasks/…`, which every later `add-context`/`start`/`subtask` command rejects. | **high** |
| `SKILL.md:76-77` | "Use a slug without a date prefix. `task.py create` adds the `MM-DD-` directory prefix automatically." | There is no date prefix anywhere in `task.py`: `_task_dir_for(slug) = TASKS_DIR / slug` (`task.py:342-343`), `create` uses it verbatim (`task.py:610`). The only date in the tree is the archive month (`task.py:803`). On disk: `.myflow/tasks/skill-sync`, `.myflow/tasks/explain-myflow-directory` — no prefix. The instruction "slug without a date prefix" still makes sense; the reason given for it does not. | **high** |
| `SKILL.md:542-561` | "After brainstorm … Phase 2: Prepare for Implementation … Phase 3 (Execute) Implement → Check → Complete"; "Phase 1 of the Task Workflow is skipped entirely" | `workflow.md:15-27` has three phases: **1 Plan** (1.1 brainstorm, 1.2 research, 1.3 configure context, 1.4 activate), **2 Execute** (2.1 implement, 2.2 check, 2.3 rollback), **3 Finish** (3.1 spec update, 3.2 commit, 3.3 finish). Brainstorm *is* 1.1, not something before Phase 1; "Complete" is now three named steps. Following the skill's map, an agent skips 1.3 and 3.x. | **high** |
| `SKILL.md:553` | "Configure code-spec context (jsonl files)" — no command given | 1.3 is `[required · once]` and has a hard gate: `create` seeds `implement.jsonl`/`check.jsonl` empty (`task.py:195-205`), and `start` refuses while either has no curated entry, printing the exact `add-context` fix (`task.py:664-689`). The skill — the only skill that drives planning — never names `task.py add-context`, `validate`, or `--allow-empty-context`. | **high** |
| `SKILL.md:420-460`, `SKILL.md:490-521` | Step 8 confirms the plan as a chat summary; the PRD target structure has `prd.md` only, with "Implementation Plan (small PRs)" as prose | Complex work is expected to end Phase 1 with `design.md` **and** `implement.md` files (`workflow.md:17`, `workflow.md:119`). Those are exactly what the gate hashes (`PLAN_FILES`, `task.py:83`) and what the extension injects into a sub-agent in order `prd.md → design.md → implement.md → info.md` (`context-injection.ts:445-449`). A plan that exists only in the chat means: the approval binds only the PRD template, `myflow-implement` receives no execution plan, and `implement.md` — the file the task-context header of this very task comes from — never exists. | **high** |
| `SKILL.md:208` | "spawn a `myflow-research` sub-agent … don't do WebFetch / WebSearch / `gh api` inline" | The dispatched agent cannot do that job: `.pi/agents/myflow-research.md` allows `tools: read, write, find, grep, ls` and describes itself as "Investigates the codebase". No bash, no web fetch, no search. Web/`gh` research delegated to it comes back as memory, not evidence — worse than the inline calls the skill forbids. | **high** |
| `SKILL.md:30-35` | Step 0 "ALWAYS … If none exists, create one immediately" | The injected `[workflow-state:no_task]` block in `workflow.md:113-116` requires classifying the turn and asking for task-creation consent *before* creating any task. The skill's unconditional create overrides the state block that the harness injects every turn. | medium-high |
| `SKILL.md:73-80` | Creating a task makes it the working task | `cmd_create` only sets the session pointer when none exists (`task.py:626-632`, "creating a second task … must not hijack the session"). With another task active, the new task never becomes current: `myflow_ask_user` records rows into the *previous* task's `questions.jsonl` (`ask.ts` `resolveActiveTaskDir`), and the new task's own `start` then fails the "no answered question" backstop. Nothing in the skill checks `task.py current`. | medium |
| `SKILL.md:479-483` | `CHILD1=$(… create …)`, `CHILD2=$(…)`, then `add-subtask "$TASK_DIR" "$CHILD_DIR"` | `$CHILD_DIR` is never assigned (only `CHILD1`/`CHILD2`), so the link command is empty. Both child captures also carry the `created: ` prefix from finding 1. `add-subtask` itself takes `parent_dir child_dir` (`task.py:1182-1185`) — the shape is right, the variables are not. | medium |
| `SKILL.md:10`, `SKILL.md:462-465` | "The tool records each exchange in `questions.jsonl`, and the approval gate later refuses a plan the user was never asked about" | One row per **call**, including `via: "none"` rows where no answer was delivered (`ask.ts:250-260`, `persistVia`). The gate requires ≥1 row with `via == "ui-select"` and a non-empty answer, ever — it is not bound to a plan revision and is satisfied by any earlier answer, including one from before the plan was rewritten (`task.py:434-460`, `task.py:725-732`). | low-medium |
| `SKILL.md:215` | "`myflow-research` declares `writesUnder: research` and may run in parallel" | Correct and current (`subagent.ts:167-177`, `subagent.ts:627-637`, `myflow-research.md` frontmatter). Omitted: parallel is capped at 6 prompts (`MAX_PARALLEL_PROMPTS`), and `chain` mode exists. | ok (additive gap) |
| `SKILL.md:462-472` | `approval.json` written only on agreement; stale after editing `prd.md`/`design.md`/`implement.md`; no-UI → human runs `task.py approve <slug>` | Matches `approval.ts` (`APPROVED_BY`, `gate-info` as sole read path), `PLAN_FILES` (`task.py:83`), `_approval_report` statuses, and `approval_hint` (`task.py:522-529`). `approve` also refuses a non-tty stdin — consistent with "have the human run it". | ok |
| `SKILL.md:12` | no-UI → returns an instruction; list options in prose and end the turn | Matches `noUiInstruction` in `ask.ts` (`via: "no-ui"`, `hasUI=false`). | ok |
| `SKILL.md:212` | research contract is `workflow.md` Phase 1.2 | Correct: `workflow.md:18` is `[optional · repeatable]` → `research/<topic>.md`; agent contract in `.pi/agents/myflow-research.md`. | ok |
| `SKILL.md:164-199`, `SKILL.md:9`, `SKILL.md:530-536` | question gate / one-question-at-a-time / anti-patterns | Pure reasoning, no mechanism claim. Out of scope per the task. | n/a |
| missing | `task.py current`, `list`, `archive`, `finish`, `plan-hash`, `gate-info`, `validate`, `--allow-unapproved` | All real subcommands/flags (`task.py:1148-1219`) that a planning session needs (`gate-info`/`plan-hash` to explain a refused gate, `--allow-unapproved` as the recorded bypass). Not wrong, just absent while the skill spends a page on `<auto>`. | low |

## The five highest-risk mismatches

1. **`SKILL.md:73` — the create command does not run.** `--slug <auto>` is a
   bash stdin redirect and `$(...)` captures the `created: ` log prefix, so both
   the slug and `$TASK_DIR` are garbage. This is the first command in the skill
   and every later path in it is derived from `$TASK_DIR`.
2. **`SKILL.md:76` — a false rule about the path shape.** "create adds the
   `MM-DD-` prefix" has never been true (`_task_dir_for(slug)` is `TASKS_DIR /
   slug`); a model that believes it will predict the wrong path, and the
   surviving sentence reads as a justification for guidance that no longer needs
   one.
3. **`SKILL.md:542-561` — the phase map is from the retired 3-phase workflow.**
   It puts brainstorm outside Phase 1, hides 1.3 (the required, gated jsonl
   curation) and collapses today's 3.1/3.2/3.3 into "Complete". This is the
   section the model reads last and acts on first.
4. **Step 8 / PRD structure — the plan never becomes files.** The gate hashes
   `prd.md`+`design.md`+`implement.md` and the extension injects them into
   sub-agents, but the skill's output is a chat summary plus a `prd.md`; complex
   work therefore ends Phase 1 with no `implement.md`, so approval covers less
   than the plan and `myflow-implement` reads no plan.
5. **`SKILL.md:208` — the mandated research path cannot research.** The
   `myflow-research` agent has `read, write, find, grep, ls` and a
   codebase-only brief, so the skill's "do not WebFetch/WebSearch/`gh api`
   inline, delegate instead" produces confident answers with no tool behind
   them. Either the claim narrows to codebase research or the delegated prompt
   must not ask for external evidence.

Runner-up (worth fixing in the same pass): Step 0 creates a task unconditionally
while the injected `no_task` state block requires consent first, and it never
checks `task.py current` — so a second task is created without becoming the one
that `myflow_ask_user` writes its audit rows into.

## Method

- `task.py`: read the module docstring, `_task_dir_for`, `_resolve_task_dir`,
  `_seed_context_manifests`, `_curated_entry_count`, `_answered_question_count`,
  `_approval_report`, `approval_hint`, `cmd_create`, `cmd_start`, `cmd_add_context`,
  `cmd_plan_hash`, `cmd_gate_info`, `cmd_approve`, and the whole `build_parser`.
- Tools: `ask.ts` (option bounds, `via` mapping, row shape, no-UI text,
  sub-agent guard), `approval.ts` (`gate-info`-only reads, no-UI text),
  `subagent.ts` (`mode` enum, `MAX_PARALLEL_PROMPTS`, `hasWriteScope` rejection),
  `agents.ts` (`writesUnder` parsing), `context-injection.ts` (artifact order and
  jsonl selection).
- Agents: `.pi/agents/myflow-research.md`, `.pi/agents/myflow-implement.md`
  (no artifact references of its own — it relies on injected context).
- Workflow: `.myflow/workflow.md` Phase Index, Task Artifacts, Dispatch Protocol,
  `[workflow-state:no_task]` and `[workflow-state:planning]`.
- Tests: `tests/skills-hygiene.test.ts` and `tests/workflow-invariant.test.ts`
  guard frontmatter, referenced `references/` files, and workflow.md's
  `[required · once]` steps — nothing asserts skill *prose*, which is why these
  five survived.
- On-disk evidence for the path claim: `.myflow/tasks/{skill-sync,
  explain-myflow-directory}` (no date prefix).
