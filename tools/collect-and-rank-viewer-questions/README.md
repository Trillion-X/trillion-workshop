# collect-and-rank-viewer-questions

Scripts a person's AI runs on the person's own computer. They find the real questions people ask in the forums and video comments the person's audience reads, sort them into the person's own buckets, measure how often each question recurs, and find the moments of the person's own recordings that answer each one. A question is always the asker's sentence word for word, with the link to where it was said; nothing is rewritten or invented. Nothing leaves the computer and nothing is paid for.

Nothing about any person, show, audience or drive is in this folder. The buckets and their codes, the asker lines the person chose, the inferred questions, how each research package is read, the reach rules and the words of the library are the person's settings row `record:setting:collect-and-rank-viewer-questions~<scope_kind>~<scope_id>` in their `list:settings`, read through `tools/settings` from a file holding the row as the door read it (`tool:read-a-tool-setting` reads it). A file of the settings themselves is read too. Their picks are their own file. What a run makes (the questions, with their frequency and answers) goes back as rows of their library.

Fetching is not here: forum posts are `tool:keep-forum-posts-from-a-public-archive` and video comments are `tool:keep-channels-latest-videos-and-captions` (a seed may be one video's own link), both in `tools/research-a-creator-or-topic`.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:collect-and-rank-viewer-questions`: `on-your-computer`, with the commands that fetch it and run it. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/candidates.py` | Question sentences out of `<dir>/forum-posts.jsonl` (or `raw/reddit.jsonl`), `youtube-comments/*.info.json` (or `raw/youtube-comments/`) and the channel harvest's `comments.jsonl`, as a TSV: id, kind, link, segment, score, question. |
| `do-work/rank.py` | The first reading order: each candidate in the settings' bucket (`buckets`, `{name: [regex]}`) whose patterns hit it most, the top N of each. |
| `do-work/embed_moments.py` | The person's moments from word-timed transcripts (cut at sentence ends, Whisper loops dropped) and an optional moments table, with their bge-small vectors. |
| `do-work/build_library.py` | `questions.json` from the picks: frequency in the sample (similar sentences at 0.82, plus score or likes), the answer moments (nearest 40 by meaning, re-ranked by the cross-encoder, kept at 0.25, 3 a question), each moment's nearest bucket. Settings: `bucket_codes`, `kinds`, `asker_overrides`, `inferred`, `inferred_file`, `inferred_segment`, `comment_segment`, `basis`, `note`, `buckets_note`, `moment_buckets`, `moment_bucket_field`. |
| `do-work/rematch.py` | Matches every question again against the own moments plus an archive's tagged moments (as tools/file-spoken-moments-into-topic-buckets tags them), kept at `keep` (0.5), each with its reach and origin by the settings (`recordings_reach`, `reach_rules`, `recordings_origin`, `archive_origin`, `cuttable`). |
| `do-work/add_package_questions.py` | Adds a research package's new questions, read the way the settings' `packages` say; a researcher's hypothesis is never a viewer's words. |
| `do-work/apply_gate.py` | Every asker line through `tool:check-copy` (tools/check-against-a-persons-rules-and-verdicts) with the person's rules, each verdict written back as `asker_line_gate`; or through a gate program of the older command line. |
| `do-work/remap_picks.py` | Keeps the picks and asker overrides on their questions after the candidates are found again. |
| `do-work/reports.py` | The views: `shortlist`, `answers`, `review`, `top30`, `brief`, `comments`, `vectors`. |
| `ports/*.json` | The port contracts: each script's first commit here was the byte copy of its old script (names redacted), then adapted. |
| `test/viewer-questions.test.mjs` | Every script run for real on made-up files, with the settings as a made-up list:settings row and stand-in models; `apply_gate` runs tool:check-copy for real. |
| `test/stand-in/` | Stand-ins for `sentence_transformers` (vectors that count words, a cross-encoder that scores shared words), `torch` (`nn.Sigmoid`, `from_numpy`) and a gate program of the older command line. |

## How to run it

```
python3 -m pip install sentence-transformers numpy
python3 do-work/candidates.py DIR DIR/raw/candidates.tsv
python3 do-work/rank.py setting.json DIR/raw/candidates.tsv 40 DIR/raw/ranked.tsv
python3 do-work/embed_moments.py TRANSCRIPTS moments.tsv DIR/raw/moments
python3 do-work/build_library.py DIR picks.txt setting.json
python3 do-work/rematch.py DIR archive-moments-tagged.jsonl setting.json
python3 do-work/add_package_questions.py DIR/questions.json package.json NAME setting.json
python3 do-work/apply_gate.py DIR/questions.json copy-rules-request.json
python3 do-work/reports.py shortlist DIR/questions.json
```

Each prints what it did on standard error (the reports print their lines) and a last line `{"result": ...}`, or `{"error": ...}` saying what to fix (exit 2).

## What was not carried

- `fetch_reddit.py` and `fetch_youtube_comments.sh` moved to `tools/research-a-creator-or-topic` (see above).
- The old `check_vectors.py`, `peek_comments.py`, `answers_report.py`, `brief.py`, `review.py`, `shortlist.py` and `top30.py` are the views of `reports.py`.

## Dependencies

- Python 3.10 or later; `tools/settings/read-data/settings.py` in the same clone.
- `embed_moments`, `build_library`, `rematch` and `reports vectors`: numpy and sentence-transformers (Apache-2.0), with the models BAAI/bge-small-en-v1.5 and BAAI/bge-reranker-v2-m3 (MIT), fetched once into the Hugging Face cache.
- `apply_gate`: node, and tool:check-copy in the same clone.
