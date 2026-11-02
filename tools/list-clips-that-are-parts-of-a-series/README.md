# list-clips-that-are-parts-of-a-series

A script a person's AI runs on the person's own computer. From a person's clips, transcribed and cut into spoken moments, it lists every clip whose own words say it is "part <n>" of a series, early in the clip.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:list-clips-that-are-parts-of-a-series`: `on-your-computer`, with the command that runs it. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/series_parts.py` | The command. Prints one tab-separated line per clip (or writes them to `--out`); the last line printed is `{"result": ...}` or `{"error": ...}`. |
| `test/test_series_parts.py` | Runs the command on made-up clips: joining moments across files and out of order, the match rules, `--within`, `--out`, refusals. |
| `test/series-parts.test.mjs` | Checks the row and runs the Python tests; skips, saying why, without python3. |

## How to run it

```
python3 -I tools/list-clips-that-are-parts-of-a-series/do-work/series_parts.py moments-a.jsonl moments-b.jsonl
python3 -I tools/list-clips-that-are-parts-of-a-series/do-work/series_parts.py moments.jsonl --within 500 --out parts.tsv
```

A moments file holds one JSON row per spoken moment: `id` (`<clip>#<n>`; `n` orders the clip's moments), `text`, and the clip's `identity` (or `name`), `path` (or `source_file`) and `source`. A clip qualifies when its joined text says `part <n>` (digits, or one to fifteen in words, any case) within its first `--within` characters (300 by default). Each line is `name, path, source, part <n>, whole text`, ordered by path.

## Tests

```
node --test tools/list-clips-that-are-parts-of-a-series/test/*.test.mjs
```
