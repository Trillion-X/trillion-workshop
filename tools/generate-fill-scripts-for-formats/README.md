# generate-fill-scripts-for-formats

Fills every video format's script template with every capability of a product: one draft page per format and capability, with each filled line's words counted against the format's measured budget, the shots, the filming notes, and every fact the script cannot know yet listed as an open hole with what would fill it. An index page puts every fill in one matrix.

The formats, their lines and budgets, the capabilities' words, the page layout and the index's words are the person's own DATA, given in the request or read from their list rows; their page layout and over-budget rule are a row of their `list:settings`, read through `tools/settings`. The tool holds none of them: it fills templates and counts words. It invents nothing.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:generate-fill-scripts-for-formats`, a `small-container` run: the request on standard input, the answer as the last line. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/generate_fills.py` | The command. `--request FILE` (or standard input), or `--records FILE ... --batch ID` for exported list rows; `--out DIR` also writes every page under DIR; `--rows-out FILE --batch NAME` writes the rows that hold the request; `--settings-record FILE` reads the person's settings row from a file. |
| `read-data/fill_text.py` | Pure: the template language, the two word counts, holes, one filled page, the index page, and the check that says what a request lacks. |
| `read-data/fill_records.py` | Pure: a request put together from the person's list rows of one batch, and the rows that hold a request. |
| `test/test_fill_text.py` | Every template form, both counts, holes, over-budget lines, pages, the index, rows, the settings row and the command, on a made-up tea shop. |
| `test/sample-request.json` | The made-up tea shop's request. |
| `test/generate-fill-scripts-for-formats.test.mjs` | Runs the Python tests under `npm test`. |

## How to run it

```
python3 -I do-work/generate_fills.py --request request.json --out ./fills
python3 -I do-work/generate_fills.py --records library-fill-rows.json --batch fill-batch-first --settings-record setting.json --out ./fills
python3 -I do-work/generate_fills.py --request request.json --rows-out rows.json --batch first
```

The second form reads rows exported from the person's account, for example with `tools/export-records-as-list-rows/do-work/send_record_write.py export --type record:library --prefix record:library:fill-` (and `--prefix record:library:catalog-listing-` for the listings).

## The request

| Key | Holds |
|-----|-------|
| `settings` | `fill_page`: the page layout, a list of templates (below); `over_budget`: `{ ratio, min_words }`, a line is over when its words exceed budget x ratio by at least min_words; `standard_holes`: hole rows every page lists (templates); any other value the layout names as `{settings.<name>}`. |
| `formats` | Each `{ id, template, ... }`; any other field (`short`, `name`, `path`, `measured`) is read by the layout as `{format.<field>}`. |
| `capabilities` | Each `{ key, id, ... }`: `key` names the page, `id` its listing; every other field is the person's words, read as `{cap.<field>}`. |
| `listings` | `{ <capability id>: { file, listing } }`: the saved catalog listing (`title`, `job`, `steps`, `about`), read as `{listing.<field>}`, and where it was saved, `{listing_file}`. |
| `settings_record` | Optional. The person's settings row (below); it gives every setting `settings` leaves out. |
| `settings_scopes` | Optional. Which settings row: `[[scope_kind, scope_id], ...]`, most specific first; default `[["account", "main"]]`. |
| `index` | Optional. `file`, `page` (templates), `matrix: { row, column, cell }` (templates over a capability, a format, and a fill's `words`, `budget`, `file`), `buckets` (rows read by the page; a bucket's `count_from` names its count in `counts`). |

A format's `template`:

| Key | Holds |
|-----|-------|
| `lines` | `[{ no, slot, text, budget, secs }]`: `text` is a template; `budget` the format's measured words; `secs` its measured time, printed as given. |
| `slots` | `[{ slot, time, line, picture, made }]`: `picture` is a template. |
| `shoot`, `reuse` | Lists of templates: the filming changes, and the footage shared across fills. |
| `extra` | Optional note template, printed after the totals; its holes are listed as `note`. |
| `values` | `{ name: template }`, worked out in order before the lines and read as `{v.<name>}`. |
| `count` | `words` (every word, a hole counting as its n; the default) or `quoted-words` (only words inside double quotes plus holes outside them: on-screen text). |
| `others` | `{ present_first, limit }`: the batch's other capabilities, those holding the named field first, read as `others` (each `{ cap, listing }`). |
| `time_label` | The heading of the time column, read as `{format.template.time_label}`. |

What the layout can read about the fill: `fill.line_rows`, `fill.slot_rows`, `fill.shoot_items`, `fill.reuse_items`, `fill.hole_rows` (lists of table rows or bullets), `fill.words`, `fill.budget`, `fill.pct` (signed, no decimals), `fill.over` (`L2, L5` or nothing) and `fill.extra`. The index reads `formats`, `capabilities`, `buckets`, `index.matrix_header`, `index.matrix_rule`, `index.matrix_rows` and `index.bucket_total`.

### Templates

| Form | Gives |
|------|-------|
| `"text with {dotted.path}"` | The text, each path filled (a number indexes a list). A path that holds nothing is refused by name. |
| `{ "if": PATH, "then": T, "else": T }` | `then` when the path holds a non-empty value, else `else` (nothing when there is none). |
| `{ "each": PATH, "as": NAME, "item": T, "sep": TEXT, "empty": T }` | `item` for each element, named NAME; joined with `sep`, or a list of lines without it; `empty` for an empty list. |
| `{ "replace": T, "old": TEXT, "new": TEXT }` | Every `old` replaced. |
| `{ "after": T, "sep": TEXT }` | What follows the first `sep`. |
| `{ "concat": [T, ...] }` | The texts one after another. |

A hole, `<<n|label|what fills it>>`, shows as `[label]`, counts as n words, and is listed once per place (`line 2`, `slot 3`, `note`).

## The person's rows

In a list whose rows have `kind` and `detail` (for example a generic library list), a batch is: one `fill-batch` row (`{ settings, index?, formats: [row ids], capabilities: [row ids] }`, which also gives the order), one `fill-format` row per format, one `fill-capability` row per capability, and one `catalog-listing` row per listing (its capability id in `catalog_id`). Each row's object is JSON text in `detail`. `--rows-out FILE --batch NAME` writes a request as these rows (`{ rows: [{ id, value: { kind, title, detail, catalog_id? } }] }`, ids `<kind>-<name>`, which a list loader puts after the row type), ready for a loader to put into the list; filling those rows gives the same pages.

## The person's settings row

The settings a person keeps for every batch (their page layout `fill_page`, `over_budget`, `standard_holes`, and values the layout names such as a listing address) are one row of their generic list `list:settings`: `record:setting:generate-fill-scripts-for-formats~<scope_kind>~<scope_id>` (usually `account~main`), its `settings` field the JSON of those keys. Pass it as `settings_record` (as `records:read` gives it, or a list of rows with `settings_scopes` to pick one); it is read with `tools/settings/read-data/settings.py`, which refuses a retired row or one written for another tool. The request's own `settings`, or the batch row's, are laid over it key by key, so a batch row keeps only what is its own (for example when its catalog was fetched). With `--rows-out` and a settings row, a setting the row already gives with the same value is left out of the batch row.

## The answer

`{ fills: [{ format, capability, file, words, budget, holes, text }], count, index?: { file, text } }`; with `--out`, `text` is written to `path` instead. A request that lacks something is refused with one line `{ "error": ... }` saying what to give, exit 2.

## Dependencies

**Depends on:** Python 3.10+ standard library, and `tools/settings/read-data/settings.py` (packed by the row at `/opt/settings`) to read the settings row.

**Depended on by:** nothing in this repository.
