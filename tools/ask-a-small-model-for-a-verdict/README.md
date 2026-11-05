# tools/ask-a-small-model-for-a-verdict/

Asks a small model one declared question about some text (yes or no, which of a list, or how much on a scale) and trusts the answer only if that model first got a set of already-answered cases right. A model that says yes to everything, or gets a case wrong, is refused however cheap it was; a rubric with no cases, or whose cases all expect one answer, is refused too. The same folder keeps what that calibration settled, picks which of a person's places holds an answer, shows which models can judge which question, measures where a confidence line belongs, fits a pass line and a fail line from lines a person already ruled on, turns a wrong verdict into a known case, recognises a repeat, and answers several typed questions about one state in one request.

Everything personal is the person's input: the question, the cases, the confidence bands, the owners, which models to ask and where, and the file holding a hosted classifier's key. The tool names no model, vendor or word list. Ported from the packages `ask-a-small-model-for-a-verdict` and `answer-state-questions`, with the core, adapters and correction steps as hardened since in the control plane's judges, which now import this folder.

## Settings the person gives (no default in code)

Each of these is in the request and a request without it is refused with a sentence naming the field:

| Setting | Where | What it decides |
|---------|-------|-----------------|
| `pass_when_share_correct`, `confidence_bands`, `band_when_confidence_unknown` | `route` | The share of an owner's own examples a model must file back under the right owner (below 1 lets that share of mis-filed examples through), and what to do at which confidence. |
| `pass_when_share_correct`, `same_at_least`, `plainly_the_same_at`, `keep_characters` | `note-repeat` | The bar for trusting a model to match a flag to an earlier one, the confidence at which its pick counts, the word overlap at which two texts are the same without asking, and how much text is stored. The two model bars are needed only when providers are given; the overlap bar once an earlier flag exists. |
| `score_tolerance` | a score rubric (required) | How many levels away from the expected answer still counts as right. |
| `excerpt_characters` | `ask` with `log_file` | How much of the text is kept beside each logged verdict. |
| `endpoint`, `timeout_seconds`, `protocol` | a `locally-served` provider row | Where the model server is, how many seconds a request may take, and how it is spoken to: `ollama` or `openai-chat` (an OpenAI chat-completions server such as mlx_lm.server, which also needs `models`, the names to ask, because it loads any model it is asked for). |
| `endpoint`, `model`, `samples` | a `hosted-classifier` provider row | Where the classifier is, which model, and how many times one question is asked and averaged. |
| `timeout_seconds` | `answer-state-questions` | How many seconds the model server may take. |
| `accepts_characters` (optional) | either provider row | The most text that model reads. Content longer than it is refused, never cut; a row that declares none is sent the whole content, so declare one for any model with a smaller reading window. |
| `fail_good_share_at_most`, `pass_bad_share_at_most`, `usable_when` | `fit-lines` | The share of good lines the fail line may fail, the share of bad lines the pass line may let through, and the bars a question must clear to be usable: `auc_at_least`, `bad_lines_at_least`, `recall_at_least`, `good_failed_or_uncertain_at_most`. |
| `passes` (optional) | `ask`, `calibrate`, `scoreboard` | How many times each calibration case is asked. The request default is 2 for `ask` and `scoreboard` and 1 for `calibrate`, stated in each row. |

## Answering a check's questions with a model on this computer

