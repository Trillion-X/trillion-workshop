# tools/export-records-as-list-rows/

Turns a person's records on disk into the payloads that put rows into their Trillion lists (as list rows, or as the records `records:write` takes), and sends the batches. Records can be JSON, tab-separated files (a spreadsheet saved as text) or markdown tables. **The code knows no record kinds, columns or lists**: everything about them is in a mapping file the person writes, so the same script serves any library. It sends nothing; it writes `make_lists.json`, the rows in batches (`<source>-000.json`, ...) and `manifest.json` into a folder.

```
python3 -I do-work/export_records_as_list_rows.py --mapping FILE --root DIR --out DIR [--batch 100] [--only SOURCE] [--skip-ids FILE]
```

- `--root` is the folder the mapping's files and globs are relative to.
- `--only` makes one source. `--batch` sets the rows per file.
- `--skip-ids` is a JSON file `{ "<list id>": ["<row id>", ...] }`; those rows are left out so rows already in a list are never overwritten.
- Row ids are stable, so loading a batch twice updates its rows.
- A re-run removes only the files the previous run listed in its manifest; other files in the folder are left alone.
- Exit 0 on success, 2 with a reason on standard error when the mapping or a file could not be read.

## The mapping

`{ "new_lists": [{ "list": {...}, "facts": {...}, "why": "..." }], "sources": [source] }`. `new_lists` are written to `make_lists.json` as they are, without `why`. A source:

| Key | Holds |
|---|---|
| `name`, `list_id` | The source's name and the list its rows go to. |
| `type` | `json`: `{ file, path: "dotted.keys", where: { field: value } }`, the list at that path. `tsv`: `{ glob }`, one record per row of each tab-separated file, keyed by its header. `markdown-table`: `{ file, section: "<heading line>" }`, one record per row of the table under that heading. |
| `blank_when` | `[{ field, starts_with, blank: [fields] }]`: empty those fields when the field starts with that text (a placeholder is not a measurement). |
| `compute` | `{ new field: transform }`, in order; a later one may read an earlier one. |
| `skip_when` | `[{ field, empty: true }` or `{ field, starts_with }]`: drop the record. |
| `exclude` | `[{ field, in: [values] }]`: drop records whose field holds one of the values. |
| `first_per` | Keep only the first record for each value of this field. |
| `id` | A template over the record's fields: the row's id. |
| `on_duplicate` | `first`, `last` or `fill` (keep the first and add only the fields it lacks). Without it, two records making one row id are refused: choosing silently would drop a record. |
| `map` | `{ list field: transform }`: the row's values. A transform that gives nothing leaves the field out. |

### Transforms

A transform is a one-key object, used in `compute` and in `map`.

| Transform | Gives |
|---|---|
| `{ "from": field }` | the field |
| `{ "const": value }` | the value |
| `{ "template": "{a} and {b}" }` | the template filled from the record; nothing when every placeholder is empty |
| `{ "number": field }` | the field as a number (a thousands comma is ignored) |
| `{ "date8": field }` | `YYYYMMDD` as `YYYY-MM-DD` |
| `{ "choice": field, "table": { value: label } }` | the label for the field's value; a value not in the table gives nothing, never a guess |
| `{ "join": field }` | a list field joined with `; ` |
| `{ "lines": { from, template, details: { from, template, join, wrap } } }` | one line per object of a list, with its nested details joined and wrapped, e.g. ` ({})` |
| `{ "words_of_file": field }` | the number of words in the file the field names (a leading `[time]` on a line is not a word) |
| `{ "path_of_file": field }` | the field's value when it names a file that exists |
| `{ "first_nonempty": [fields] }` | the first that is not empty |
| `{ "up": N }` | the name of the folder N levels above the record's file |
| `{ "file": true }` | the record's file, relative to the root |
| `{ "file_beside": { dirs, exts, name_from } }` | the first `<folder of the file>/<dir>/<field><ext>` that exists |
| `{ "capture": { from, pattern, group } }` | a group of the first match of the regular expression, or empty |
| `{ "capture_template": { from, pattern, template } }` | the template filled from the match's named groups, or empty with no match |
| `{ "last_part": { from, sep } }` | what follows the last separator |
| `{ "strip": { from, chars } }` | the field without those characters at its ends |

