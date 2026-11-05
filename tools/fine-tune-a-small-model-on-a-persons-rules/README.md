# tools/fine-tune-a-small-model-on-a-persons-rules/

Teaches a small multiple-choice decider model (such as decider-2b) a person's laws, their writing rules, one yes-or-no question per law, and measures how much it learned on lines it never trained on. Three steps, each one JSON request in and one answer out, all run on the person's own computer:

1. **Build the rows** (`do-work/build_training_rows.py`): the train rows and the held-out test lines, split by source before any training.
2. **Train an adapter** (`do-work/train_an_adapter.py`): a LoRA adapter on the train rows, cross-entropy on the option letter, at low priority beside the person's work, stopping early when the projected run passes the time budget.
3. **Score the held-out lines** (`do-work/score_held_out_lines.py`): with and without the adapter, and a report per law of how well its question separates bad lines from good ones.

The pass and fail lines a gate uses are then fitted from those scores by `tool:fit-pass-and-fail-lines` (`tools/ask-a-small-model-for-a-verdict`), which holds each good line out in turn.

## The person's settings

Everything personal is the request or the person's settings row: the laws and their questions, the lines they ruled on, their transcript, the caption folder, the made-up lines, the held-out lines, the never-train lines, the frame a line is put in, the model, the set names, the seed, every count and every training setting. The code names no law, person, film or folder.

The settings live in the person's `list:settings` as `record:setting:fine-tune-a-small-model-on-a-persons-rules~<scope_kind>~<scope_id>` (one row per set of laws they teach, usually `account~<name of the set>`). Its `settings` hold one object per step, `build`, `train` and `score`, whose keys are that step's request keys (all but the paths on this computer). The AI reads the row (`tool:read-a-tool-setting`, or the door's `records:read`) and passes the record as `settings_record` (with several rows, `settings_scope` `[kind, id]` picks one); each step reads it with `settings.setting` of `tools/settings/read-data/settings.py` and lays the step's object under the request: a key the request gives wins, and an object both give (`spoken`, `captions`) is merged key by key. A retired row, or a settings_record with no row of this folder, is refused. The row's `tool` is `tool:build-training-rows-from-a-persons-rules`, the first step; the three steps share the row. `settings` may be given inline instead, for a test.

## How the rows are built

- **Ruled lines** (`labelled_lines`, rows `{text, sets, bad_for}`): only lines in `fail_set` or `pass_set` are kept. A line found in a markdown guide under `group_by_headings_in` is grouped by that file and the nearest heading above it; otherwise by the first law it is bad for, or by itself. Each group lands on one side by the hash of its key (`test_share` of the groups test), so the same line always lands on the same side.
- **Spoken** (`spoken`): sentences of a transcript of the person speaking (lines starting with a `hh:mm:ss` time are skipped); the first half trains, the second half tests; `per_split` are sampled from each half.
- **Captions** (`captions`): `per_video` sentences of each video's captions (a yt-dlp `.info.json` beside `.<language>.json3`), bracketed sound cues removed, split by video; `train` and `test` are sampled from each side.
- `never_train` lines and `held_out` lines are never trained on; a made-up line that is also a test, never-train or held-out line is dropped.
- For law L a line is bad when one of L's `bad_from` names is in its `bad_for`, and good when it is in one of `good_sets`. A line some law rules bad is never also a good line. A line bad only for another law is not a label for L.
- Train rows per law: the real train bad lines; the real written good lines (`pass_set`); `per_law.spoken_goods` sampled other good lines; the law's made-up rows (`synthetic` rows `{law, text, label}`, a law's short bad lines among them); `per_law.other_goods` made-up good lines of other laws (not for laws in `no_other_goods`, whose question is about the line's stakes, not its wording); and `per_law.short_goods` short good lines (made-up rows with law `*` and a kind in `short_kinds`, or `short_kinds_for[L]`), so a line is not failed for being written or being short.
- One random generator seeded with `seed` makes every sample, in this order and in the order the made-up rows are given, so the same request makes the same rows byte for byte.

## Files

| File | Purpose |
|------|---------|
| `do-work/build_training_rows.py` | Step 1: writes `items.json` (`laws`, `narrator`: the never-train lines, `items`: every real line with its side, group, sets, `bad_for`, `bad_laws`, `good`, and `synthetic_dropped_as_test_overlap`) and `train.jsonl` (`{law, question, options, text, gold, bad, source}`); prints the old summary lines, then the answer. Also `norm`, `sentences` and `side`, which step 3 shares. |
| `do-work/train_an_adapter.py` | Step 2: saves the adapter and `train-info.json`; writes the progress log beside the adapter folder. |
| `do-work/score_held_out_lines.py` | Step 3: writes `<name>.json` with the report per law (`film` is the held-out set, `narrator` the never-train lines) and every score it was made from; `scores_from` reports again from an earlier run's kept scores with no model. `auc`, `at_fpr` and `report` are pure. |
| `read-data/common.py` | The request (a file or `-` for standard input), refusals that say what to change, rows given inline or as a JSON Lines file, the person's settings under the request; and the decider model folder (its own `decider` package and `decider_config.json`), loaded with or without an adapter on the device asked for, else `DECIDER_DEVICE`, else cuda, mps or cpu, framing and scoring asks at the stored temperature. torch is imported only when a model is configured. |
| `ports/*.json` | The four port contracts: each file's first commit here is the byte copy of its old owner. |
| `tool-rows.json` | The three Workshop rows. |
| `test/test_fine_tune.py`, `test/fine-tune.test.mjs` | Building rows and reporting from kept scores on made-up laws and lines, determinism, settings rows (merged, retired, another tool's), refusals, and that each row names its script. |

## What is fixed in code, and why

- A law has two options, and the gold answer of a bad line is the law's `fail` option. That is what a yes-or-no rule is.
- The LoRA alpha is twice the rank and its dropout 0.05; the learning rate warms up over 20 steps and falls linearly to 5% of itself; gradients are clipped at 1.0. These are the decider training recipe the adapters were measured with.
- The run projects its length after 20 steps. Before that the time per step is not yet steady.
- A line is scored per sentence and takes its highest probability of failing, as the gate that uses the model does.
- Ruled lines are grouped by the guides' headings in sorted file order, so a line found in two guides is grouped the same on every computer.

## What differs from the old scripts

Moved from `trillion-launch-video/tools/decider-laws-finetune/` (build_data.py, common.py, train.py, evaluate.py; film_thresholds.py is `tool:fit-pass-and-fail-lines`).

- The laws, set names, the speaker's transcript, the caption folder, the never-trained lines, the frame, the model folder, the seed and every count were constants in the scripts; they are the request and the person's settings row now. The file names and keys written are the old ones, so a build on the same lines is the old build byte for byte.
- The guides were read in the order the file system listed them; they are read sorted now (see above).
- A training run over budget answers `{error}` with what to change, instead of exit code 3.
- A held-out set with no good lines, or a law with no good test lines, is reported as such instead of dividing by zero.

## Dependencies

**Depends on:** Python 3; `tools/settings` (`read-data/settings.py`) for `settings_record`. Training and scoring with a model also need torch, peft and transformers, and a decider model folder on disk.
