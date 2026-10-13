---
name: myflow-update-spec
description: "Capture durable contracts, conventions, and hard-won lessons into .myflow/spec/ so future sessions do not rediscover them. Use after implementing a feature, fixing a bug, or making a design decision worth remembering."
---

# Update Spec

Write down what you learned, in the project's own spec store.

**Timing**: after completing a task, fixing a bug, or making a decision that
future work would otherwise re-litigate.

## What Counts As Spec

A spec entry is an **executable contract**, not a principle:

- Concrete signatures, field names, env keys, file paths, exit behavior.
- Testable statements ("X must equal Y", "when A happens, return Z").
- The *why*, so the rule survives when the code is refactored.

If a rule is only a question to ask yourself, it belongs in
`.myflow/spec/guides/`, not in a coding spec.

## When To Update

| Trigger | Example | Target |
| --- | --- | --- |
| Feature implemented | New tool, hook, or script subcommand | `.myflow/spec/<area>/index.md` |
| Design decision | Chose file-based state over a daemon | Relevant spec, "Design Decisions" |
| Bug fixed | Silent fallback hid a real error | Relevant spec, "Gotchas" |
| Gotcha found | `PI_SESSION_ID` is only set for shell tools | Relevant spec, "Contracts" |
| Convention established | Tests never touch the network | `.myflow/spec/<area>/index.md` |
| New area of the code | A second spec area is warranted | New `<area>/index.md` |

Do **not** update spec for: task-specific details (they belong in the task
directory), one-off debugging notes, or anything already written down.

## Process

1. **Identify the lesson.** What exactly did you learn, and what mistake does
   recording it prevent?
2. **Pick the file.** Read `.myflow/spec/index.md` if it exists. If the tree is
   missing, create `index.md` plus the appropriate `<area>/index.md` (or run
   `myflow-spec-bootstrap` for a full pass). Otherwise use the area you touched;
   in this repository that is usually `harness/`.
3. **Read it first.** Find the right section; do not duplicate an existing
   entry. If an entry is now wrong, fix it instead of adding a contradiction.
4. **Write it.** One concept per section. Include a short concrete example or
   command. State the *why*.
5. **Update the index** if you added a new file or section.

### Minimal Tree

When the project has no spec tree yet, this is enough:

```markdown
# <Project> Spec

`.myflow/spec/` is this project's coding-convention store. `index.md` is the
entry point: which areas exist and how to use them.

## Layout

- `<area>/index.md` — the rules for that area, with a Pre-Development
  Checklist and a Quality Check section.
```

`myflow-spec-bootstrap` can replace it with a tree generated from the codebase.

## Templates

### Contract

```markdown
### <Name>

- Producer: <file/function>
- Consumer(s): <files>
- Value/shape: <exact format>
- Invariant: <must always hold>
- Breaks if: <what goes wrong>
```

### Design Decision

```markdown
### Design Decision: <name>

- Context: <problem>
- Options: <A / B>
- Chosen: <X> because <reason>
- Revisit if: <condition>
```

### Gotcha

```markdown
> **Gotcha**: <non-obvious behavior>
>
> Happens when: <trigger>. Handle it by: <action>.
```

### Common Mistake

```markdown
### Common Mistake: <description>

- Symptom: <what you see>
- Cause: <why>
- Fix: <correct action>
- Prevention: <rule that stops it recurring>
```

## Quality Checklist

- [ ] Specific and actionable, with a command or example.
- [ ] States the *why*, not just the *what*.
- [ ] In the right file, not duplicating an existing entry.
- [ ] An index or checklist references it if it is easy to miss.
- [ ] Does not describe anything that does not exist in the repo.

## Related

- `myflow-meta/references/harness-conventions.md` — the rules for changing the
  myflow harness itself; capture harness lessons there, not in the project spec.
- `myflow-spec-bootstrap` — the bulk counterpart: generate or refresh the whole
  `.myflow/spec/` tree from the codebase.
- `myflow-break-loop` — deep analysis of a bug that often produces spec updates.
- `myflow-check` — the verify pass that runs before committing.
