# cite-principles-from-captions

A script a person's AI runs on the person's own computer. It keeps the principles people state or show in captioned videos, each with the exact words and the second they are said, proves every quote is really in the captions, and ranks each principle by how many independent channels back it and how well their videos did. With a chat model on the same computer (or any OpenAI-compatible one the person names) it also reads every part of every video and writes the rows the person asks for, from any domain, each quote put back onto the exact caption words and seconds it came from.

What the principles are about, how advice sounds, what rows a model is asked for and how they are shaped, and how rows group and name their stages are the person's own files, passed in at run time. The tool holds none of them.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:cite-principles-from-captions`: `on-your-computer`, with the command that fetches and runs it. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/cite_principles.py` | The command: `corpus`, `coverage`, `candidates`, `extract`, `find`, `verify`, `registry`. Each prints its account and a last line `{"result": ...}`. `verify` and `find` exit 1 (2 for a video with no captions) when a quote is not found. |
| `read-data/captions.py` | Pure readers: caption files to timed lines, exact-quote search, how a video did against its channel's usual, scoring of passages, evidence strength. |
| `read-data/registry.py` | Pure: merges working rows into the ranked registry. |
| `read-data/extraction.py` | Pure: cuts videos into the parts a model reads (short videos packed together), fills the person's prompt, reads the model's reply, and places each quote on the caption words it came from. |
| `test/cite-principles.test.mjs` | Runs every command on synthetic captions made here. |
| `test/test_captions.py`, `test/test_extraction.py` | The pure readers. |
| `test/fake_chat.py` | A stand-in OpenAI-compatible chat server for the `extract` test. |
| `test/make_fixture.py`, `test/write_json.py` | Make the synthetic inputs. |

## How to run it

A captions folder holds, per video, `<id>.info.json` and `<id>.en.json3` (for example saved with `yt-dlp --write-subs --write-auto-subs --write-info-json --skip-download`).

```
python3 do-work/cite_principles.py corpus --captions ./captions --views-table ./views.tsv --out ./work/corpus.jsonl
python3 do-work/cite_principles.py candidates --corpus ./work/corpus.jsonl --terms ./terms.json --out ./work/candidates
python3 do-work/cite_principles.py verify --corpus ./work/corpus.jsonl --rows './work/rows/*.jsonl'
python3 do-work/cite_principles.py registry --corpus ./work/corpus.jsonl --rows './work/rows/*.jsonl' --out ./principles.jsonl --merge ./merge.json --lanes ./lanes.json
```

Every part of every video, read by a model:

```
python3 do-work/cite_principles.py corpus --captions ./captions --transcripts ./transcripts --infos ./infos --out ./work/corpus.jsonl
python3 do-work/cite_principles.py coverage --corpus ./work/corpus.jsonl --rows './principles.jsonl' --out ./work/coverage.json
python3 do-work/cite_principles.py extract --corpus ./work/corpus.jsonl --asks ./asks.json --model ./model.json --out ./rows --channels 'Channel One' --max-load 80
python3 do-work/cite_principles.py verify --corpus ./work/corpus.jsonl --rows './rows/*.jsonl'
```

The person's files:

