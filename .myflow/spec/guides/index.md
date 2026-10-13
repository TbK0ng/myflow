# Thinking Guides

Short checklists to run in your head. These are **not** coding rules — the
concrete rules live in `../harness/index.md` and any other area `index.md`.

## Before Changing A Contract

- Who else consumes this value? Trace it before editing, not after.
- Is the same value defined in more than one file? (`ROOT`, `PLATFORM_NAME`,
  status strings, context-key prefixes)
- Does the change need a matching update in `src/`, the extension, a script,
  and a test?

## Before Adding Code

- Does an equivalent helper already exist in `src/` or the extension?
- Can this stay a Node builtin instead of a new dependency?
- Is it testable without a model, network, or a real `pi` process?

## Before Touching Paths, Commands, Or Encodings

- Windows and POSIX separators both work? (`path.join`, no hard-coded `/`)
- Read/written as UTF-8?
- Does a spawned command exist on a default developer machine? (`python3`,
  `git`)
- Are external processes guarded with a timeout and a graceful failure?

## Before Declaring Done

- Did you run the project checks in `harness/index.md`?
- Is every new behavior covered by a test that would fail if reverted?
- Did any instruction file become untrue? (skills, prompts, `workflow.md`)