## Files

| File | Purpose |
|---|---|
| `do-work/export_records_as_list_rows.py` | The command line above. |
| `read-data/list_rows.py` | The mapping's description, the transforms, the three readers, `build` (one source's rows) and `export` (the files). |
| `test/test_list_rows.py` | Every transform, reader, record filter, duplicate policy and what an export writes, on a made-up toy library. |
| `test/export-records-as-list-rows.test.mjs` | Runs those tests under `npm test`. |
| `test/fixtures/toy-library/` | The made-up records and `mapping.json`: the example to copy a mapping from. |

## Dependencies

**Depends on:** Python 3.10+; a records mapping that uses the `identity` expression also needs Node 22.6+ and the declared `tools/content-identity` files. The sender's request keys need the `blake3` module or the `b3sum` command.

**Depended on by:** nothing in this repository. A library's own mapping file lives with the library.

## Records for `records:write`

`do-work/build_record_write.py` builds the `{ id, type, value }` records a Trillion `records:write` takes, in commands of at most the mapping's `per_command` records and `command_bytes` bytes (a door may take only so many bytes in one request), from the person's list-definition rows and staged files. It sends nothing.

```
python3 -I do-work/build_record_write.py --mapping FILE --out FILE [--root NAME=DIR ...]
```

When the mapping reads `kind: records`, `--records-url ADDRESS` can point those reads at another MCP endpoint, such as an isolated clone. It changes only the read destination; the configured credential remains a keychain handle.

When `tool:build-records-to-write` runs through Workshop, it is a `computer` row. The person grants it one read folder for the mapping and local sources. Its `records:list` right is filled from the caller's exact `source_type` and `source_prefix` input fields; for the shared feeder those are `shared` and `shared:`. The row runner binds those values before intersecting the run with the person's grant. The managed wrapper ignores `records.config` and never reads a Keychain item; it returns the payload as result data and writes only in the run's private temporary folder. The separate `--mapping ... --out ...` command above remains the standalone CLI and uses its configured sender door for a `kind: records` source.

`tool:put-records-into-my-account` can take the builder's result directly as its `payload` object. It also takes the exact `target_type` and `target_prefix` its separate `records:list` and `records:write` rights are filled from. For the shared changelog feeder those are `record:trillion-changelog` and `record:trillion-changelog:input-`. It writes only records in that type and prefix; the builder's list definitions and other target kinds are counted in `out_of_scope` and are not sent. It returns write counts and readback, and accepts no config, status path or credential. Builder read rights and writer target rights are separate. The manual `send_record_write.py` command remains available with the config, work folder and status file described below.

`here` is always the folder of the mapping; every other folder the mapping names is given with `--root NAME=DIR`. The output holds the counts (with a per-link breakdown), what is `pending` (an optional staged file not there yet, or naming a row that does not exist yet), any notes diverted from the rows (for example a staged row that only adds a source to a row), and `commands`. Sending a command twice writes the same records again.

