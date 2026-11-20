# tools/export-records-as-list-rows/

Turns a person's records on disk into the payloads that put rows into their lists (as list rows, or as the write commands their store takes), and plans the batches. Nothing here reaches a store: the person's AI reads and writes their own store directly, in that store's own language. Records can be JSON, tab-separated files (a spreadsheet saved as text) or markdown tables. **The code knows no record kinds, columns or lists**: everything about them is in a mapping file the person writes, so the same script serves any library. It sends nothing; it writes `make_lists.json`, the rows in batches (`<source>-000.json`, ...) and `manifest.json` into a folder.

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

**Depends on:** Python 3.10+; a records mapping that uses the `identity` expression also needs Node 22.6+ and the declared `tools/content-identity` files. The write planner's request keys need the `blake3` module or the `b3sum` command.

**Depended on by:** nothing in this repository. A library's own mapping lives with the library, or as a setting row of the person's `list:settings`; `--mapping-record` reads it with `tools/settings/read-data/settings.py`.

## Write commands for the person's store

`do-work/build_record_write.py` builds the `{ id, type, value }` records a store's write takes, in commands of at most the mapping's `per_command` records and `command_bytes` bytes, from the person's list-definition rows and staged files. It sends nothing.

```
python3 -I do-work/build_record_write.py --mapping FILE --out FILE [--root NAME=DIR ...]
python3 -I do-work/build_record_write.py --mapping-record ID --records-from FILE ... --out FILE [--root NAME=DIR ...]
python3 -I do-work/build_record_write.py --mapping FILE --as-setting account~main --setting-name TEXT --setting-from TEXT --out FILE
```

When the mapping reads `kind: records` (or `lists_read`), the records come in as the records the person's AI read from their own store, with `--records-from FILE`: the builder reads no account and holds no credential.

When `tool:build-records-to-write` runs through Workshop, it is a `computer` row. Its run names one read folder for the mapping and local sources at `computer.read-a-folder`. It declares no store access: the records the mapping reads come in as the `records` input (`[{ id, type, value }]`, read from the person's store by their AI), and each source takes only the records of its declared type and id prefix. The managed wrapper never reads a Keychain item; it returns the payload as result data and writes only in the run's private temporary folder.

`tool:put-records-into-my-account` takes that result directly as its `payload`, and the one record type and id prefix it covers. It is planned in the next section.

- The lists and saved views are the person's rows (`lists_file`); this tool names no list or field. With `lists_read` instead, the lists are among the records handed in (their own `list` records), `lists_add` names only the fields, choices and top-level keys a mapping needs added, and only a list that this changes is written again, with the saved views the mapping's `views` names.
- `emit_definitions: false` treats `lists_file` as a read-only schema snapshot: it still uses the row types and runs all existing row/link checks, but emits no list or saved-view writes. Omit it (or use `true`) to retain definition writes. Only boolean values are accepted; emitted list/view counts reflect the selected behavior.
- Each source makes the rows of one list from records already in a JSON file (`kind: rows`) or from staged files (`kind: staged`: JSON, JSON lines, tab-separated text with a header line, markdown `lines` (one row per matching line inside a section, carrying headings and table cells), a whole `text` file, or rows kept in the mapping itself under root `mapping`; one entry per file or glob; `one_row` makes a JSON file one row and `each` one row per item of a list in it; `inputs_from` reads the entries from a file the person keeps). A `kind: again` source works more fields out for rows another source already made (for example their links to rows made after them) and merges them by `on_duplicate`. A staged or again source's `skip_if` leaves a row out.
- A `kind: records` source takes one declared type and optional id prefix from the records handed in, using `records: { "type": "shared", "prefix": "shared:" }`: the standalone CLI reads them from `--records-from`, and the Workshop row from its `records` input. The builder reads no account and sends nothing. The source's `id`, `keys`, `compute`, `values` and `basis` map those records just like other rows. Add `each: "value.items"` to make one row per item in an array; expressions can read the containing record as `record` and current item as `item`. A reader must return the declared type and prefix or the build is refused.
- A row's values and its `_basis` (reasoning and sources for a value, with the maker and time) are worked out by expressions over the staged row. The expression language and every key of a mapping are described at the top of `read-data/records_write.py` and `read-data/expressions.py`.
- Refusals name the row: two rows with one id, a slash in an id, a link to a row that does not exist, a value over the text limit, a basis naming too many sources, a row with no web address, a missing folder, one record bigger than a command takes.
- Two sources may make one row id when the later one says `on_duplicate`: `fill` (the row already made keeps its values and takes the fields it lacks) or `over` (the later values win, the earlier row fills the rest). The payload's `merged` names every merge, the fields filled and each differing value that was not kept.
- The mapping's `at` (an expression over a row's record, for example the staged file's `_generated`) is the time each basis says it was made, so building the same files again gives byte-identical records.
- The `identity` expression calls the declared content-identity owner on the exact UTF-8 bytes of its text; it needs Node 22.6+. Other expressions need only Python.
- A basis may give its own `confidence`, instead of the mapping's.
- A person's own mapping is kept as a setting row of their `list:settings` (read with `tools/settings`): `--as-setting SCOPE_KIND~SCOPE_ID --setting-name TEXT --setting-from TEXT` with `--mapping FILE` writes the payload of those rows (one, or a first row naming the others in `parts` when the mapping is bigger than one command; the text keeps the mapping's key order, which `keys` and `compute` depend on), and `--mapping-record record:setting:export-records-as-list-rows~<scope_kind>~<scope_id>` builds from them. `--records-from FILE` answers the mapping record, `lists_read` and `kind: records` sources from the records the AI read, so a build can be repeated on the same account state.
- Several `rows` sources may feed one list; each builds the records its own file holds. A `rows` source for a list that is never emitted is a lookup table other sources read with `row_of`.

