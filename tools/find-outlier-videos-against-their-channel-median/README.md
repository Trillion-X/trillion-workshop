# find-outlier-videos-against-their-channel-median

A script a person's AI runs on the person's own computer. From a table of many channels' videos it writes the outliers: the titled videos that got at least 5 times their own source's median views and at least 10,000 views. It judges each video against its own channel's usual, so a small channel's breakout counts as much as a big one's.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:find-outlier-videos-against-their-channel-median`: `on-your-computer`, with the command that runs it. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/find_outliers.py` | The command. Writes the outliers table; the last line printed is `{"result": ...}` or `{"error": ...}`. |
| `test/test_find_outliers.py` | Runs the command on made-up channels: the rule, the thresholds, columns by name, refusals. |
| `test/find-outliers.test.mjs` | Checks the row and runs the Python tests; skips, saying why, without python3. |

## How to run it

```
python3 -I tools/find-outlier-videos-against-their-channel-median/do-work/find_outliers.py videos.tsv outliers.tsv
python3 -I tools/find-outlier-videos-against-their-channel-median/do-work/find_outliers.py videos.tsv outliers.tsv \
  --min-ratio 3 --min-views 5000 --views-col view_count --title-col title
```

The input is tab-separated with one header line. By default its columns are: 0 source, 1 kind, 3 url, 4 views, 6 channel, 7 title. Each `--source-col`, `--kind-col`, `--url-col`, `--views-col`, `--channel-col` and `--title-col` takes a column number (0 is the first) or a header name.

A source's median counts every titled row of that source whose views are a whole number. The output columns are `ratio, views, kind, channel, source, median, n, url, title`, in the input's order; `n` is how many videos the median counts.

## Tests

```
node --test tools/find-outlier-videos-against-their-channel-median/test/*.test.mjs
```
