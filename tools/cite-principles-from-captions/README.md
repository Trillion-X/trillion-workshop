# cite-principles-from-captions

A script a person's AI runs on the person's own computer. It keeps the principles people state or show in captioned videos, each with the exact words and the second they are said, proves every quote is really in the captions, and ranks each principle by how many independent channels back it and how well their videos did.

What the principles are about, how advice sounds, and how rows group and name their stages are the person's own files, passed in at run time. The tool holds none of them.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:cite-principles-from-captions`: `on-your-computer`, with the command that fetches and runs it. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/cite_principles.py` | The command: `corpus`, `candidates`, `find`, `verify`, `registry`. Each prints its account and a last line `{"result": ...}`. `verify` and `find` exit 1 (2 for a video with no captions) when a quote is not found. |
| `read-data/captions.py` | Pure readers: caption files to timed lines, exact-quote search, how a video did against its channel's usual, scoring of passages, evidence strength. |
| `read-data/registry.py` | Pure: merges working rows into the ranked registry. |
| `test/cite-principles.test.mjs` | Runs every command on synthetic captions made here. |
| `test/test_captions.py` | The pure readers. |
| `test/make_fixture.py`, `test/write_json.py` | Make the synthetic inputs. |

## How to run it

A captions folder holds, per video, `<id>.info.json` and `<id>.en.json3` (for example saved with `yt-dlp --write-subs --write-auto-subs --write-info-json --skip-download`).

```
python3 do-work/cite_principles.py corpus --captions ./captions --views-table ./views.tsv --out ./work/corpus.jsonl
python3 do-work/cite_principles.py candidates --corpus ./work/corpus.jsonl --terms ./terms.json --out ./work/candidates
python3 do-work/cite_principles.py verify --corpus ./work/corpus.jsonl --rows './work/rows/*.jsonl'
python3 do-work/cite_principles.py registry --corpus ./work/corpus.jsonl --rows './work/rows/*.jsonl' --out ./principles.jsonl --merge ./merge.json --lanes ./lanes.json
```

The person's files:

| File | Shape |
|------|-------|
| `views.tsv` | A header line `channel`, `kind` (`short` or `video`), `views`, then one video per line. Optional: without it each channel's usual is the median of its videos in the folder. |
| `terms.json` | `{ "topic": "word\|word", "title": "word\|word", "advice": ["phrase", ...] }`: what the principles are about (regular-expression parts), which titles are about it, and how advice sounds in the speakers' words. |
| rows | JSON lines: `id`, `principle`, `kind` (`stated`, `demonstrated`, `stated+demonstrated`), `lanes`, `sources` `[{video, t, quote}]`, `demonstrated_in` `[{video, t, how}]`, `test`, `do_it`, `transfer`, and optionally `paraphrase` and `contradicts` `[{id_or_text, how}]`. |
| `merge.json` | `{ "groups": [{ "ids": [...], "text": "wording of the merged principle" }], "contradictions": [[id, id, "how"]], "recorded_by": "..." }`. A row in no group stands alone. |
| `lanes.json` | `{ "stages": { "stage name": ["lane", ...] }, "lane_names": { "lane": "canonical lane" } }`. |

Options: `candidates --caps FILE` (`{channel: most passages to keep}`), `--window-seconds`, `--per-video`, `--opening-seconds`, `--openings-per-channel`, `--openings-per-large-channel`; `verify --caption-files GLOB` (json3 files for videos not in the corpus; `{video}` is the video id); `registry --id-map FILE`, `--url-template`.

## What it does

1. **Corpus.** One line per video that has captions: channel, title, views, kind, the captions as `[second, text]` lines and `xmed`, the video's views divided by its channel's usual views for that kind (the median from the views table, else from the folder).
2. **Candidates.** Each video is cut into windows of 40 seconds. A window scores 1.5 for each distinct topic word (first six letters), 1 for each advice phrase, 1.5 when the title matches, and 0.7 times log2 of `xmed`. A window under 25 words is dropped. Each channel keeps its best windows (3 per video; at most `3 x videos`, or `min(220, 25 + 0.12 x videos)` for more than 8 videos, unless `--caps` names it) and the first 45 seconds of its best videos by `xmed`.
3. **Verify.** A quote must be an exact substring of the video's captions after case, runs of white space and curly apostrophes are folded. `BAD` is a quote that is not said; `MISSING` is a video with no captions (never taken for a wrong quote); `TOFF` is a quote said more than 3 seconds from the row's `t`.
4. **Registry.** Working rows in one group become one principle: sources and demonstrations without repeats, lanes in first-seen order, kind from the union. Evidence strength is the sum over independent channels of the best of `log2(1 + min(xmed, 64))`, halved when the quote only demonstrates the principle, so more channels and better-performing videos raise it and one outlier cannot. Principles are ranked by strength, then quotes, and numbered `P-001`. A row's `contradicts` that names other working ids becomes links to their principles; contradictions from `merge.json` are added both ways.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------------|
| `CaptionText` | `(segs).second_of(quote) => second \| None` | The exact-quote search. |
| `passages` | `(video, craft, advice, title_pattern, window, per_video) => [passage]` | The best windows of one video. |
| `evidence_strength` | `([(channel, xmed, weight)]) => (strength, {channel: best})` | The evidence rule. |
| `build_registry` | `(rows, corpus, stages, lane_names, groups, contradictions, recorded_by, url_template) => (principles, id map)` | The merge. |

## Dependencies

**Depends on:** Python 3.10 or later and its standard library. Nothing is sent anywhere.

**Depended on by:** `tool-rows.json` (`tool:cite-principles-from-captions`), run on the person's computer by their AI.
