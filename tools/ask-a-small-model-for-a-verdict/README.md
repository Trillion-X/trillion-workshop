# tools/ask-a-small-model-for-a-verdict/

Asks a small model one declared question about some text (yes or no, which of a list, or how much on a scale) and trusts the answer only if that model first got a set of already-answered cases right. A model that says yes to everything, or gets a case wrong, is refused however cheap it was; a rubric with no cases, or whose cases all expect one answer, is refused too. The same folder keeps what that calibration settled, picks which of a person's places holds an answer, shows which models can judge which question, measures where a confidence line belongs, turns a wrong verdict into a known case, recognises a repeat, and answers several typed questions about one state in one request.

Everything personal is the person's input: the question, the cases, the confidence bands, the owners, which models to ask and where, and the file holding a hosted classifier's key. The tool names no model, vendor or word list. Ported from the packages `ask-a-small-model-for-a-verdict` and `answer-state-questions`, with the core, adapters and correction steps as hardened since in the control plane's judges, which now import this folder.

## Settings the person gives (no default in code)

Each of these is in the request and a request without it is refused with a sentence naming the field:

| Setting | Where | What it decides |
|---------|-------|-----------------|
| `pass_when_share_correct`, `confidence_bands`, `band_when_confidence_unknown` | `route` | The share of an owner's own examples a model must file back under the right owner (below 1 lets that share of mis-filed examples through), and what to do at which confidence. |
| `pass_when_share_correct`, `same_at_least`, `plainly_the_same_at`, `keep_characters` | `note-repeat` | The bar for trusting a model to match a flag to an earlier one, the confidence at which its pick counts, the word overlap at which two texts are the same without asking, and how much text is stored. The two model bars are needed only when providers are given; the overlap bar once an earlier flag exists. |
| `score_tolerance` | a score rubric (required) | How many levels away from the expected answer still counts as right. |
| `excerpt_characters` | `ask` with `log_file` | How much of the text is kept beside each logged verdict. |
| `endpoint`, `timeout_seconds` | a `locally-served` provider row | Where the model server is and how many seconds a request may take. |
| `endpoint`, `model`, `samples` | a `hosted-classifier` provider row | Where the classifier is, which model, and how many times one question is asked and averaged. |
| `timeout_seconds` | `answer-state-questions` | How many seconds the model server may take. |
| `accepts_characters` (optional) | either provider row | The most text that model reads. Content longer than it is refused, never cut; a row that declares none is sent the whole content, so declare one for any model with a smaller reading window. |
| `passes` (optional) | `ask`, `calibrate`, `scoreboard` | How many times each calibration case is asked. The request default is 2 for `ask` and `scoreboard` and 1 for `calibrate`, stated in each row. |

## What is fixed in code, and why

These are the tool's mechanism, not anyone's preference, and they are not settings:

- A hosted classifier takes at most 255 options in a choice and 2 to 10 levels in a score. That is the hosted service's own published limit; a larger question is refused with the number instead of the service's opaque 422.
- A hosted classifier's yes or no is a probability, and 0.5 or more is read as yes. That is what a probability of yes means.
- `remember-what-was-already-said` offers at most 40 earlier flags in one question, each as its first 300 characters, because more would not fit a small model's reading window.
- A chosen model's calibration is trusted for the rubric's `max_age_hours` (24 when the rubric names none) and a loss for six hours before the models are scored again; a hosted request refused as busy is tried up to three times, waiting 250 ms and then 500 ms. These bound how much model time one question can burn.
- A kept calibration is bound to this tool's own source bytes (BLAKE3 of `do-work/` and what it imports), the models' builds (a served digest or `served_identity`) and every rubric field that can change an outcome, so a change to any of them is measured again, never inherited.
- Kept calibration is written under a kernel open lock (macOS `O_EXLOCK`), one complete file replaced at a time, and read back before it counts. Elsewhere a `remember_file` is refused; asking without one still works.
- The line measured by `find-lines` is searched in steps of 0.01 around the labelled confidences.

## What differs from the old packages

- `answer-state-questions`: a `noul` answer is the likelihood of yes, a number from 0 to 1, checked as such. The old package accepted any non-empty text for it, so a reply of "maybe" passed; here it is refused.
- Not carried: the model-server launchers (`start_with`), the turn-end and before-the-work hooks, and the engine request adapter. They were glue for the old engine, not a job a person asks for.
- Not carried: `whatToSay`, the old escalation that rewrote a hook's warning with wording that grew sterner at the third and fourth repeat. It was the old hook's own voice, not a generic step. `note-repeat` returns `times`, `sessions`, `first_seen` and `repeat`, and the caller says what it likes with them.

