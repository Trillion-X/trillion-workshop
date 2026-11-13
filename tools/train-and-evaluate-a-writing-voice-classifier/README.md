# tools/train-and-evaluate-a-writing-voice-classifier/

Trains a small classifier to judge a writer's voice and measures, honestly, how well it does. A person's labelled passages (a challenge set) are checked before any model sees them; each passage is sent with only the context its criterion may use; every answer is kept with its full probabilities, its timing and the exact request and reply; a choice counts only above the criterion's diagnostic minimum, else it is uncertain; and nothing unjudged ever becomes a pass. The training side binds every training row to its source passage and criterion, and audits whether the passages it is tested on were in what it was trained on.

Nothing about any person is in this folder. The passages, labels, criteria, voice references, the classifier's address and model, the model snapshot and the adapter folders are the person's: their challenge sets are input, their settings are a row of their `list:settings` read with `tools/settings`. The fixtures under `test/fixtures` are made up.

Adapted from an earlier writing-classifier tool family; the existing contracts retain its source identities and citations. Schema names (`book-voice-decider-challenge-v1..v3`, `book-voice-decider-evaluation-v2`, `book-voice-adapter-training-row-v1/v2`, `book-voice-training-provenance-v2/v3`) stay unchanged so stored sets and reports remain readable. The persisted training receipt is v2 because it records Namespace file identities instead of temporary computer paths.

## How old Trillion did the same job

Old Trillion (Trillion-X/trillion) never trained or evaluated a voice classifier. The nearest jobs, and why this is not them:

- `scripts/measure-decision-evals.mjs:1-20` asks each local judge every case of a decision eval and keeps right/of/cut/margin. That measures whether a judge can take one of the app's decisions; this measures a voice classifier on a person's challenge passages with request-and-reply evidence, resume and per-criterion confusion. Its "a judge is asked alone" and "the cases and the bar are DATA" hold here too.
- `src/confidence-filter.mjs:36-39` (`act` / `ask` / `abstain` by confidence) is a rule for acting. This tool's `expectedDecision` (the choice above its diagnostic minimum, else uncertain) only reports; it never acts and is no calibrated threshold.
- `parts/judge-words` runs word rules; it asks no model and is not used here.

## Settings the person gives (no default in code)

| Setting | Where | What it decides |
|---|---|---|
| `endpoint` | the `list:settings` row `record:setting:train-and-evaluate-a-writing-voice-classifier~<scope_kind>~<scope_id>`: the row's request carries it in `settings_record` as `records:read` gave it, read with `tools/settings` `setting()`; the command takes the file of that record (`--settings-record <file>`), or `--endpoint` | The classifier's `/v1/systemone` address. Its `/health` must name a serving identity, and every reply must name the same one and the requested model. |
| `model` | the same row, or `--model` | The model asked, as its replies name it. |
| `attempts`, `workers` | the same row (optional), or `--single-attempt`, `--workers` | Tries per request (3) and requests at once (4, at most 8). |
| `model`, `ready` | exact `record` addresses | The selected model row gives `classifier`, `weights` (a prepared local folder or pinned Hugging Face revision), `frame`, `device` and `lora_targets`. Its `classifier-ready` row binds the exact file manifest. The existing model owner resolves the cached snapshot without downloads and every file is rechecked before compute. |
| `dataset` | exact `record` address and three `namespace-file` inputs | Training: the dataset row binds private train JSONL, source-bound provenance and source challenge by BLAKE3 identity. Source families must stay in one split, with separate train and eval families. |
| `settings` | exact `record` address | Training hyperparameters (`rank`, `epochs`, `lr`, `batch`, optional `max_steps`, `seed` and `lora_dropout`). |
| `common_dir`, `model_owner_dir`, `model_config` | `--common-dir`, `--model-owner-dir`, `--model-config` | Native train/score commands use the same shared helper and model identity owner as ordinary runs. The private config projects exact model, ready and dataset identities; a receipt never supplies an old host path as authority. |
| `decider_dir`, `tokenizer_model_dir` | `--decider-dir`, `--tokenizer-model-dir` | Packing only: the decider prompt package and its tokenizer. |