## Planning the writes into the person's store

`do-work/plan_record_write.py` says which records a store must write so that a re-run writes nothing. It takes one JSON object on standard input and writes nothing itself:

```
python3 -I do-work/plan_record_write.py plan < INPUT.json
python3 -I do-work/plan_record_write.py readback < INPUT.json
```

The input holds the builder's `payload`; the one `target_type` and `target_prefix` the plan covers (a record of another type or prefix is out of scope: counted, never written); `held`, the target records the store holds now, as `[{ id, type, value }]`, read by the person's AI straight from the store (a held record outside the target is refused, never ignored); and `config`: `per_command` and `command_bytes` bound each command, `request_key_prefix` starts each request key, and `keep_held` (optional, `true`) plans only the records the store lacks. The code in `read-data/record_write_plan.py` names no store, list or record kind.

`plan` prints `{ state, records, to_write, commands, out_of_scope, conflicts? }`. `state` is `to_write` or `nothing_to_write`. Each command is `{ request_key, input: { records } }`, in order, holding at most the count and bytes given. A request key is the prefix and the first 32 hex of the BLAKE3 of the command's records, so the same records make the same key and a replayed write is the same write. A record whose value differs from the one held is planned, and a record the store lacks; a removal (value `null`) is planned only while the store holds the record.

The person's AI writes each command into the store itself, in the store's own language: set each record's value, or remove it when its value is `null`. A record that carries `expected` (only the baseline refresh below gives one) must find exactly that value when it is written, or none when `expected` is `null`; the store refuses any other value and the write stops, so a concurrent edit is never overwritten. After the writes, the AI reads the target records back and runs `readback` with the same input. `readback` prints `{ state, records, readback, out_of_scope, conflicts }`: `all_equal` when every record holds its value and no conflict remains, otherwise `readback_differs` with the missing and differing ids. Exit 0 for a plan and for an `all_equal` readback, 1 for a readback that differs, 2 when the input could not be read.

For a source refresh, give a `baseline`: the previous imported payload. The planner then merges each field against that import: a source change applies where the live field still matches the baseline; live edits, extra fields and records the store deleted stay as they are. Nested maps are merged too, and a retained field keeps its live `_basis` attribution. Removing a record requires a baseline equal to its live value. Conflicts contain record IDs and field paths, never private values, and a conflict keeps the readback from being `all_equal` until it is resolved. Never combine a baseline with `keep_held`.

To add fields to rows the store already holds, keyed by row id, give a payload whose values hold only the new fields and a baseline naming the same records with the value `{}` (the previous import gave none of these fields). Every field the payload does not name stays exactly as it is held; a held field equal to the new value is left alone; a held field with a different value is kept and reported as a `live_changed` conflict; a row the store does not hold is reported as `live_deleted` and never created.

The planner does not read the store, so it cannot check the store's own rules: the caller checks the `expected` values when it writes, and a write the store cannot make atomic is the caller's to refuse.

## Putting the batches into the store

The export writes its batches and a manifest into the folder the person names. Nothing here sends them: the recipe `workflow:send-my-batches-into-my-list` (in `tools/workflows`) has the person's AI write each batch into the person's own store, one batch at a time, and keep what was sent. A batch counts only when the store holds every one of its rows, and a refusal stops the run and names the batch and why.

