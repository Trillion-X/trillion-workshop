# tools/turn-caption-quotes-into-analysis-device-rows/

Checks every caption quote a set of device rows rests on, then writes the rows as Markdown tables with the minute and second each quote is said. A device row says what a creative technique does for a viewer, how it is built and where it is seen. The tool runs on the person's own computer and holds no columns, wording or groups of its own: all of them come from the person's settings row in `list:settings`, read through `tools/settings`.

## Running it

```
python3 -I do-work/turn_quotes_into_device_rows.py --settings-record FILE [--scope piece:FAMILY] \
    --captions 'FOLDER/{video}.*json3' [--family-file FILE] [--index-file FILE] [--checked-file FILE]
```

Without the file flags it only checks. A quote is found as exact words in the video's json3 captions, ignoring case, white space and curly apostrophes; its second is the start of the caption event it begins in, cut down to the whole second. Nothing is written unless every quote is found. Exit 0 all held, 1 a quote failed (each is printed as `BAD`), 2 the request could not be used. The last line is `{"result": {...}}`.

| Output | Holds |
|---|---|
| `--family-file` | The settings' head lines, then one table per group in the settings' group order. |
| `--index-file` | An existing file; the family's tables are added once at its end, under the settings' marker line. A file that already has the marker is left alone. |
| `--checked-file` | Each row's `checked_fields` and `t`: `[video, second, quote]` per checked quote. |

## The settings

The settings are one row of the person's generic list `list:settings`: type `record:setting`, id `record:setting:turn-caption-quotes-into-analysis-device-rows~piece~<family>`, fields `name`, `tool` (`tool:turn-caption-quotes-into-analysis-device-rows`), `scope_kind`, `scope_id`, `settings` (the JSON below, as text), `from`, `status`. Its scope is a piece, the batch of rows, because the rows and the family head belong to that one batch; the next batch is its own row. `--settings-record` is a file holding the row as `records:read` gives it (or several rows; `--scope KIND:ID`, most specific first, picks one). A retired row, a row for another tool or a file with no row for the scope is refused with what to read instead.

| Key | Holds |
|---|---|
| `family`, `title`, `introduction` | The set's name and the words of the family file's head. |
| `channels` | `{video id: [channel, title]}`; a quote from a video not named here is refused. |
| `groups` | The order groups are written in. |
| `rows` | `[{group, name, seen: [[video id or null, words]], extra?, ...}]`. `null` marks unmeasured evidence, kept as text. Any other field may be named by a column. |
| `columns` | `[{head, parts: [{text, when?}]}]`. A part with `when` is kept only when that field is set. |
| `file_head` | The family file's first lines (`{title}`, `{introduction}`, `{rows}`, `{family}`). |
| `index_marker` | The line that marks the family in an index file (`{family}`). |
| `seen_quote`, `seen_join` | How one checked quote is written (`{channel}`, `{video}`, `{stamp}`, `{quote}`) and what joins the pieces of `{seen_text}`. |
| `list_join` | What joins a list field inside a cell. |
| `checked_fields` | The fields the checked-rows file keeps beside `t`. |

In a template `{field}` is the row's field or a computed one (`family`, `creators`, `items`, `seen_text`); `{field|one|many}` is `one` when the field is 1, `many` otherwise. `creators` counts the distinct channels of a row's checked quotes, `items` its distinct videos; a row with none counts 1 and 1.

## Files

| File | Purpose |
|---|---|
| `do-work/turn_quotes_into_device_rows.py` | The command: reads the settings and caption files, writes the outputs. |
| `read-data/device_rows.py` | Pure readers: exact caption starts, the quote check, the counts, cells from templates, the family file, the index addition. |
| `test/test_device_rows.py` | The pure readers on made-up rows and captions. |
| `test/turn-quotes-into-device-rows.test.mjs` | The command end to end on made-up files. |
| `tool-rows.json` | The Workshop row. |

## Moved from

`trillion-launch-video/tools/analysis-devices/build_rows.py`, where the 38 rows, the channel names, the groups, the column wording and the family head were code. They are now the person's settings row; the tool holds none of them. Given the same settings and caption files it writes the same family file, index addition and checked rows byte for byte. Old Trillion (Trillion-X/trillion, `parts/` and `src/`) has no counterpart: no caption-quote check or device table there.

## Dependencies

**Depends on:** Python 3's standard library; `tools/settings/read-data/settings.py` (reads the `list:settings` row); `tools/cite-principles-from-captions/read-data/captions.py` (its `CaptionText` exact-quote finder, given event starts that are not rounded).

**Depended on by:** the person's AI, through `tool:turn-caption-quotes-into-analysis-device-rows`.
