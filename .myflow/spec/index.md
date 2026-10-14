# myflow Spec

`.myflow/spec/` is this project's coding-convention store. `index.md` is the
entry point: which areas exist and how to use them.

## Layout

- `harness/index.md` — rules for the myflow harness itself: the extension hooks,
  the sub-agent dispatch contract, task state, and the prompt-injection chain.

## How To Use

Read the area's `index.md` before changing code in it. Each area opens with a
**Pre-Development Checklist** and closes with a **Quality Check**; the
executable contracts live between them.

For the harness, `.pi/skills/myflow-meta/references/harness-conventions.md` is
the longer reference — it inventories the payload end to end. This tree holds
the rules that must not be re-litigated; that file holds the tour.