## Files

| File | Purpose |
|------|---------|
| `do-work/ask-a-small-model.mjs` | The entry for every row: one JSON request on standard input, one action on the command line (`ask`, `route`, `scoreboard`, `calibrate`, `find-lines`, `record-wrong`, `note-repeat`, `answer-state-questions`), `{ result }` or `{ error }` on the last line. |
| `do-work/ask-for-a-verdict.mjs` | The core: answer shapes as data, rubric checks, scoring a candidate, choosing one that passes (with the kept calibration), confidence bands, the verdict. |
| `do-work/who-can-be-asked.mjs` | The one place that turns provider rows into candidates and a single `ask`. `ADAPTERS` is the one table of adapters; a caller with its own adapter adds a row. |
| `do-work/ask-a-locally-served-model.mjs` | Adapter for a chat model served on the person's computer (the server's tags and chat endpoints); asks for the answer in the rubric's schema. `KINDS` is its table of answer kinds; a caller adds a row for a kind of its own. |
| `do-work/ask-a-hosted-classifier.mjs` | Adapter for a hosted classifier that returns probabilities; endpoint, model and key file come from the provider row. |
| `do-work/judge-content.mjs` | `judgeContent`: the verdict plus `accepted`, fail-closed on the rubric's `accept_when_answer_in`, with the BLAKE3 identity of exactly what was reviewed; `contentReleaseFor` runs a caller's release only after a current review of current material. |
| `do-work/route-to-the-owner-that-answers.mjs` | Builds the "which owner holds this" rubric from the person's owners and asks it. |
| `do-work/see-which-models-can-judge.mjs` | The scoreboard of every model against every rubric. |
| `do-work/find-where-the-line-should-go.mjs` | Measures the confidence line from the labelled cases. |
| `do-work/tell-it-when-it-was-wrong.mjs` | Adds a wrong verdict to a rubric as a labelled case, keeping the earlier label in `label_history`; a held-out case is never turned into calibration. |
| `do-work/judge-log-frontier.mjs` | Bounded reads of a verdict log and the rubrics file: size and time limits, and a file that changes during the read is refused. |
| `do-work/remember-what-was-already-said.mjs` | Files a flagged text under an earlier one (word overlap, then a closed choice) and counts it. |
| `do-work/answer-state-questions.mjs` | Typed questions about a state in one request, every answer checked against its type. |
| `part.json` | `do-work/ask-for-a-verdict.mjs` is public, so another tool may import the same core. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder (eight tools). |
| `test/*.test.mjs` | The core, shapes, bands, calibration memory and adapters (synthetic cases only), plus the tool run end to end against a stand-in model server and the typed-question checks. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| Rubric | `{ id, question, answer_shape: { kind: 'true-or-false' } \| { kind: 'one-of', options: [name \| { name, description }] } \| { kind: 'score', levels: [...] }, calibration: [{ content, expect }], confidence_bands?: [{ at_least, then }], band_when_confidence_unknown?, bands_read?, pass_when_share_correct?, score_tolerance (required for a score), accept_when_answer_in? }` | The question and what counts as right, all data. |
| Provider row | `{ via: 'locally-served', endpoint, timeout_seconds, most_bytes?, accepts_characters? }` or `{ via: 'hosted-classifier', endpoint, model, samples, key_file \| needs_no_key, accepts_characters?, timeout_seconds? }`, each with optional `calibration_timeout_seconds` and `label` | Where a model is. The key is read from the file named, never from the request. |
| `checkRubric` | `(rubric) -> checked` | Refuses a rubric with no cases or only one answer among them. |
| `scoreCandidate` / `chooseCandidate` | `({ candidate, rubric, ask, passes }) -> score`, `({ candidates, rubric, ask, passes, remember, calibrate }) -> { chosen, scoreboard }` | Score one model on the cases; pick the first that passes, remember it, remember real losses for six hours, never remember a choice made only because an earlier model was unreachable. |
| `judge` | `({ rubric, content, candidates, ask, passes, sureAt, remember, calibrate }) -> verdict` | The answer, confidence, agreement, distribution, band, who answered and the calibration. Content past a model's declared `accepts_characters` is refused, not trimmed. |
| `bandFor` | `(confidence, bands, whenUnknown) -> then` | The band the rubric drew for a confidence. |

## Dependencies

**Depends on:** `@noble/hashes` (BLAKE3, as the content-identity tool uses), Node, and a model server on the person's computer or a hosted classifier whose key is in a file the person names.

**Depended on by:** `tool-rows.json`; any tool that needs a calibrated yes or no may import `do-work/ask-for-a-verdict.mjs`.
