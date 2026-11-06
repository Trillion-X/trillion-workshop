# tools/benchmark-small-local-models/

Measures small models that run on the person's own computer (open_clip image-text models, decider-style choice classifiers and their vision kin, mlx vision-language and language models, sentence-transformers cross-encoders and embedders) on their own material, to find which model is worth wiring at all: labelling frames of their videos from their shot vocabulary, filling a script template's blanks with true, sourced phrases, ranking clips for a slot, telling a complete take from a faulted one, ranking titles, and timing a decider.

Every script is one experiment of a private film repository's small-model research, moved as it was: its first commit here is the byte copy, and the adaptation only turned its fixed paths, model names and person's words into request fields. One JSON request in (a file named as the first argument, or standard input), one JSON line out: `{ "result": ... }` or `{ "error": "what to change" }` (exit 2). `write_to` also keeps the whole answer in a file and counts it on the last line, so large answers chain from step to step as files.

## Settings

The person's paths, models, vocabulary and questions are their `list:settings` rows `record:setting:benchmark-small-local-models~<scope_kind>~<scope_id>`, read by the one shared reader `tools/settings` (`settings.setting(...)`). A request gives them as `settings_record` (the rows as `records:read` gave them, or a file of them) with `scopes` (`[[scope_kind, scope_id]]`, most specific first); the row's settings are `{ "commands": { "<script name>": { field: value } } }`, each script's defaults, and the request's own fields win. `settings` inline does the same for a sample. A request with neither is used as it is.

## Files

| File | Purpose |
|------|---------|
| `read-data/place.py` | What the computer reports (device, Hugging Face cache, a model's snapshot, a decider's load) and what every script shares: the request with its settings, `need`, `refuse`, `answer`. |
| `read-data/template_blanks.py` | A word template's speech lines with each blank as `[slot]`, and each blank's lines. Also a command. |
| `do-work/sample_shots_across_groups.py` | Up to N videos round-robin over creators, evenly spaced shots of each, seeded; reads width and height with ffprobe. |
| `do-work/cut_sample_frames.py` | Each sampled shot's frame at its middle second, by the person's frame tool. |
| `do-work/label_frames_with_image_text_model.py` | Every vocabulary value scored against each frame two ways (bare word, plain definition). |
| `do-work/label_frames_with_vision_decider.py` | One lettered question per field to a decider-vision snapshot; a two-round tournament past ten values. |
| `do-work/label_frames_with_vision_language_model.py` | One JSON answer per frame from an mlx-vlm model, with free-text phrases. |
| `do-work/rank_free_text_places.py` | Every distinct reference phrase ranked per frame: the model's own phrase embedded, and the image against "a photo of". |
| `do-work/score_frame_labels.py` | Agreement with the reference labels per field, confusions, confidence lines, the prior-centered reading and the majority baseline. Standard library only. |
| `do-work/make_candidate_pool.py` | Short phrases with a checkable source from a listing, a site's JSON, git histories, a product name and ages. |
| `do-work/rank_pool_for_blanks.py` | A cross-encoder's 12 best phrases per blank. |
| `do-work/make_typed_options.py` | Every candidate of a blank's type beside the reranker's best 6, shuffled by the blank's id. |
| `do-work/choose_fills_with_decider.py`, `judge_filled_lines_with_decider.py`, `choose_fills_with_language_model.py` | Three ways a small model chooses: one choice question, one yes/no per filled line, a number from a generative model. |
| `do-work/render_choices_as_fills.py` | The picks as a fills file for `tools/fill-a-template-without-changing-its-words`, rendered and measured for drift. |
| `do-work/sample_candidates_for_slots.py`, `cut_candidate_frames.py` | Candidates of the right kind for each described slot, one per video, and their frames. |
| `do-work/rank_candidate_frames.py` | Each slot's candidates ranked five ways, with the agreement with a reference ranking. |
| `do-work/check_takes_with_decider.py` | Takes from real transcript sentences, as said or with one fault, asked of a decider; labels by construction. |
| `do-work/rank_titles_with_decider.py` | Titles ranked by P(yes) to the person's question. |
| `do-work/time_a_decider.py` | A decider's load time, time per answer and memory. |
| `ports/*.json` | One port contract per script: the source it was copied from, what it keeps and what changed. |
| `tool-rows.json` | Eight rows, all run on the person's computer. |
| `test/test_benchmark.py`, `test/benchmark-small-local-models.test.mjs` | Every script on made-up inputs with stand-in models (`test/stubs`, `test/stand-in-decider`) and stand-in ffprobe and frame tool (`test/stand-in-programs`). |

## Dependencies

**Depends on:** Python 3; `tools/settings` (the settings reader); `tools/fill-a-template-without-changing-its-words` (render); per step torch, Pillow, open_clip_torch, sentence-transformers, mlx, mlx-lm or mlx-vlm and the model in the Hugging Face cache; ffprobe, git and a frame tool for the sampling and pool steps.

**Depended on by:** the rows in `tool-rows.json`.
