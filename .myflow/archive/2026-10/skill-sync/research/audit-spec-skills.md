# Audit: `myflow-update-spec` + `myflow-spec-bootstrap`

Read-only audit of four files against the spec tree that exists now
(`.myflow/spec/index.md`, `harness/index.md`, `guides/index.md`,
`guides/doc-drift-thinking-guide.md`) and against the code.

Files audited:

- `.pi/skills/myflow-update-spec/SKILL.md`
- `.pi/skills/myflow-spec-bootstrap/SKILL.md`
- `.pi/skills/myflow-spec-bootstrap/references/spec-writing.md`
- `.pi/skills/myflow-spec-bootstrap/references/spec-task-planning.md`
- `.pi/skills/myflow-spec-bootstrap/references/mcp-setup.md`
- `.pi/skills/myflow-spec-bootstrap/references/repository-analysis.md`

## Verdict per file

| File | Verdict |
| --- | --- |
| `myflow-update-spec/SKILL.md` | **Mostly true, one real contradiction.** Minimal Tree (`:53-68`) matches the tree that exists, including `guides/index.md`. Breaks in two places: the create-the-tree step (`:42-45`) omits `guides/`, and `Related` (`:127-129`) tells the reader to keep harness lessons *out* of the project spec while this repo's project spec **is** the harness spec. |
| `myflow-spec-bootstrap/SKILL.md` | **One false load-bearing claim.** `guides/index.md` is now correctly mandatory (`:59-60`); `:18` still asserts the code graph "MCP [is] already configured for this harness", which is false for the payload and for the tool list of every sub-agent this harness dispatches. |
| `references/spec-writing.md` | **Good structure rule, wrong worked example.** `:23-26` correctly makes `guides/index.md` mandatory. The flagship example (`:53-68`) teaches one wrong path (`src/turn-cache.ts`) and one wrong contract ("only start/finish/archive write the pointer" — `create` writes it too). No requirement for the Pre-Development Checklist / Quality Check wrapper that `spec/index.md` promises. |
| `references/spec-task-planning.md` | **Sound planning model, template stale on `guides/`.** `:19` ("exactly one area `harness/`") matches reality. Its PRD template (`:44-59`) omits `guides/index.md` and never checks it, contradicting `spec-writing.md:23` and `SKILL.md:59`. |
| `references/mcp-setup.md` | **Stale tooling claims.** Config *locations* are right (`~/.pi/agent/mcp.json`, project `.pi/mcp.json` — `docs/mcp.md:32`; `~/.pi/agent/extensions/` — `docs/extensions.md:17`). The *wiring* is wrong: the bare tool names every reference instructs come from a spawned-CLI extension, not from the MCP server, and "move it to another machine" only adds the MCP entry, which yields `mcp__codebase-memory-mcp__*` names. Nothing on this machine matches the doc. |
| `references/repository-analysis.md` | **Consistent with the rest, inherits the backend problem.** Tool names are internally consistent with `mcp-setup.md` and the evidence discipline is good, but it tells an agent to call bare names it cannot see. |

Upstream check: `tests/skills-hygiene.test.ts` cannot catch any of the findings
below — it validates `.pi/`/`.myflow/` tokens (`payloadTokens`, and it lists
`.pi/mcp.json` as `RUNTIME_FILES`), skips `~/...` machine paths, and `src/`
prefixes are invisible to it.

## Findings

Severity: **high** = an agent following the text cannot do the thing or learns
a false contract; **medium** = an internally contradicting or invalid claim;
**low** = wording/detail.