- The lists and saved views are the person's rows (`lists_file`); this tool names no list or field.
- Each source makes the rows of one list from records already in a JSON file (`kind: rows`) or from staged files (`kind: staged`: JSON, or JSON lines, one entry per file or glob; `inputs_from` reads the entries from a file the person keeps).
- A `kind: records` source reads one declared type and optional id prefix from the person's Trillion door, using `records: { "type": "shared", "prefix": "shared:", "config": { "root": "here", "path": "sender.json" } }`. The standalone CLI uses the existing `send_record_write.py` config and its Keychain handle; the managed Workshop row ignores that config and uses only the run's scoped descriptor right. The builder only reads; it sends nothing. The source's `id`, `keys`, `compute`, `values` and `basis` map those records just like other rows. Add `each: "value.items"` to make one row per item in an array; expressions can read the containing record as `record` and current item as `item`. A reader must return the declared type and prefix or the build is refused.
- A row's values and its `_basis` (reasoning and sources for a value, with the maker and time) are worked out by expressions over the staged row. The expression language and every key of a mapping are described at the top of `read-data/records_write.py` and `read-data/expressions.py`.
- Refusals name the row: two rows with one id, a slash in an id, a link to a row that does not exist, a value over the text limit, a basis naming too many sources, a row with no web address, a missing folder, one record bigger than a command takes.
- Two sources may make one row id when the later one says `on_duplicate`: `fill` (the row already made keeps its values and takes the fields it lacks) or `over` (the later values win, the earlier row fills the rest). The payload's `merged` names every merge, the fields filled and each differing value that was not kept.
- The mapping's `at` (an expression over a row's record, for example the staged file's `_generated`) is the time each basis says it was made, so building the same files again gives byte-identical records.
- The `identity` expression calls the declared content-identity owner on the exact UTF-8 bytes of its text; it needs Node 22.6+. Other expressions need only Python.
- Several `rows` sources may feed one list; each builds the records its own file holds. A `rows` source for a list that is never emitted is a lookup table other sources read with `row_of`.

## Putting the records into the account

`do-work/send_record_write.py` puts a payload into the person's account so a re-run writes nothing. It reads every record of each type the payload names (records:list, page by page), sends only the records whose value differs (a removal only while the record is held), in commands bounded by count and bytes, each with request key `<prefix>-<first 32 hex of the BLAKE3 of its records>`, logs each command with the local time, and stops at the first refusal with a status file. `readback` counts, per type, the records held and those holding the payload's value; `export` copies every record of a type into one JSON file (a backup before anything changes).

```
python3 -I do-work/send_record_write.py --config FILE --work DIR [--url ADDRESS] [--key-prefix TEXT] plan|readback --payload FILE
python3 -I do-work/send_record_write.py --config FILE --work DIR send --payload FILE --status FILE
python3 -I do-work/send_record_write.py --config FILE --work DIR export --type TYPE [--prefix ID_START] --out DIR
```

The config names how to reach the person's door: `transport` `mcp` (the door's MCP address and a credential handle such as `{ "keychain_item": "<name>" }`; the key is read from the keychain into memory and sent only as the Bearer token, never written or printed) or `call` (a program that plays a plan file); `--url` points the same config at another address, such as a copy of the account, and `--key-prefix` gives a load request keys of its own, so one config serves several loads. It also names the resource, the list and write operations, the page size, the command limits, the request-key prefix, and which refusals mean "send the halves" (the door took no effect, the command was too big for its time) or "send again under the same key" (the effect may have happened) (see the top of `read-data/record_write_send.py`). Exit 0 done, 1 refused or a readback differs, 2 unreadable config, payload or door.

## Sending the batches

`do-work/send_list_rows.py` sends the batches of an export one at a time through a command the person's config names, with a status file so a re-run skips what was sent.

```
python3 -I do-work/send_list_rows.py --config FILE [--key KEY] --batches DIR --status FILE [--only FAMILY ...]
```

The config says what to run (`send`, optionally `warm` before every send), how to count what was kept, which errors mean "retry after a wait" and which mean "send the halves", the waits and the order of the batch families (see `read-data/send_batches.py`). A batch is done only when every row was kept; a refusal stops the run and the status file says which batch and why. Exit 0 all sent, 1 refused, 2 unreadable config.

A config with `keep_held: true` writes only the records the account lacks: a record it already holds is left as it is, whatever its value, so a row someone edited after it was first written keeps their edits. `tool:put-records-into-my-account` is the `send` command as a Workshop row.