| File | Shape |
|------|-------|
| `views.tsv` | A header line `channel`, `kind` (`short` or `video`), `views`, then one video per line. Optional: without it each channel's usual is the median of its videos in the folder. |
| `terms.json` | `{ "topic": "word\|word", "title": "word\|word", "advice": ["phrase", ...] }`: what the principles are about (regular-expression parts), which titles are about it, and how advice sounds in the speakers' words. |
| rows | JSON lines: `id`, `principle`, `kind` (`stated`, `demonstrated`, `stated+demonstrated`), `lanes`, `sources` `[{video, t, quote}]`, `demonstrated_in` `[{video, t, how}]`, `test`, `do_it`, `transfer`, and optionally `paraphrase` and `contradicts` `[{id_or_text, how}]`. |
| `merge.json` | `{ "groups": [{ "ids": [...], "text": "wording of the merged principle" }], "contradictions": [[id, id, "how"]], "recorded_by": "..." }`. A row in no group stands alone. |
| `lanes.json` | `{ "stages": { "stage name": ["lane", ...] }, "lane_names": { "lane": "canonical lane" } }`. |
| transcripts | `<id>.json` with `segments` `[{start, text}]` or `words` `[{text, start, type}]` (`type` `word` or `spacing`), and `<id>.info.json` beside it or in an `--infos` folder. Words become lines that end at a sentence's end or after 12 words. |
| caption lines | `--caption-lines FILE ...`: one video per line, `{ video_id, url, status, lines: [[second, words]], info }` (a harvester's `captions.jsonl`). The lines are kept as they are; `info` gives the video's details; a video whose `status` is not `ready` counts as without captions. |
| `asks.json` | `system` (what to ask for), `user` (`{parts}` and `{parts_count}` are filled), `part_header` (filled per part from the video's fields: `{part}`, `{channel}`, `{title}`, `{from_second}`, `{desc}`, ...), `reply_schema` (a JSON Schema the server holds the answer to, when it can), `rows_key`, `part_field`, `quote_field`; optionally `drop_when` (`{field: [values]}`: a row whose field holds one of the values is set aside, with the reason, before its quote is looked for), `carried_by_quote` (`{field, words, ignore?, neighbour_lines?, least_words?, also_in?}`: every match of the `words` pattern in the row's `field` (numbers and names, say; a capital that starts a sentence is not a match) must be in the quote or in the video fields `also_in` names; one said only on the caption lines beside the quote makes the shortest run of words there holding it the quote, at least `least_words` long; one said nowhere near sets the row aside with the missing words), `guest_from` (`[{field, pattern}]`, a named group `name`: the guest a video's own fields name, first match wins, else null), `chunk_words` (default 1500), `quote_most_words` (25), `quote_match_at_least` (0.8), `description_chars` (400), `name`. Every other field of a reply row is the person's and is kept as it is. |
| `model.json` | `{ "url": "http://127.0.0.1:11434/v1", "model": "...", "key_env"?: "VARIABLE", "max_tokens"?, "body"?: { more request fields } }`: any OpenAI-compatible chat server (Ollama, llama.cpp, MLX, LM Studio, a rented one). |

`extract` options: `--channels` (only these, in this order), `--videos FILE` (ids in reading order), `--limit N` (videos this run), `--chunk-words`, `--concurrency N` (requests in flight; a server with several slots or batching answers them together), `--max-load L` (wait before each request while the one-minute load average is above L), `--attempts` (answers that cannot be read, or that the server refuses, before the video is left for the next run), `--retry-seconds`, `--wait-for-model` (seconds to keep waiting, without spending an attempt, for a server that cannot be reached, default 1800), `--report-every`.

Options: `candidates --caps FILE` (`{channel: most passages to keep}`), `--window-seconds`, `--per-video`, `--opening-seconds`, `--openings-per-channel`, `--openings-per-large-channel`; `verify --caption-files GLOB` (json3 files for videos not in the corpus; `{video}` is the video id); `registry --id-map FILE`, `--url-template`.

## What it does

1. **Corpus.** One line per video that has captions: channel, title, views, kind, the captions as `[second, text]` lines and `xmed`, the video's views divided by its channel's usual views for that kind (the median from the views table, else from the folder).
2. **Candidates.** Each video is cut into windows of 40 seconds. A window scores 1.5 for each distinct topic word (first six letters), 1 for each advice phrase, 1.5 when the title matches, and 0.7 times log2 of `xmed`. A window under 25 words is dropped. Each channel keeps its best windows (3 per video; at most `3 x videos`, or `min(220, 25 + 0.12 x videos)` for more than 8 videos, unless `--caps` names it) and the first 45 seconds of its best videos by `xmed`.
3. **Verify.** A quote must be an exact substring of the video's captions after case, runs of white space and curly apostrophes are folded. `BAD` is a quote that is not said; `MISSING` is a video with no captions (never taken for a wrong quote); `TOFF` is a quote said more than 3 seconds from the row's `t`.
4. **Coverage.** Per platform and channel: videos, shorts, words, and how many videos the given rows already cite (a row's `video`, `sources[].video` or `demonstrated_in[].video`).
5. **Extract.** Each channel's videos are cut at caption lines into parts of at most `chunk_words` words; consecutive short parts are packed into one request, each under its own header. The model answers rows naming their part. Each row's quote is matched to the caption words of its part (case, punctuation and apostrophes ignored): an exact run, else the window holding the most of its words in order when at least `quote_match_at_least` of them are there. The kept quote is the caption's own words over that span, cut to `quote_most_words`, with `t` (its first line's start) and `t_end` (the start of the line after its last, else the video's end) and `quote_match`. A row whose quote is not in its part goes to `dropped.jsonl` with the reason. Rows are written per channel to `<channel>.jsonl` as `{id, ...the reply row's fields, extracted_by, asks, sources: [{video, platform, channel, guest, title, t, t_end, quote, quote_match, requoted?}]}`, `id` = `<video>@<t>#<n>`. A video is written whole when its last part is answered, with one line in `done.jsonl` (rows, dropped, tokens, seconds, model); a part that fails every attempt keeps all that video's rows back (its failed answers go to `failed.jsonl`), and the next run asks for that video again and skips every finished one, so a stop loses only the videos in flight.
6. **Registry.** Working rows in one group become one principle: sources and demonstrations without repeats, lanes in first-seen order, kind from the union. Evidence strength is the sum over independent channels of the best of `log2(1 + min(xmed, 64))`, halved when the quote only demonstrates the principle, so more channels and better-performing videos raise it and one outlier cannot. Principles are ranked by strength, then quotes, and numbered `P-001`. A row's `contradicts` that names other working ids becomes links to their principles; contradictions from `merge.json` are added both ways.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------------|
| `CaptionText` | `(segs).second_of(quote) => second \| None` | The exact-quote search. |
| `passages` | `(video, craft, advice, title_pattern, window, per_video) => [passage]` | The best windows of one video. |
| `evidence_strength` | `([(channel, xmed, weight)]) => (strength, {channel: best})` | The evidence rule. |
| `build_registry` | `(rows, corpus, stages, lane_names, groups, contradictions, recorded_by, url_template) => (principles, id map)` | The merge. |
| `place_quote` | `(Captions, quote, within, at_least, most_words) => {quote, t, t_end, match} \| None` | Puts a model's quote on the caption words it came from. |
| `parts_of` | `(videos, most_words) => [[part]]` | The parts a model reads, short videos packed together. |
| `rows_of_reply` | `(asks, chunk, videos, captions_of, reply, base) => (kept, dropped)` | A reply's rows, each with its placed source. |

## Dependencies

**Depends on:** Python 3.10 or later and its standard library. Only `extract` sends anything: each part's words go to the chat model the person's `model.json` names (on their own computer when its url is local); a key, when needed, is read from the environment variable it names and never written down.

**Depended on by:** `tool-rows.json` (`tool:cite-principles-from-captions`), run on the person's computer by their AI.
