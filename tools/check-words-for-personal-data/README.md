# tools/check-words-for-personal-data/

Before words go to a model that is not on the person's computer, checks on the computer whether they hold personal data, and offers the person the choice: send it as it is, do the job on this computer only, or keep it back. Rules find shapes (email addresses, phone numbers, card numbers that pass the Luhn checksum, IBANs, national ids); a model served on the computer, when the input names one, answers yes-or-no questions (a name with a home address, health details). Only kinds and counts come back, never the matched text. It runs on the person's own computer as a `computer` row that asks for no capability.

## Files

| File | Purpose |
|------|---------|
| `read-data/personal-data.mjs` | `luhn`, `checkPersonalData`, and `check(input)`, the row's function. |
| `read-data/personal-data.json` | The rule patterns, the model questions, `use_model`, `threshold`, `sample_chars`, the choices offered and every word said. |
| `tool-rows.json` | `tool:check-personal-data`: a `computer` row with `capabilities: []`, run by `tools/records-door`'s `run-an-export.mjs`. It also packs `tools/ask-a-small-model-for-a-verdict/do-work`. |
| `part.json` | Nothing here is imported by other code. |
| `test/personal-data.test.mjs` | The original Trillion tests (rules, checksum, counts only, a model that does not answer, a model above the threshold, clean words). |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `checkPersonalData` | `({ text, model? }, { settings?, ask? }) => { contains, kinds, model_checked, choices, said? }` | Rules always; the model questions when `use_model` is on and a model answers. A model that does not answer is said in words and never counts as nothing found. |
| `check` | `(input) => answer` | The row's function. |

## Moved from Trillion

`computer/personal-data.mjs` and `computer/personal-data.json` (deleted in Trillion-X/trillion dc79bb0a87), with `test/personal-data.test.mjs`. The code is the same, except the model layer: the Mac app asked its own `computer/local-models.mjs` (still alive there, with the Mac's model settings); here the questions go to `tools/ask-a-small-model-for-a-verdict/do-work/answer-state-questions.mjs`, which already asks a model on this computer typed questions about one state, at the `model` the input names. The `local` choice still names `tool:ask-a-model`, the Mac app's own tool.

## Not yet

- Reaching a model server on this computer (a loopback address) is not a capability the engine's `computer-capabilities.json` lists, and its base sandbox allows no network. Until it does, a run with `model` gets the rules only, and `said` says the model did not answer.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), `tools/ask-a-small-model-for-a-verdict` (`answer-state-questions.mjs`), `tools/content-identity` (through it), Node's standard library.

**Depended on by:** `tool-rows.json`. Nothing imports this folder.
