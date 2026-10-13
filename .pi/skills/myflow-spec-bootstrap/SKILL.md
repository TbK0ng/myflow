---
name: myflow-spec-bootstrap
description: "Bootstrap or refresh project-specific coding specs in .myflow/spec/ from the real codebase. Use when creating or refreshing .myflow/spec guidelines, analyzing a repository with the codebase-memory graph or direct source inspection, decomposing package/layer spec work, and writing concrete, source-backed spec docs without placeholder text."
---

# myflow Spec Bootstrap

Use this skill to create or refresh `.myflow/spec/` guidelines from the real
codebase. One capable agent owns the full loop: analyze the repository, choose
the spec boundaries, write the docs, and verify the result.

## Workflow

1. Confirm myflow is initialized and inspect the current `.myflow/spec/` tree
   if it exists (it may be absent or empty; that is a normal starting point).
2. Analyze the repository architecture with the best available tools, in this
   preference order:
   - **codebase-memory** — the code graph MCP already configured for this
     harness (see `references/mcp-setup.md` and `references/repository-analysis.md`)
   - language-native tooling (compiler, type checker, test runner)
   - direct source and test reads
3. Decompose the spec work by package and layer only when that reflects the
   actual codebase.
4. Fill or reshape the spec files with concrete patterns, real file paths,
   examples, and anti-patterns from the project.
5. Verify the final specs are internally consistent and contain no template
   placeholders.

## Reference Routing

| Need | Read |
|------|------|
| Repository architecture analysis | [references/repository-analysis.md](references/repository-analysis.md) |
| Spec work decomposition and task planning | [references/spec-task-planning.md](references/spec-task-planning.md) |
| Writing high-signal myflow spec files | [references/spec-writing.md](references/spec-writing.md) |
| codebase-memory setup | [references/mcp-setup.md](references/mcp-setup.md) |

## Operating Rules

- Treat the existing spec tree as a starting point, not a contract. Delete,
  rename, split, or add files when the repository calls for it.
- Prefer source-backed rules over generic advice. Every important
  recommendation should point at a real file or a repeated local pattern.
- Keep execution single-owner by default. Optional helper agents are an
  implementation detail, not a requirement or a user-visible dependency.
- Do not write platform-specific instructions; this harness runs on Pi only.
- Do not leave placeholder text, empty headings, or copied boilerplate in
  `.myflow/spec/`.
- Do not modify product source code while bootstrapping specs unless the user
  explicitly asked for that.

## Done Criteria

- `.myflow/spec/` describes the project as it exists now.
- Each relevant package or layer has practical coding guidance with real
  examples from this repository.
- Non-applicable sections are removed rather than filled with filler.
- `index.md` files match the final spec file set and link correctly.
- Analysis assumptions and the tools used are noted in the task or spec.
