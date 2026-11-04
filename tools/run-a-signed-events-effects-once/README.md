# tools/run-a-signed-events-effects-once

Admits signed events as effects and lists a subject's effects, through descriptors installed with the folder (`records.json`). Each fact of a verified event that matches an effect rule becomes one effect whose id is made from the event, fact and its parts, so the same fact twice is one effect. Every call to a verifier, writer or reader goes through the caller's `send`; the folder has no transport of its own.

## Files

| File | Purpose |
|------|---------|
| `part.json` | Which files other code may import (`do-work/signed-event-effects-targets.js`) |
| `records.json` | The installed descriptors: admission descriptors (owner actions, payment provider events), dispatch policies, the by-subject list descriptor and the two target descriptors |
| `do-work/signed-event-effects-targets.js` | `admitSignedEventEffects(input)` and `listSignedEventEffects(input)`, each calling `input.send` |
| `do-work/run-with-given-replies.mjs` | `runSignedEventEffectsWithGivenReplies({ op, descriptor_ref, events, subject, replies })`: one run of either target whose `send` answers from `replies` given in the input and writes every call down in `sent` (what `tool-rows.json` runs) |
| `tool-rows.json` | The row `tool:turn-signed-events-into-effects-once`, with a sample that admits one made-up payment event from a made-up verifier answer |
| `README.md` | This file |

## The row

`tool:turn-signed-events-into-effects-once` runs `do-work/run-with-given-replies.mjs` in a small container with no internet. It checks no signature and writes no store itself: the verifier, writer and reader answers are DATA in the input, and `sent` shows each call the targets would make.