## What is fixed in code, and why

- A substantive decision needs more than the criterion's `diagnostic_min_probability` (0.5 when none) on the chosen option; below it the decision is `uncertain`. That is a diagnostic rule, written into every report, never a fitted threshold.
- A section heading is judged over every source-bound chunk of its section: one chunk failing fails it, all passing passes it, anything else is uncertain.
- Exposure matches need at least 16 characters after NFKC, case and whitespace folding, on Unicode word boundaries; a shorter target is named unassessed.
- Packing keeps a composed request at or under 4096 tokens and packs towards 3600 by default (the serving limit of the decider).

## Run it

As the tool row (one JSON request on standard input, `{ result }` or `{ error }` on the last line):

```
echo '{"action":"validate","data":{...challenge...}}' | node do-work/evaluate-voice.mjs
echo '{"action":"evaluate","data":{...},"settings_record":{"id":"record:setting:train-and-evaluate-a-writing-voice-classifier~person~<id>","type":"record:setting","value":{...}}}' | node do-work/evaluate-voice.mjs
echo '{"training_rows":[...],"target_rows":[...]}' | python3 -I do-work/exposure_audit.py
```

As commands on the person's computer:

```
node do-work/evaluate-voice.mjs --data <challenge.json> --out <results.json> --live --settings-record <setting-record.json> [--single-attempt] [--resume]
node do-work/build-unlabeled-diagnostic.mjs --freeze <SOURCE-FREEZE.json> --criteria <v3-DATA.json> [--criterion-id <id>] --out-dir <private-dir>
python3 do-work/pack-section-chunks.py --data <v3.json> --out <packed.json> --tokenizer-model-dir <dir> --decider-dir <snapshot> [--tokens-only]
python3 do-work/train-voice-adapter.py --common-dir <shared-helper-dir> --model-owner-dir <classifier-worker-dir> --model-config <private-config.json> --data <train.jsonl> --provenance <manifest.json> --source-data <source.json> --out <new-adapter-dir>
python3 do-work/score-voice-adapter.py --common-dir <shared-helper-dir> --model-owner-dir <classifier-worker-dir> --model-config <private-config.json> --data <v3-eval.json> --adapter <adapter-dir> --out <report.json> --dataset-role <role> --training-source-data <source.json> --training-source-data-blake3 <hex> --training-provenance <manifest.json> --training-provenance-blake3 <hex>
```

## Files

The normal preparation row reads one exact private source challenge, projects only explicitly labelled training requests through `requestPlan`, and keeps the source, train JSONL, provenance and held-out evaluation files plus a dataset record. Training and scoring read their private files through the Records/Files door using exact identities. The generic engine publishes outputs and handles same-key retries. The scorer reads the original training source and provenance by their retained identities, so removing a temporary training folder does not remove the exposure audit. Native command evidence, ordinary tool execution, installation and classifier quality are separate checks.