`tool:answer-a-checks-questions-with-a-model-on-this-computer` answers the questions `tool:check-against-a-persons-rules-and-verdicts` lists for its `ask` rows, and `tool:calibrate-a-checks-questions-on-lines-i-ruled-on` measures, on lines the person already ruled on, where each such row should pass and fail a line (this folder's `fit-lines`) and whether it is usable at all. Both read the person's setting row (`settings_record`: the id `record:setting:ask-a-small-model-for-a-verdict~<scope_kind>~<scope_id>` of a row in `list:settings`, read through the door, or the record itself as `tools/settings` takes it; read with `tools/settings` `setting`), their ask rows (`record:check:<id>`) and their labelled lines (rows of `list:checks` with `kind: "labelled-line"`, a `set` and an `at` order, each `part_of` the ask rows it calibrates) through the records door. What answers an ask is the row's own data: `adapter` (`{ name, blake3 }`: decider-2b with that LoRA adapter, its folder the setting's `adapters[name]`, refused when its BLAKE3 differs), `model.mlx` (a downloaded MLX chat model at its one snapshot, or the one the setting pins), `model.consult` (a hosted model through the consult-model route, many lines per call within the setting's line and byte bounds), `model.stand_in` (fixed answers, never cached: what the samples and tests use), or the base model. `examples` (`{ items: <set>, bad_for }`) shows the person's ruled lines of that set first, never the judged line; `context` shows where the line sits in its film. Every answer is kept in the setting's `cache_file`, keyed by what answered, the question and the framed line.

The setting row (`settings`) holds, all the person's: `model_cache_root` (else `HF_HUB_CACHE`, else `HF_HOME/hub`, else the Hugging Face default), `base_model` (`{ repo, snapshot }`), `adapters`, `mlx_snapshots` (optional pins), `cache_file`, `frame` (the words a line is shown in, `{text}` where it goes), `batch`, `consult_batch`, `consult_bytes`, `consult_route` (else `AI_COMMAND_CENTER`), `device` (else `DECIDER_DEVICE`, else cuda, mps, cpu), `good_sets` (for lines kept by set), `example_good_sources` and `fit` (`fail_good_share_at_most`, `pass_bad_share_at_most`, `usable_when`).

Moved from the launch-video copy gate's `decider_layer.py` (its first commit here is the byte copy; `ports/answer-with-a-downloaded-model.json`), with its `decider-kinds` test (which ask rows a unit reaches, now proven against `tool:check-against-a-persons-rules-and-verdicts`) and its place test (the model found in the cache the place reports, the device it has, no route guessed). Old trillion had no such answerer: it served decider-2b over HTTP as a `local-model-classifier` record (`records/local-model-records.json:140-147`), which this folder's hosted-classifier adapter already reads, and `parts/judge-words/do-work/judge-words.mjs:10-14` judges only word, pattern, exact and grammar rows, never an `ask`. Not carried: nothing; inline yes and no `examples` (the public-copy rows' shape, read by a hosted classifier) are refused in words where the old file failed with a KeyError.

## What is fixed in code, and why

These are the tool's mechanism, not anyone's preference, and they are not settings:

- A hosted classifier takes at most 255 options in a choice and 2 to 10 levels in a score. That is the hosted service's own published limit; a larger question is refused with the number instead of the service's opaque 422.
- A hosted classifier's yes or no is a probability, and 0.5 or more is read as yes. That is what a probability of yes means.
- `remember-what-was-already-said` offers at most 40 earlier flags in one question, each as its first 300 characters, because more would not fit a small model's reading window.
- A chosen model's calibration is trusted for the rubric's `max_age_hours` (24 when the rubric names none) and a loss for six hours before the models are scored again; a hosted request refused as busy is tried up to three times, waiting 250 ms and then 500 ms. These bound how much model time one question can burn.
- A kept calibration is bound to this tool's own source bytes (BLAKE3 of `do-work/` and what it imports), the models' builds (a served digest or `served_identity`) and every rubric field that can change an outcome, so a change to any of them is measured again, never inherited.
- Kept calibration is written under one writer lock, one complete file replaced at a time, and read back before it counts. Where the place's `open(2)` takes a kernel open lock (`O_EXLOCK`, asked of the folder by trying it twice), that lock is used and the kernel lets it go when its holder ends. Anywhere else the lock is held by its name: the file is linked in whole with its holder (process, start time and place), removed by that holder when it is done, and taken from a holder only when that process has ended on the same place. A lock held from another place sharing the folder, or of the other way, is never taken: the write is refused as busy.
- The line measured by `find-lines` is searched in steps of 0.01 around the labelled confidences.
- `fit-lines` takes the share quantiles by index, with no interpolation. It holds out each good line in turn (leave one out). It counts a line scored per sentence by its highest sentence.
- A locally-served model, and `answer-state-questions`, are asked over a connection closed after each request (`fresh-local-classifier-fetch.mjs`). A slow pause between two questions then never lands on an idle pooled socket. This adds no retry and no model sample.

## What differs from the old packages

- `answer-state-questions`: a `noul` answer is the likelihood of yes, a number from 0 to 1, checked as such. The old package accepted any non-empty text for it, so a reply of "maybe" passed; here it is refused.
- Not carried: the model-server launchers (`start_with`), the turn-end and before-the-work hooks, and the engine request adapter. They were glue for the old engine, not a job a person asks for.
- Not carried: `whatToSay`, the old escalation that rewrote a hook's warning with wording that grew sterner at the third and fourth repeat. It was the old hook's own voice, not a generic step. `note-repeat` returns `times`, `sessions`, `first_seen` and `repeat`, and the caller says what it likes with them.

## Files

| File | Purpose |
|------|---------|
| `do-work/ask-a-small-model.mjs` | The entry for every row: one JSON request on standard input, one action on the command line (`ask`, `route`, `scoreboard`, `calibrate`, `find-lines`, `fit-lines`, `record-wrong`, `note-repeat`, `answer-state-questions`), `{ result }` or `{ error }` on the last line. |
| `do-work/ask-for-a-verdict.mjs` | The core: answer shapes as data, rubric checks, scoring a candidate, choosing one that passes (with the kept calibration), confidence bands, the verdict. |
| `do-work/who-can-be-asked.mjs` | The one place that turns provider rows into candidates and a single `ask`. `ADAPTERS` is the one table of adapters; a caller with its own adapter adds a row. |
| `do-work/ask-a-locally-served-model.mjs` | Adapter for a chat model served on the person's computer; asks for the answer in the rubric's schema where the server takes one, in words always. `KINDS` is its table of answer kinds and `PROTOCOLS` its table of server kinds (`ollama`, `openai-chat`); a caller adds a row for one of its own. |
| `do-work/ask-a-hosted-classifier.mjs` | Adapter for a hosted classifier that returns probabilities; endpoint, model and key file come from the provider row. |
| `do-work/judge-content.mjs` | `judgeContent`: the verdict plus `accepted`, fail-closed on the rubric's `accept_when_answer_in`, with the BLAKE3 identity of exactly what was reviewed; `contentReleaseFor` runs a caller's release only after a current review of current material. |
| `do-work/route-to-the-owner-that-answers.mjs` | Builds the "which owner holds this" rubric from the person's owners and asks it. |
| `do-work/see-which-models-can-judge.mjs` | The scoreboard of every model against every rubric. |
| `do-work/find-where-the-line-should-go.mjs` | Measures the confidence line from the labelled cases. |
| `do-work/fit-pass-and-fail-lines.mjs` | `fitLines`: from the model's probability of the failing answer on lines a person ruled bad and good, the fail line, the pass line, AUC, recall, held-out shares, and usable or unseparable with reasons. It asks no model. |
| `do-work/fresh-local-classifier-fetch.mjs` | `freshLocalClassifierFetch`: a fetch that closes the connection after each request, the default way a model on the person's computer is asked. |
| `do-work/tell-it-when-it-was-wrong.mjs` | Adds a wrong verdict to a rubric as a labelled case, keeping the earlier label in `label_history`; a held-out case is never turned into calibration. |
| `do-work/judge-log-frontier.mjs` | Bounded reads of a verdict log and the rubrics file: size and time limits, and a file that changes during the read is refused. |
| `do-work/remember-what-was-already-said.mjs` | Files a flagged text under an earlier one (word overlap, then a closed choice) and counts it. |
| `do-work/answer_with_a_downloaded_model.py` | Answers asks with decider-2b (base or a LoRA adapter checked by BLAKE3), a downloaded MLX chat model, a hosted model through the consult-model route or a stand-in, with an answer cache; `calibrate` scores ruled lines by their worst sentence and calls `fit-lines`. One JSON request on standard input (the settings already read), `{ result }` or `{ error }` on the last line. |
| `do-work/answer-with-a-downloaded-model.mjs` | `answerAsks` and `calibrateAsks`, the two rows: read the setting (`tools/settings`), the ask rows and the labelled-line sets through the door, and run the Python file. |
| `ports/*.json` | The port claims for the two files above. |
| `do-work/answer-state-questions.mjs` | Typed questions about a state in one request, every answer checked against its type. |
| `part.json` | `do-work/ask-for-a-verdict.mjs` is public, so another tool may import the same core. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder (eleven tools). |
| `test/answer-with-a-downloaded-model.test.mjs`, `test/answer_with_a_downloaded_model_probe.py` | The answerer and its rows on made-up settings, rows and lines with stand-in models and a made-up answer cache: answers, cache keys, prompts, the hosted route's bounds and parsing, the place, calibrate in both line shapes, the door reads and refusals, and which ask rows a unit reaches. |
| `test/*.test.mjs` | The core, shapes, bands, calibration memory and adapters (synthetic cases only), plus the tool run end to end against a stand-in model server, the typed-question checks, `fit-lines` on made-up scores and the fresh connection. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| Rubric | `{ id, question, answer_shape: { kind: 'true-or-false' } \| { kind: 'one-of', options: [name \| { name, description }] } \| { kind: 'score', levels: [...] }, calibration: [{ content, expect }], confidence_bands?: [{ at_least, then }], band_when_confidence_unknown?, bands_read?, pass_when_share_correct?, score_tolerance (required for a score), accept_when_answer_in? }` | The question and what counts as right, all data. |
| Provider row | `{ via: 'locally-served', endpoint, timeout_seconds, protocol, models?, most_bytes?, accepts_characters? }` or `{ via: 'hosted-classifier', endpoint, model, samples, key_file \| needs_no_key, accepts_characters?, timeout_seconds? }`, each with optional `calibration_timeout_seconds` and `label` | Where a model is. The key is read from the file named, never from the request. |
| `checkRubric` | `(rubric) -> checked` | Refuses a rubric with no cases or only one answer among them. |
| `scoreCandidate` / `chooseCandidate` | `({ candidate, rubric, ask, passes }) -> score`, `({ candidates, rubric, ask, passes, remember, calibrate }) -> { chosen, scoreboard }` | Score one model on the cases; pick the first that passes, remember it, remember real losses for six hours, never remember a choice made only because an earlier model was unreachable. |
| `judge` | `({ rubric, content, candidates, ask, passes, sureAt, remember, calibrate }) -> verdict` | The answer, confidence, agreement, distribution, band, who answered and the calibration. Content past a model's declared `accepts_characters` is refused, not trimmed. |
| `bandFor` | `(confidence, bands, whenUnknown) -> then` | The band the rubric drew for a confidence. |

## Dependencies

**Depends on:** `tools/settings` (the person's setting row, for the two answering rows), `tools/records-door`, Python 3 (and on the person's computer torch, peft and blake3 for decider-2b, mlx and mlx_lm for an MLX model), `tools/content-identity` (the one BLAKE3 identity of bytes, through its public `read-data/identity.mjs`, which needs the checkout's `npm install`), Node, and a model server on the person's computer or a hosted classifier whose key is in a file the person names.

**Depended on by:** `tool-rows.json`; any tool that needs a calibrated yes or no may import `do-work/ask-for-a-verdict.mjs`.