For a source refresh, pass `--baseline PREVIOUS_PAYLOAD` to `plan`, `send` and `readback` (or `baseline` to `tool:put-records-into-my-account`). The same sender then merges each field against that previous import: source changes apply where the live field still matches the baseline; live edits, extra fields and deleted records stay as they are. Nested maps are merged too, and a retained field keeps its live `_basis` attribution. Removing a record requires a baseline equal to its live value. Conflicts contain record IDs and field paths, never private values; `send` returns `written_with_conflicts` and exit 1 when it applied safe changes but retained a conflicting edit. `readback` reports remaining conflicts under `_refresh` and exits 1 until they are resolved. Never combine baseline refresh with `keep_held`.

To avoid reading unrelated records, add `--read-prefix 'TYPE=PREFIX'` before the subcommand, repeating it for several scopes, or put `{ "read_prefixes": { "TYPE": ["PREFIX", "OTHER_PREFIX"] } }` in the config. Every target of a scoped type must be covered. Wrong-type/out-of-prefix answers and repeated cursors are refused; an empty page with a continuation is followed. Managed writes already use their declared `target_type` and `target_prefix`. Refreshes use the account snapshot they read; the records door has no conditional-write primitive, so these checks do not provide atomic protection against an edit arriving between that read and its write.

## Noting what shipped

`do-work/read_what_shipped.py` adds a new release to a staged file, with the commit subjects since the release before it, and leaves the file as it is when that release is already there. Where the release is read is the person's setting: a program in the repository that prints JSON naming a release, or a git ref they move when they ship. For a branch whose commits are the source, `each: "commit"` makes one entry per commit after the stored cursor (or the `after` commit on the first run). `skip_subjects` is data that omits commits such as regenerated files. Each entry carries that commit's date, subject and stable commit identity; it does not infer push boundaries or combine same-day commits. The builder makes rows from staged entries with the person's mapping, and the sender with `keep_held` writes only rows the list lacks, preserving every row it already holds. `tools/workflows/recipes/keep-a-changelog-from-what-shipped.json` runs the steps every hour.

```
python3 -I do-work/read_what_shipped.py --settings FILE --repository DIR --staged FILE
```

Prints `{ releases, added, added_count }`; `added` is the newest entry name, and the count is zero when there is nothing new. Exit 0, or 2 when the settings, the repository or the mark could not be read.

## Publishing what a saved view shows into a file

`do-work/publish_view_file.py` writes the rows one saved view of a list shows into a file a site renders at its next deploy, so a public page shows the list with no public way into the account. The view is read first by `tools/read-a-list-view` (its rule-filter tool keeps the rows the view's rules keep, in the view's order), into one page that holds the whole view; that answer is this script's `--read`, so it never reads the door itself. It writes `{ schema, source: { view, list, blake3 }, fields, rows: [{ id, values }] }`. The key is the BLAKE3 of the fields and rows, so a publish that would write the same rows writes nothing. A read that holds only part of the view (a next page, or `complete` false) publishes nothing. With `media` in the config, the pictures and recordings the published rows name are carried into the site's own static files, each as `<BLAKE3 of its bytes>.<extension>`, and the rows name the site's address. So the page never points at a place that may go away, and a picture already carried is never copied again. A row whose own `media.public_field` holds one of `media.not_public`, such as one whose picture shows someone's own data, publishes its text with its media fields empty, and its pictures are never copied.

```
node tools/read-a-list-view/do-work/read-list-view.mjs --config READ_CONFIG --view ID --limit N > READ
python3 -I do-work/publish_view_file.py --read READ --config FILE --out FILE
```

Prints `{ file, rows, of, blake3, media: { copied, kept, not_public }, written }`. Exit 0 published or already current, 2 when the config or the read could not be used, the read holds only part of the view, or a media file is missing.

## Freezing a root and what it needs into one bundle