| File | Purpose |
|---|---|
| `do-work/evaluate-voice.mjs` | `tool:evaluate-a-writing-voice-classifier` and the evaluation command: `evaluateVoice` (asks, checkpoints, summarises), `answer` (the row's actions `validate`, `plan`, `evaluate`, `check-report`), `settingsFrom` (the person's row, already read, through `tools/settings` `setting()`), `playRecordedReplies` (the stand-in classifier that plays recorded exchanges). |
| `read-data/evaluation-integrity.mjs` | Pure: `validateInput`, `requestPlan`, `validateReport` (resume and stored-report checks), `expectedDecision`, `aggregateSectionChunkResults`, `classifyWritingBlock`. The wire shape is `tools/ask-a-small-model-for-a-verdict`'s `intoBatchRequest` / `outOfBatchReply`. |
| `do-work/build-unlabeled-diagnostic.mjs` | Label-free rows from a frozen document for one criterion: applicable blocks only, each with its verified byte span and two blocks of reader context. Blocks are `tools/pin-files-by-content` `writingBlocks`; BLAKE3 is `tools/content-identity`. |
| `do-work/pack-section-chunks.py` | Packs each section's ordered blocks into chunks under the token limit, sized by the pinned tokenizer and prompt builder; sends nothing. |
| `do-work/exposure_audit.py` | `tool:audit-what-a-voice-classifier-was-trained-on`: `audit_exposure` and its command. |
| `do-work/train-voice-adapter.py` | `tool:train-a-writing-voice-adapter` (on the person's computer): row and provenance checks, then LoRA training and a receipt. |
| `do-work/score-voice-adapter.py` | `tool:score-writing-with-a-voice-adapter` (on the person's computer): admission, receipt binding, scoring, summaries and the exposure audit. |
| `ports/*.json` | One port contract for each file above (SOURCE_FIRST_PORT of the launch-video copy). |
| `tool-rows.json` | The tool declarations. Train and score pin their Python interpreter and 39 wheels; the generic program and package owners verify and stage them. The evaluate row packs `tools/ask-a-small-model-for-a-verdict` (`do-work`), `tools/settings` (`read-data`), `tools/content-identity` and `@noble/hashes`; its sample reads a made-up settings row and plays recorded replies. |
| `read-data/training-lifecycle.mjs`, `test/training-lifecycle.test.mjs` | Exact record, Files and model-snapshot bindings; the isolated Python launch adds the staged dependency root and preserves the original script arguments. Synthetic launch tests execute that path without model weights. |
| `test/evaluation-integrity.test.mjs`, `test/scoring-input-mode.test.mjs`, `test/evaluate-voice-cli.test.mjs` | The old suites (15, 5 and 5 tests), on made-up fixtures and a loopback stand-in classifier. |
| `test/tool-row.test.mjs`, `test/build-unlabeled-diagnostic.test.mjs` | New: the rows' samples, replay of recorded replies equals the recorded report, settings refusals; the unlabeled builder (it had no test). |
| `test/test_*.py`, `test/python.test.mjs` | The old Python suites (87 tests), run by the wrapper. `test/stand_in_decider.py` stands in for the decider frame (no weights) and puts a `b3sum` made from Python's `blake3` on PATH when the program is missing. |
| `test/fixtures/` | Made-up challenge sets, reports and training rows in the shapes the old runs kept. |

## Dropped, and why

- `placeReports` and `words.json`'s place-did-not-report words: the endpoint and model are settings; the classifier wire module is imported from its one home instead of a checkout named by an environment variable.
- `BOOK_VOICE_CLASSIFIER_ENDPOINT`, `BOOK_VOICE_CLASSIFIER_MODEL` (with its default model) and `BOOK_VOICE_EVAL_CONCURRENCY`: replaced by the settings row or arguments. A default model in code was a person's choice.
- The experiment folders under the old `book-voice/` (run, readback and preflight scripts bound to one person's sets) are evidence of past runs, not a job; they stay with that person's kept files.

## Dependencies

**Depends on:** Node 22+; `tools/ask-a-small-model-for-a-verdict` (the hosted classifier wire), `tools/settings` (the settings row), `tools/content-identity` and `@noble/hashes` (BLAKE3), `tools/records-door` (exact records and file inputs), `tools/pin-files-by-content` (`writingBlocks`, for the unlabeled builder). The train and score rows declare Python 3.12.16 and all 39 wheels by official URL and verified payload BLAKE3. The generic engine stages the wheels at the private `python-dependencies` root; the Node helper starts `python3.12 -I -B`, adds that root and executes the original script with its original arguments. An ordinary contained run imported Torch 2.8.0, PEFT 0.21.2, Transformers 5.19.0 and BLAKE3 under that interpreter and checked all 39 distribution versions. Training and scoring use the person's pinned Decider snapshot, `b3sum` and the shared `common.py` frame/model owner. Native command dependencies remain listed in `requirements-training.txt`.

**Depended on by:** the person's writing gate (a book export checks its voice through the evaluation report).