## Noting what shipped

`do-work/read_what_shipped.py` adds a new release to a staged file, with the commit subjects since the release before it, and leaves the file as it is when that release is already there. Where the release is read is the person's setting: a program in the repository that prints JSON naming a release, or a git ref they move when they ship. For a branch whose commits are the source, `each: "commit"` makes one entry per commit after the stored cursor (or the `after` commit on the first run). `skip_subjects` is data that omits commits such as regenerated files. Each entry carries that commit's date, subject and stable commit identity; it does not infer push boundaries or combine same-day commits. The builder makes rows from staged entries with the person's mapping, and the planner with `keep_held` plans only the rows the store lacks, preserving every row it already holds. `tools/workflows/recipes/keep-a-changelog-from-what-shipped.json` runs the steps every hour.

```
python3 -I do-work/read_what_shipped.py --settings FILE --repository DIR --staged FILE
```

Prints `{ releases, added, added_count }`; `added` is the newest entry name, and the count is zero when there is nothing new. Exit 0, or 2 when the settings, the repository or the mark could not be read.

## Publishing what a saved view shows into a file

`do-work/publish_view_file.py` writes the rows one saved view of a list shows into a file a site renders at its next deploy, so a public page shows the list with no public way into the account. The view is read first by the person's AI, straight from their own store, into one page that holds the whole view (the rows its rules keep, in its order, with the list's fields and the count the view holds); that page is this script's `--read`. It writes `{ schema, source: { view, list, blake3 }, fields, rows: [{ id, values }] }`. The key is the BLAKE3 of the fields and rows, so a publish that would write the same rows writes nothing. A read that holds only part of the view (a next page, or `complete` false) publishes nothing. With `media` in the config, the pictures and recordings the published rows name are carried into the site's own static files, each as `<BLAKE3 of its bytes>.<extension>`, and the rows name the site's address. So the page never points at a place that may go away, and a picture already carried is never copied again. A row whose own `media.public_field` holds one of `media.not_public`, such as one whose picture shows someone's own data, publishes its text with its media fields empty, and its pictures are never copied.

```
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
| `do-work/build_record_write.py` | The write builder's command line. |
| `read-data/records_write.py` | The mapping, sources, staged-file readers, bases, checks and payload. |
| `read-data/expressions.py` | The expressions a mapping uses (paths, templates, conditions, lookups, lists, slugs, file text, requirements). |
| `do-work/plan_record_write.py` | The write planner's command line (plan and readback), on standard input; it reaches no store. |
| `do-work/plan_built_record_write.mjs` | The managed planner: hands the builder's result and the held records to the planner and returns its answer; writes nothing. |
| `read-data/record_write_plan.py` | Which records a store lacks, the bounded keyed commands, the baseline refresh with its conflicts and expected values, and the readback; pure, no store. |
| `test/test_record_write.py` | On made-up fixtures: `test/fixtures/pantry/` (a pantry's goods and stores). |
| `test/test_record_write_sources.py` | The tab-separated, markdown-lines, text and mapping-kept sources, `again` and `skip_if`, `lists_read`/`lists_add`, a basis's own confidence, the list, text, number and file expressions, and a mapping kept as setting rows (one, or in parts) read back to the same payload, on a made-up orchard almanac. |
| `test/test_record_write_plan.py` | Byte-bounded commands, merged duplicates, the stable basis time, the plan and readback on the made-up pantry, the baseline refresh with conflicts, and the planner's command line. |
| `do-work/publish_view_file.py` | The view publisher's command line. |
| `read-data/view_publish.py` | Reading a saved view, its list and rows, asking the rule filter, the view's order and the BLAKE3-keyed file. |
| `do-work/read_what_shipped.py` | The release reader's command line. |
| `read-data/what_shipped.py` | Reading the newest release from a program or a git ref, the commit subjects since the one before, the staged file. |
| `test/test_what_shipped.py` | The release reader on a made-up bakery repository (a ref and a program mark), and the planner's keep_held. |
| `do-work/freeze_a_bundle.py` | The bundle freezer's command line. |
| `read-data/frozen_bundle.py` | The closure walk, the two gates and the canonical bytes. Its header lists the invariants. |
| `test/test_frozen_bundle.py` | The freezer on made-up refs: a complete closure, a cycle and a diamond, an unresolved ref, a file with no hash, a private part in a public bundle, identical bytes in any order, and the command's exit codes. |
| `test/test_view_publish.py` | The view publisher on made-up rows: the file's shape and order, an unchanged publish, the media copies, refusals. |
