# file-spoken-moments-into-topic-buckets

A script a person's AI runs on the person's own computer. It cuts word-timed transcripts into moments, asks a model that runs on the same computer (Ollama) which topic buckets each moment belongs to and how far it stands alone as a usable idea, claim, story or lesson, and counts the result. Nothing leaves the computer and nothing is paid for.

The buckets are the person's own: the vocabulary starts empty, or from the person's file, and grows as the model proposes new buckets.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:file-spoken-moments-into-topic-buckets`: `on-your-computer`, with the commands that fetch it and run it. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/bucket_moments.py` | The command: `tag`, `tag-moments`, `report`. Each prints its account and a last line `{"result": ...}`. |
| `read-data/moments.py` | Pure: cutting a transcript into moments, reading the model's reply, counting. |
| `read-data/bucketing-defaults.json` | DATA: the words the model is given. It names no buckets. Replace it with `--defaults FILE`. |
| `test/bucket-moments.test.mjs` | Runs every command against a stand-in for Ollama on synthetic transcripts. |
| `test/test_moments.py` | The pure parts. |
| `test/fake_ollama.py`, `test/write_fixtures.py` | The stand-in model and the synthetic inputs. |

## How to run it

```
brew install ollama && ollama pull qwen2.5:14b-instruct
python3 do-work/bucket_moments.py tag --transcripts ./transcripts
python3 do-work/bucket_moments.py report --transcripts ./transcripts
python3 do-work/bucket_moments.py tag-moments --moments ./moments.jsonl --tagged ./moments-tagged.jsonl
```

`<name>.words.json` transcripts are those the `transcribe-recordings-and-repair-whisper-loops` tool writes: `segments` with `text`, `start`, `end`. A transcript with no `segments` is named and left alone.

Options: `--vocabulary FILE` (default `<transcripts>/buckets.json`, or `<tagged>.buckets.json`), `--defaults FILE`, `--model` (default `qwen2.5:14b-instruct` for `tag`, `gemma3:4b` for `tag-moments`), `--ollama-url`, `--batch N` (moments asked at once, default 8), `--limit N` (with `--dry-out` only), `--clips NAME ...`, `--dry-out FILE` (append the moments to FILE, writing nothing into the transcripts, and tag again even if tagged), `--gap` (seconds of silence that end a moment, default 4), `--max-words` (default 120).

## What it does

1. **Cut.** A new moment starts after a silence longer than `--gap` seconds or past `--max-words` words.
2. **Ask.** The model gets the vocabulary and up to 8 moments and answers, for each, 0 to 3 bucket slugs and a relevance from 0 to 1, judging only from the moment's own words. A relevance under 0.15 empties the buckets. A new bucket the model proposes joins the vocabulary with origin `model` (a bucket from the person's file or defaults keeps origin `seed` or whatever it had). A moment the reply leaves out is asked about again alone.
3. **Write.** `tag` writes `moments` and, on each segment, `moment`, `buckets` and `relevance` into the transcript, and the vocabulary back to its file. `tag-moments` appends each tagged moment to the tagged file as its batch finishes and skips ids already there, so a stopped run continues.
4. **Report.** Moments per bucket (most used first, with the bucket's description) and per band: `usable >=0.5`, `low 0.15-0.5`, `irrelevant <0.15`.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| vocabulary file | `{ note, buckets: { slug: { description, origin } } }` | The person's buckets; edit it by hand. |
| `moments_of` | `(doc, gap, max_words) => [moment]` | The cut. |
| `apply_reply` | `(vocabulary, batch, reply)` | Writes the model's answer onto the moments. |
| `count_buckets` | `(moments, vocabulary) => { moments, untagged, bands, per_bucket }` | The report. |

## Dependencies

**Depends on:** Python 3.10 or later and its standard library; [Ollama](https://ollama.com) running on the same computer with the model pulled.

**Depended on by:** `tool-rows.json` (`tool:file-spoken-moments-into-topic-buckets`), run on the person's computer by their AI.