`do-work/freeze_a_bundle.py` freezes a root and every record and file it needs into one bundle file whose BLAKE3 is its identity, so what a person shares is an immutable snapshot that anyone can check and nothing changes under a link. The caller reads the parts from the person's account and hands in the refs the root needs (`{ kind, id }`) and what each resolves to (a file by its hash, a record's value, `public_readable`, and the refs it depends on in turn). The tool follows the refs through every depth (a ref once, so a cycle or a diamond ends), sorts what it found, and refuses to make a bundle when a ref resolves to nothing, a file has no hash, or a tier that requires a public closure (`public_tiers`, default `["public"]`, the caller's DATA) would hold a part that is not `public_readable`, a record as much as a file. A refused closure writes nothing. The root is carried through verbatim and never read.

```
python3 -I do-work/freeze_a_bundle.py --spec FILE --out FILE
```

Prints `{ ok, bundle_id, file, written, reference_issues, tier_issues }`. The file holds the bundle as canonical JSON (sorted keys, no spaces), so the same closure in any order gives the same bytes and the same `bundle_id` (`1f:` and the BLAKE3). Exit 0 frozen or already frozen, 3 when a gate refused the closure, 2 when the spec could not be read. Serving the file at a link is the Namespace files job; this tool only makes the frozen, checked bundle. It was `public-scene-share`'s capsule core (the closure builder, the two publish gates and the canonical bytes); what is specific to a scene (its pruning, its reader, its share buttons) is not carried.

## More files

| File | Purpose |
|---|---|
| `do-work/build_record_write.py` | The records:write builder's command line. |
| `do-work/send_list_rows.py` | The batch sender's command line. |
| `read-data/records_write.py` | The mapping, sources, staged-file readers, bases, checks and payload. |
| `do-work/refresh_record_values.py` | The managed writer's stdin/stdout adapter to the same pure three-way refresh used by the CLI; reads and writes no host files. |
| `read-data/expressions.py` | The expressions a mapping uses (paths, templates, conditions, lookups, lists, slugs, file text, requirements). |
| `read-data/send_batches.py` | Sending with warm-up, retry, halving and a status file. |
| `do-work/send_record_write.py` | The records:write sender's command line (plan, send, readback, export). |
| `do-work/send_built_record_write.mjs` | The managed writer: consumes the builder's result object, uses only the run-scoped descriptor, and returns readback. |
| `read-data/record_write_send.py` | Reading what an account holds, writing only what differs in BLAKE3-keyed bounded commands, readback and export. |
| `test/test_record_write.py`, `test/test_send_batches.py` | Both on made-up fixtures: `test/fixtures/pantry/` (a pantry's goods and stores) and `test/fixtures/fake_list_service.py`. |
| `test/test_record_write_send.py` | Byte-bounded commands, merged duplicates, the stable basis time, and the sender against `test/fixtures/fake_record_door.py` (a made-up door). |
| `do-work/publish_view_file.py` | The view publisher's command line. |
| `read-data/view_publish.py` | Reading a saved view, its list and rows, asking the rule filter, the view's order and the BLAKE3-keyed file. |
| `do-work/read_what_shipped.py` | The release reader's command line. |
| `read-data/what_shipped.py` | Reading the newest release from a program or a git ref, the commit subjects since the one before, the staged file. |
| `test/test_what_shipped.py` | The release reader on a made-up bakery repository (a ref and a program mark), and the sender's keep_held. |
| `do-work/freeze_a_bundle.py` | The bundle freezer's command line. |
| `read-data/frozen_bundle.py` | The closure walk, the two gates and the canonical bytes. Its header lists the invariants. |
| `test/test_frozen_bundle.py` | The freezer on made-up refs: a complete closure, a cycle and a diamond, an unresolved ref, a file with no hash, a private part in a public bundle, identical bytes in any order, and the command's exit codes. |
| `test/test_view_publish.py` | The view publisher against the made-up door: what the filter is sent, the order, an unchanged publish, refusals. |