| file:line | claim | reality | severity |
| --- | --- | --- | --- |
| `myflow-spec-bootstrap/SKILL.md:18` | "codebase-memory — the code graph **MCP already configured for this harness**" | Not configured anywhere in the payload: `grep -ri codebase-memory` over the repo hits only the skills, `.gitignore:10`, and archive. `~/.pi/agent/mcp.json` on this machine has only `exa` + `bilibili`; `~/.pi/agent/extensions/` has only `rtk.ts`; `~/.pi/agent/skills/` has no `codebase-memory`. The dispatched agents' allowlists (`.pi/agents/myflow-research.md:5` = `read, write, find, grep, ls`; `myflow-implement.md:5`) contain no MCP tools at all, so the skill's own reader cannot reach the backend. | high |
| `myflow-spec-bootstrap/references/spec-writing.md:61` | "Only `task.py start` / `finish` / `archive` write the pointer." | `.myflow/scripts/task.py:635-643` — `create` writes `session["current_task"]` and calls `_write_session` when no pointer exists ("Planning needs a pointer too"). Four writers, not three. Taught as the model contract entry. | high |
| `myflow-spec-bootstrap/references/mcp-setup.md:41-45` | "Moving It To Another Machine": add the `mcpServers` entry → "Verify with `pi mcp`" | Following this yields namespaced `mcp__codebase-memory-mcp__<tool>` (`docs/mcp.md:77`), while `mcp-setup.md:67-78` and `repository-analysis.md:39-46` instruct bare `search_graph` / `trace_path` / … Those bare names come from a hand-generated extension spawning `codebase-memory-mcp.exe cli` (`.myflow/archive/2026-10/norma-benchmark-gap-analysis/deliverables/06-non-gaps.md:113`, `research/norma-ext-integrate.md:16-18`: "与 MCP 路径无关"). The doc's two halves describe two different tool surfaces. | high |
| `myflow-update-spec/SKILL.md:127-129` | Capture harness lessons in `myflow-meta/references/harness-conventions.md`, "**not in the project spec**" | In this repo the project spec *is* the harness spec: `.myflow/spec/harness/index.md:1-7` "Rules for changing the myflow harness", and its checklist requires a contract change to update "this file *and* every copy". The rule is right for a consumer project, wrong for the tree this skill is invited to update here. | medium |
| `myflow-spec-bootstrap/references/spec-writing.md:64` | Example reference file `src/turn-cache.ts` | Real path is `.pi/extensions/myflow/turn-cache.ts`; there is no `src/` in this repo (`tests/task-bridge.test.ts`, `.myflow/scripts/task.py:73` agree). A path claim in the skill's only worked example. | medium |
| `myflow-spec-bootstrap/references/spec-task-planning.md:44-48, 55-59` | PRD template "Files To Create Or Update": `index.md`, `<area>/index.md`, `<area>/<topic>.md`; acceptance checks placeholders/links/claims only | Omits `.myflow/spec/guides/index.md`, directly contradicting `spec-writing.md:23` ("Always include") and `SKILL.md:59` ("exists in every generated tree"). A bootstrap driven by this template ships a tree that fails its own Done Criteria. | medium |
| `myflow-update-spec/SKILL.md:42-44` | If the tree is missing: "create `index.md` plus the appropriate `<area>/index.md`" | Same omission, inside the skill whose own Minimal Tree (`:65-67`) lists `guides/index.md` as part of the layer set. One step later the file is mandatory; here it is absent. | medium |
| `spec-writing.md` (Content Standards, `:29-47`) and `myflow-spec-bootstrap/SKILL.md:56-61` (Done Criteria) | Both prescribe tree contents | Neither requires the **Pre-Development Checklist** / **Quality Check** wrapper. `.myflow/spec/index.md:17-19` promises it for every area, and `harness/index.md:9` / `:408` implement it. `myflow-update-spec:65` mentions it in passing but has no template for either section under `## Templates`. Generated trees can legitimately miss the one structural promise the index makes. | medium |
| `myflow-spec-bootstrap/references/mcp-setup.md:36-38` | A generated `~/.pi/agent/extensions/cbmem.ts` "exposes the server's tools directly to the model … regenerated on install/update" | Location is valid (`docs/extensions.md:17`) but the file is absent here, and nothing in this repo generates it (`grep cbmem` → only archive research). Presented as an install-time mechanism with no mechanism in the payload. | medium |
| `references/mcp-setup.md:45` | "Verify with `pi mcp` or the `/mcp` command" | Docs specify `pi mcp list` (`docs/mcp.md:96`); `/reload` (`:44`) is correct (`docs/configuration.md:5`). | low |
| `references/spec-task-planning.md:65` | Helpers dispatch with `myflow_subagent` ("`single`, or `parallel` prompts") | Tool enum is `["single", "parallel", "chain"]` (`.pi/extensions/myflow/subagent.ts:250`). Enumeration presented as complete but is not. | low |
| `spec/index.md:15` vs `myflow-update-spec:45` vs `guides/index.md:3` | `guides/` described as "cross-cutting thinking checklists" / "thinking questions rather than executable contracts" / "how to decide what is true" | Three vocabularies for one layer. Same idea, no single canonical sentence to cite. | low |
| `references/mcp-setup.md:57` | `persistence: true` writes `.codebase-memory/graph.db.zst` | Consistent with `.gitignore:10` (`.codebase-memory/`) — runtime artifact, correctly not required to exist. | pass |
| `references/spec-task-planning.md:32` | `python3 ./.myflow/scripts/task.py create "…" --slug spec-<area>` | `create` + `--slug` exist (`task.py:1151-1156`); `archive` exists (`task.py:816`). | pass |
| `references/spec-writing.md:59-60` | Session key `pi_<sanitized>` from `MYFLOW_CONTEXT_ID` / `PI_SESSION_ID`, path `.myflow/.runtime/sessions/<contextKey>.json` | Matches `task.py:19,73,120-132` and `get_context.py:116-122`. | pass |
| `references/spec-writing.md:77`, `:79-81` | `npm run check`, placeholder grep | `package.json:8-12` has `check` = `typecheck && test`. Links/`index.md` advice matches `spec/index.md`. | pass |
| `myflow-update-spec:53-68` | Minimal Tree layout | Matches the live tree: `index.md` → `harness/index.md` + `guides/index.md`; area index really does carry a Pre-Development Checklist and a Quality Check. | pass |
| `references/spec-task-planning.md:19` | "This repository … has exactly one area (`harness/`)" | True (`.myflow/spec/` = `index.md`, `harness/`, `guides/`). | pass |

