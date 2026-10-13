---
name: myflow-break-loop
description: "Deep bug analysis to break the fix-forget-repeat cycle. Classifies the root cause, why fixes failed, the prevention mechanism, and captures the lesson into .myflow/spec/. Use after fixing a bug so the same class of bug cannot silently return."
---

# Break the Loop - Deep Bug Analysis

After a bug is fixed, analyze it so the *class* of bug does not recur.

## Analysis Framework

### 1. Root Cause Category

| Category | Characteristics | Example |
| --- | --- | --- |
| **A. Missing Spec** | Nothing documented how to do it | New feature with no checklist |
| **B. Contract Drift** | One side changed, the other did not | Context key format differ between extension and script |
| **C. Change Propagation** | Changed one place, missed another | New status added, `workflow.md` block missing |
| **D. Test Coverage Gap** | Unit passes, integration fails | Works alone, breaks combined |
| **E. Implicit Assumption** | Relies on undocumented behavior | Assuming `PI_SESSION_ID` exists outside shell tools |

### 2. Why Fixes Failed (if there were several attempts)

- **Surface fix**: treated the symptom, not the cause.
- **Incomplete scope**: found the cause, missed other occurrences.
- **Tool blind spot**: grep/typecheck could not see it.
- **Mental model**: kept looking in the wrong layer.

### 3. Prevention Mechanism

| Type | Example |
| --- | --- |
| Documentation | Add the contract to `.myflow/spec/` |
| Architecture | Make the bad state unrepresentable |
| Compile/lint | Strict types, no escape hatch |
| Runtime | Validate and fail loudly |
| Test | Regression test that fails on the original bug |
| Checklist | Add a line to a Pre-Development / Quality Check list |

Prefer the strongest mechanism that is cheap. A test beats a note.

### 4. Systematic Expansion

- Where else can this same failure occur?
- Is there a missing contract (B) or a missing workflow block (C)?
- Does an instruction file now describe something untrue?

### 5. Knowledge Capture

- [ ] Update `.myflow/spec/*/index.md` with the contract or gotcha.
- [ ] Add the question to `.myflow/spec/guides/index.md` if it is a thinking gap.
- [ ] Add or strengthen the regression test.
- [ ] Update the instruction file that let it happen (`workflow.md`, skill, prompt).

## Output Format

```markdown
## Bug Analysis: <short description>

### 1. Root Cause Category
- Category: <A-E> — <name>
- Specific cause: ...

### 2. Why Fixes Failed (if applicable)
1. <attempt>: <why it failed>

### 3. Prevention Mechanisms
| Priority | Mechanism | Action | Status |
| --- | --- | --- | --- |
| P0 | ... | ... | TODO/DONE |

### 4. Systematic Expansion
- Similar issues: ...
- Design/process improvement: ...

### 5. Knowledge Capture
- [ ] Files updated / tests added
```

## After Analysis: Act

Do not stop at the table. Immediately:

1. Update the spec files you listed.
2. Add the regression test.
3. Run `node --test tests/` and confirm it passes.
4. Commit the code fix and the spec/test update together.

> The analysis is worthless if it stays in chat. The value is in the spec
> entry and the test that now guards it.
