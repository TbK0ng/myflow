# Doc Drift Thinking Guide

A sentence that names a path, a subcommand, a count, or a default is a claim
about code. Treat it as a claim to verify, not as context to trust.

## When A Claim And The Code Disagree

Work out which one is older before editing either:

1. `git log -S <token> --oneline` — when did the claim last change, and when did
   the code?
2. `git blame <file>` — which commit wrote the sentence, and what did that
   commit promise?
3. The upstream origin — a claim ported from another layout may still be correct
   even when the file it names is gone, because the file is what went missing.

Deleting the claim is the tempting fix and often the wrong one: prose that
survives a rewrite is evidence of intent.

## Case Study: `guides/`

- `.myflow/spec/guides/` comes from the upstream Trellis spec layout, and
  `spec-system.md` at `a0e3525` documents it as part of the directory model.
- The tree itself landed here in `844b7cd`. `97a0382` then rewrote
  `.myflow/spec/index.md` and dropped its `guides/` entry, while three skills
  kept naming the directory.
- The first fix called the layer "optional, this project has none". The surviving
  references were evidence of intent, not stale text: the correct fix restored
  the layer, created the directory, and taught `myflow-spec-bootstrap` to
  generate it.

## Checklist By Claim Type

| Claim | Check |
| --- | --- |
| A path | Does it resolve? `ls <path>` from the repository root. |
| A subcommand | Does the parser have it? `grep add_parser <script>`. |
| A count | How many copies exist, and which one is canonical? Make the others point at it, or make a test compare them. |
| A config key | Is it read? `grep -R <key> .pi/extensions .myflow/scripts`. |
| A default | Does it match the code? Read the value beside the key it belongs to. |

## Prevention

Prefer a mechanism to a corrected paragraph: a test that compares two copies
beats a sentence promising they agree. `tests/scaffold.test.ts` compares the
canonical hook table against the handlers the extension registers, and
`tests/skills-hygiene.test.ts` fails on a dead path or subcommand, so drift that
a chat session fixes once cannot return unnoticed.