## 5 highest-risk items

1. **`SKILL.md:18` — the analysis backend does not exist and its reader cannot
   reach it.** The skill's step 2 puts codebase-memory first and states it is
   already configured. On this machine neither the MCP entry nor the extension
   is present, and every dispatched agent's tool allowlist is
   `read/write/edit/bash/find/grep/ls`. An agent follows a documented
   preference order whose first rung is unreachable, and the doc gives no
   "when the tools are absent, say so" cue beyond the fallback paragraph in a
   reference file it may never open.
2. **`mcp-setup.md:41-45` — the migration instructions produce a different tool
   surface than the one the same file then documents.** Bare names come from
   `cbmem.ts` spawning the CLI (`06-non-gaps.md:113`), not from the MCP server;
   adding only the `mcpServers` entry yields `mcp__codebase-memory-mcp__*`.
   Anyone on a second machine follows the steps, verifies with `pi mcp`, and
   then calls names that do not exist.
3. **`spec-writing.md:61` — the skill's model contract entry is factually
   wrong.** `task.py create` writes the session pointer (`task.py:635-643`).
   This is the *example* that teaches what a good spec entry looks like; an
   agent copying its shape copies an unverified claim, which is exactly the
   failure mode the new `doc-drift-thinking-guide.md` was written to catch.
4. **`spec-task-planning.md:44-59` + `myflow-update-spec:42-44` — two of the
   three "create the tree" instructions omit `guides/`.** After section 5 made
   `guides/` mandatory, the step-by-step paths still produce a tree without it,
   so the same drift can come back through the bootstrap rather than through
   the prose that named it.
5. **No template or done-criterion for the Pre-Development Checklist / Quality
   Check wrapper.** `spec/index.md:17-19` promises both in every area and
   `harness/index.md` has both; neither skill's templates or acceptance list
   requires them, so a freshly generated tree satisfies every stated criterion
   and still breaks the index's structural contract.

## Recommendations (not applied — read-only)

- Replace `SKILL.md:18` with a conditional: "if the graph tools are available
  in your tool list, prefer them; otherwise go straight to source reads, and
  say so in the notes." Drop "already configured".
- Cut `mcp-setup.md`'s "Moving It To Another Machine" down to the one thing the
  payload can honestly promise (MCP entry → namespaced tools) and state the
  name difference explicitly, or delete the section and keep the fallback.
- Fix `spec-writing.md:61` to "`create` seeds the pointer; `start` / `finish` /
  `archive` move or clear it" and `:64` to
  `.pi/extensions/myflow/turn-cache.ts`.
- Add `guides/index.md` to `spec-task-planning.md`'s "Files To Create Or
  Update" and acceptance list, and to `myflow-update-spec:43`.
- Add one line to both skills' templates/criteria: an area index opens with a
  Pre-Development Checklist and closes with Quality Check, and say what belongs
  in each.
- Reword `myflow-update-spec:127-129`: payload-level harness rules live in
  `harness-conventions.md`; a project's harness rules live in
  `.myflow/spec/harness/` — this repo has both, deliberately.

## Not verified

- The commit hashes in `guides/doc-drift-thinking-guide.md:22-25`
  (`a0e3525`, `844b7cd`, `97a0382`): no shell access in this audit.
- The codebase-memory tool names themselves (`get_architecture`,
  `check_index_coverage`, …): the backend is absent on this machine, so the
  names cannot be checked against a live registry; only the *source* of the
  bare names (extension vs MCP) is evidenced, via the archive research.
