# file-spoken-moments-into-topic-buckets

A script a person's AI runs on the person's own computer. It cuts word-timed transcripts into moments, asks a model that runs on the same computer (Ollama) which topic buckets each moment belongs to and how far it stands alone as a usable idea, claim, story or lesson, and counts the result. Nothing leaves the computer and nothing is paid for.

The buckets are the person's own: the vocabulary starts empty, or from the person's file, and grows as the model proposes new buckets.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:file-spoken-moments-into-topic-buckets`: `on-your-computer`, with the commands that fetch it and run it. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/bucket_moments.py` | The command: `tag`, `tag-moments`, `report`. Each prints its account and a last line `{"result": ...}`. |
| `do-work/cut_text_into_moments.py` | Untimed transcript text from a cloud-results sqlite copy cut into moments of whole sentences (at most `--max-words`, 120), each placed by its share of the text and, when the length is known, in estimated seconds; its source (b2, r2 or drive-only) read from the person's file store (`--held`, the files door's answer, or `--namespace-sqlite`); identical texts kept once with the copies named in `duplicates`; the coverage (moments per source, transcripts per source and media kind, hours) in its answer. Moved from source-repo-a (`ports/cut-text-into-moments.json`). |
| `ports/` | The port contract of the moved file. |
| `cut-ideas` (in `do-work/bucket_moments.py`) | Cuts timed transcripts (`segments` with `start`/`end`) into one moment per whole idea: the local model is shown a window of numbered segments (`--window`, default 20) and names where each idea begins; a moment keeps its segments' first start, last end and words, so it can be cut from the recording. A start the model names inside a sentence moves forward to the next segment that begins one, and the idea that touches a window's edge is not cut there: the next window begins where that idea began. A window the model cannot answer is cut by silence and the moments say `"cut": "silence"` (`"model"` otherwise). Appends to `--out`, skips clips already there. Words: `idea_prompt` in `read-data/bucketing-defaults.json`. |
| `read-data/moments.py` | Pure: cutting a transcript into moments, reading the model's reply, counting. |
| `read-data/bucketing-defaults.json` | DATA: the words the model is given. It names no buckets. Replace it with `--defaults FILE`. |
| `test/bucket-moments.test.mjs` | Runs every command against a stand-in for Ollama on synthetic transcripts. |
| `test/test_moments.py` | The pure parts. |
| `test/test_cut_text.py`, `test/cut-text.test.mjs` | `cut_text_into_moments.py` on a made-up cloud-results copy and store. |
| `test/fake_ollama.py`, `test/write_fixtures.py` | The stand-in model and the synthetic inputs. |

## How to run it

```
brew install ollama && ollama pull qwen2.5:14b-instruct
python3 do-work/bucket_moments.py tag --transcripts ./transcripts
python3 do-work/bucket_moments.py report --transcripts ./transcripts
python3 do-work/cut_text_into_moments.py --results-sqlite ./cloud-results.sqlite --held ./held.json --out ./moments.jsonl
python3 do-work/bucket_moments.py tag-moments --moments ./moments.jsonl --tagged ./moments-tagged.jsonl
```

`<name>.words.json` transcripts are those the `transcribe-recordings-and-repair-whisper-loops` tool writes: `segments` with `text`, `start`, `end`. A transcript with no `segments` is named and left alone.

Options: `--vocabulary FILE` (default `<transcripts>/buckets.json`, or `<tagged>.buckets.json`), `--vocabulary-rows FILE ... --describe F,F --label F,F` (the person's own list rows instead of a vocabulary file: save each `records:list` answer to a file; every row is one bucket, keyed by the end of its id, described by its label field and its describe fields, and the model may choose only among them, so a new bucket is a new row), `--defaults FILE`, `--model` (default `qwen2.5:14b-instruct` for `tag`, `gemma3:4b` for `tag-moments`), `--ollama-url`, `--batch N` (moments asked at once, default 8), `--limit N` (with `--dry-out` only), `--clips NAME ...`, `--dry-out FILE` (append the moments to FILE, writing nothing into the transcripts, and tag again even if tagged), `--gap` (seconds of silence that end a moment, default 4), `--max-words` (default 120).

## What it does

1. **Cut.** A new moment starts after a silence longer than `--gap` seconds or past `--max-words` words.
2. **Ask.** The model gets the vocabulary and up to 8 moments and answers, for each, 0 to 3 bucket slugs and a relevance from 0 to 1, judging only from the moment's own words. A relevance under 0.15 empties the buckets. A new bucket the model proposes joins the vocabulary with origin `model` (a bucket from the person's file or defaults keeps origin `seed` or whatever it had). With `--vocabulary-rows` the vocabulary is closed: the model's new buckets and any bucket that is not a row are dropped. A moment the reply leaves out is asked about again alone; when the model refuses a request (an HTTP error, as it does when it repeats itself) its moments are asked alone, and one it still cannot answer is written untagged with relevance null.
3. **Write.** `tag` writes `moments` and, on each segment, `moment`, `buckets` and `relevance` into the transcript, and the vocabulary back to its file. `tag-moments` appends each tagged moment to the tagged file as its batch finishes and skips ids already there, so a stopped run continues.
4. **Report.** Moments per bucket (most used first, with the bucket's description) and per band: `usable >=0.5`, `low 0.15-0.5`, `irrelevant <0.15`.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| vocabulary file | `{ note, buckets: { slug: { description, origin } }, closed? }` | The person's buckets; edit it by hand. `vocabulary_from_rows` builds a closed one from list rows. |
| `moments_of` | `(doc, gap, max_words) => [moment]` | The cut. |
| `apply_reply` | `(vocabulary, batch, reply)` | Writes the model's answer onto the moments. |
| `count_buckets` | `(moments, vocabulary) => { moments, untagged, bands, per_bucket }` | The report. |

## Dependencies

**Depends on:** Python 3.10 or later and its standard library; [Ollama](https://ollama.com) running on the same computer with the model pulled.

**Depended on by:** `tool-rows.json` (`tool:file-spoken-moments-into-topic-buckets`), run on the person's computer by their AI.
