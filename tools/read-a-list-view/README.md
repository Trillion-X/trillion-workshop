# tools/read-a-list-view/

Reads one page of what a person's list shows, from the records the caller hands in. The caller reads them from its own store; this tool reaches no store. A list's rows are the records of its row type. The rows of each row source the list declares (`row_sources: [{ source, id?, root?, of, match?, exclude?, paths?, text_extensions?, content?, values? }]`) are among those records too: a refresh writes them there. So opening a list or a saved view reads no folder. With a saved view, the rule filter of `tools/formulas` decides in the same process which rows the view's rules keep, and they come in the view's order.

A refresh reads each row source's folder on this computer (read-data/sources.mjs, the documents folder functions) in bounded pages, and removes obsolete rows only after the source ends successfully. It answers only the rows that changed as keep rows, each with the value it expected, for the caller to write back.

Formula-derived title fields are evaluated from each row's current stored values through the existing formula owner. The shared title projection changes only the returned title; it never saves a name or changes the row's values. Missing formula DATA or an evaluator failure refuses the read rather than returning a stale title or a successful empty list.

A list can declare `row_records: { type, prefix }` when its records already use another physical address. The shared `keep-lists-of-rows/read-data/row-record-address.mjs` resolver supplies that same address for reads, refresh writes and list-original copies. Without a declaration, the configured `names.row_type` template remains unchanged and reads keep their existing kind-only selection. A declaration supplies both nonempty literal strings and narrows reads to its prefix; an invalid declaration fails instead of falling back. Row IDs remain local even when their text contains the physical prefix. Address DATA neither moves records nor grants access.

Ported from:
- the read path of the lists in the earlier Trillion app (`src/lists.mjs` `withRowSources`), where a source row's id is `<source>~<id>`;
- the view read of `tools/export-records-as-list-rows` (`read-data/view_publish.py`): the rule filter, then the sort.

## Running it

From the root of the Workshop checkout, on the person's own computer, with the input as JSON on standard input:

```
node tools/read-a-list-view/do-work/read-list-view.mjs < input.json
```

`input.op` is one of:
- `"read"`: `{ op, names, stored, list | view, after?, limit? }`. Answers a page.
- `"refresh"`: `{ op, names, stored, list, source_ids?, paths?, changes?, dry_run?, source_answer_bytes?, stored.restore?, stored.history? }`. Answers `{ list, sources, keep }`.
- `"write-joined"`: `{ op, root, name, type, prefixes, text_at, order_at, header?, most_bytes?, dry_run?, stored }`. Writes one file from rows.
- `"copy-readable"`: `{ op, names, list, reading }`. Answers whether a list's file copy may be read.

A read prints the page as JSON: `{ list, fields, rows: [{ id, record_id, values, title, source? }], next, complete, of? }`.
- `values` is each row's whole value, not only the view's columns.
- `record_id` is the row's full record id.
- `source` names the logical row source a row came from (`id`, or the source kind when `id` is omitted).
- `of` is how many rows a view read before its rules kept some.
- Pass `next` as `after` to read the next page; it is null on the last page.

A refresh prints `{ list, sources: [{ source, rows, written, removed, unchanged }], keep: [{ id, type, value, expected }] }`. Each keep row is one record to write back: `value` null removes it, and `expected` is the record as it was handed in (null for a new one), so the store refuses the row when its record has moved. If the command cannot finish, it exits 2 and says why on standard error.

`stored` is the records the run works over: `{ records: [{ id, type, value }] }`, read by the caller from the person's store. Nothing in the code names a list, view, record type, address or tool; the input names them all:

| Key | Holds |
|---|---|
| `names` | `{ list_type, list_record, row_type, view_type? }`: the type of a list's record and its id (`{list_id}` marks where the list's id goes), the type of its rows (`{row_type}`), and the type of a saved view. |
| `stored.records` | The records the run reads. A read or refresh given no records is refused, never read as an empty store. |
| `stored.history` | For a two-way sync only: each record's versions, `{ <record id>: [{ value, deleted, at }] }`, newest first. |
| `stored.restore` | For a two-way sync only: the account's restore generation record, `{ value: { generation, restored_at } }`, or null when the account was never restored. |
| `source_answer_bytes` | The room a source page's answer may have, sent to each source as `most_bytes` during a refresh. |

## How a page is made

- A page holds `limit` rows, or `read_page_rows` when no limit is given, and never more than `rows_per_read`. The cursor `after` is the record id the page before ended on.
- A list that declares more than `row_sources_per_list` sources is refused, and so is a source that no row serves.
- A view with rules or a sort needs every row before it can order them, so it reads at most `rows_per_read` rows in all. The rule filter (the Rust formula engine's `filterRecords` from `tools/formula-engine`, called in the same process) answers which rows to keep, and gets only the fields the rules read. A rule the filter cannot use is refused, never shown as an empty view. The kept rows are sorted and then paged. `complete` is false when the list had more rows than `rows_per_read`.
- The sort compares values by the UTF-8 bytes of their canonical JSON (keys sorted, no spaces), from the last sort entry to the first, with empty values last. This is the order the view publish used, so a published file's hash does not change.

## How a refresh writes

- A source row's record id is `<row type>:<logical source id>~<its id, URI-encoded>`. The optional source `id` distinguishes two folders served by the same source kind. Without it, the kind is the identity, preserving existing record IDs. IDs must be unique within the list and cannot contain `~`, path separators or control characters.
- A row whose value identity equals the existing record's is left alone, and not answered. A source must reach a successful terminal page before any obsolete row is removed. A source that fails or stalls mid-way answers no removal at all. An answer missing its rows array is refused; an explicit empty terminal array is a complete empty collection.
- The list's own rows and the rows of other source IDs are never touched. A second refresh with nothing changed answers no keep rows.
- `changes` narrows selected non-list-original document sources to exact changed and removed paths. It reads changed documents only, and removes only their stale rows (including split text parts). The caller names missing files in `removed`, so an empty filtered result cannot delete an existing row by accident. Positive path catalogues cannot be narrowed this way; refresh those sources in full.
- The refresh answers its writes as keep rows only. The store applies them, and refuses any row whose `expected` record has moved, which is the same contract as `tool:change-my-groups` (1ba06d179e).

## A list that is the original, a folder that is its copy

A person's AIs are not all on one computer: a web chat, a phone app or a service can write to their list in its store, but never to a folder on their computer. So a list can be the original and a folder its copy, for apps that read only files. The row source says so: `original: "list"`. A refresh of that list is then a two-way sync (`read-data/list-copy.mjs`), and the source kind must name the tool that writes its copy (`change` in `list-view.json`; for documents, `tool:change-a-document-row`) and the fields that hold a document's text and parts (`copy`).

Nothing is kept outside the rows. A row made from a file holds that file's identity (`file.identity`, `1f:` and BLAKE3 of its bytes). For each document:

| What the sync finds | What it does |
|---|---|
| The folder's text and the list's text are the same | Nothing, except writing changed file facts (size, times) to the list. A frontmatter value only the list changed goes into the file. |
| The file is still the one the row was made from, and the list's text differs | The list changed: the file is written with the list's text, then its rows are written again. |
| The list's text is still the file the row was made from, and the file differs | The file changed: its rows are written to the list. |
| Both changed | The later change wins: the file's modified time against the row's newest version time (`history_method`). The other side's text is written as a version of the row first, so it stays in the row's history. Without times, both are kept as they are and the answer names the document. |
| Only rows, and their text is the file they were made from | The file was removed: the rows are removed. |
| Only rows the list wrote or changed | The file is made. |
| Only a file | A new file: its rows are written. If the row's newest version is a removal of this same file's text, the list removed it, and the file is removed. |
| A row the list's own rows hold (`adopt_own_rows: true`) | Any AI wrote it under its own id. The file `copy_name` names is made (`"{note.by\|person}/{note.name}.md"`: each value made one safe name segment; `\|word` is used when the row has no such value; a taken name gets `-2`, `-3` ...), its rows are written, and then the AI's own row is removed, so every AI reads one row. A row that cannot be named stays and is named in the answer. A taken name that already holds exactly this row's values and text is this row's copy (another sync made it a moment ago), so two syncs at once never make two copies. |

A file is written or removed only while it is still the one read (the change tool checks its identity), and a row is written only as a keep row the store checks against the value it expected, so nothing is overwritten silently. No row is removed for a file the source did not answer: list-only rows are judged after the source's last page.

A restore never becomes a removal. When the account is brought back from an older copy of its state, it keeps a restore generation, the record `list-view.json` `restore` names (`setting:restore-generation`, `{ value: { generation, restored_at } }`). A removal judged from a row version older than `restored_at` is not trusted, because the folder may hold newer copies than the restored rows. A file whose row history ends in such a removal is carried back up to the list (`carried_after_restore`), and rows whose file is gone are kept (`kept_after_restore`). A removal written after the restore is judged as always. On Nov 3, 2026 the account was restored from an Oct 30 copy while the folders kept every newer memory; this is that case.

While every holder of the account is unreachable, the copy is the only place its text can be read. `copy-readable` answers `{ readable: true }` only when the caller's reading of the list (`reading`: `{ unreachable: true }` or a code in `list-view.json` `copies_when_unreachable`) says so; a reading that answered keeps the copy closed, and a guard that hands in no reading is refused. A copy guard asks it before refusing an agent's read of a copy; the copy is never written except by this sync.

`paths` (`["/folder/agent/name.md"]`) settles only those documents: what a hook runs right after an app writes a file (one document took 0.7 s on a list of 4,425). `dry_run: true` plans the same and writes nothing; read its `planned` before the first real run. The answer is `{ source, original: "list", documents, unchanged, pushed, pulled, adopted, removed_rows, removed_files, conflicts: [{ document, kept, because }], refused: [{ document, because }], planned? }`. Its row changes are keep rows in the refresh answer; its file changes go through the folder functions on this computer.

```json
{"row_sources": [{"source": "documents", "of": "/memories", "match": "*/*.md", "original": "list",
  "adopt_own_rows": true, "copy_name": "{note.by|person}/{note.name}.md",
  "content": {"field": "document.text", "part_bytes": 6000}}]}
```

A file can also hold many rows: rules, checks, any objects with an id, in one array. The row source kind `json-items` reads them (`tools/documents-as-list-rows` read-data/json-items.mjs): each item is a document named `/<its id>`, its keys are the row's fields as they are, `copy.text` is its JSON and `copy.identity` the identity of that text, so the sync above settles it item by item with no change. A list keeps its own fields off the file by naming them in `content.list_only` (a check's on/off switch, who judges it); every other field of a row is the item's. The file is written whole in one shape (`indent` spaces); its other keys stay as they are. Every item's `file.mtime` is the file's, so a change to one item writes every row's `file.mtime` again.

```json
{"row_sources": [{"id": "rules", "source": "json-items", "root": "/path/to/project", "file": "data/rules.json", "at": "rules",
  "key": "id", "indent": 2, "of": "/", "original": "list", "adopt_own_rows": true, "copy_name": "{id}",
  "content": {"list_only": ["on", "why_off", "switched_by", "switched_at"]}}]}
```

## One file made from many rows

Some apps read one file at start (a coding harness reads AGENTS.md or CLAUDE.md), while the person keeps what it should say as rows every AI reads from their store (for instructions, the `setting:ai-instruction:<id>` rows). `op` `write-joined` makes that file from the rows, one direction only:

```
node tools/read-a-list-view/do-work/read-list-view.mjs < joined.json   # joined.json: {"op":"write-joined","root":"/home/ada/project","name":"/AGENTS.md","type":"setting","prefixes":["setting:ai-instruction:bootstrap-"],"text_at":"value.text","order_at":"value.order","header":"<!-- Made from rows; change the rows. -->","most_bytes":8192,"stored":{...}}
```

- The file is `header`, then the text of every row whose id starts with one of `prefixes`, in `order_at` order (then id), a blank line between. A row with no text is left out.
- It is written through the documents folder functions only while it is still the file read, and a second run with nothing changed writes nothing.
- `most_bytes` (optional) is a size to warn at, never a refusal: a copy over it is still written, and the answer carries `warning: { code: 'copy_over_size', words }`. A file holds any number of bytes; refusing kept the old copy while every AI read stale instructions (2026-11-12). A copy with no rows is refused and the file is left as it was.
- The answer is `{ name, rows, bytes, written, identity, warning? }`; `dry_run: true` writes nothing. The person refuses hand edits to such a file with a guard of their own, so the rows stay the original.

## Bounds

The bounds are this tool's own DATA, `limits` in `read-data/list-view.json`. Reading a list is this tool's job; the engine only stores and lists records. A caller never passes them.
- `read_page_rows` (50): a page when no limit is given, and the most one source tool's page asks for.
- `rows_per_read` (2,000): the most rows one view read gathers. Refreshes stream bounded pages until each source ends.
- `row_sources_per_list` (8): the most row sources one list may declare.

## Row sources

`read-data/list-view.json` holds one entry per source kind: the folder tool it names, the input that tool gets (`{of}` is the list's `of`; `limit` and `after` are added), and where its answer keeps the rows and the next cursor. Its read and change functions are named once, in `read-data/sources.mjs`. Today it has two kinds:
- `documents`: `tool:read-documents-as-list-rows` reads the markdown documents in a folder on the person's computer that they granted.

In both, each document is a row and its frontmatter holds the fields. Adding a source kind means one entry in list-view.json and one in sources.mjs. A declaration of a kind that has no entry is refused.

Optional fields on each source declaration:

| Field | Meaning |
|---|---|
| `id` | The stable identity of this logical collection, separate from the source tool kind. |
| `root` | For a documents source, an explicit scoped computer folder passed to that tool's `root` input. Omitted when absent, retaining the configured local tool root. The document tool's containment and the run's grants still apply. |
| `content` | The source's boolean or JSON object content option, forwarded unchanged to its tool. For documents, this opts into complete bounded text parts. |
| `exclude` | An array of nonempty glob strings relative to the source folder, forwarded unchanged. The source tool omits matching documents. |
| `paths` | An array of nonempty exact document paths, forwarded unchanged. The document source validates their containment under its admitted root and can read those files without a broad recursive scan. |
| `text_extensions` | An array of nonempty extension strings, forwarded unchanged. The document source reads files with these UTF-8 extensions instead of its document extensions, in a folder scan or among exact `paths`; this selects text to read and never executes source files. |
| `values` | Additional destination fields: `{destination: {from: "literal.source.field"}}` copies a source value; `{destination: {row: "title"}}` copies a row property; `{destination: {const: JSON}}` supplies DATA. Original fields are retained, and only explicitly named destination fields are replaced. |

For example, two document folders can feed one Library without deleting each other's rows:

```json
{
  "row_sources": [
    {"source":"documents","id":"guides","of":"/guides","content":true,
     "values":{"statement":{"row":"title"},"description":{"from":"document.text"}}},
    {"source":"documents","id":"research","of":"/research","content":true,
     "values":{"statement":{"row":"title"},"description":{"from":"document.text"}}}
  ]
}
```

## Where it runs

- **On the person's computer**: the command line above, with the input on standard input. The caller reads the records from the person's store (the account database, in its own query language) and passes them in as `stored`; the refresh's keep rows go back to that store.
- **In a screen that shows a list**: the screen bundles `read-data/list-view.mjs`, `read-data/list-view.json` and `read-data/store.mjs`, pinned at a Workshop commit, and calls `readListView(input)` with `stored` it read itself. A read needs no more than the records. The rule filter comes with the module: it imports `tools/formulas`, so the screen also bundles that folder's `do-work` and `read-data/rule-operators.json`. Canonical refresh value identities reuse `tools/content-identity` (BLAKE3), so that shared module is part of the import closure too.

The reader does not run as an engine row: a run the engine starts gets record rights for named record kinds only, and each list's rows are a kind the list itself names.

## Files

| File | Purpose |
|---|---|
| `read-data/list-view.mjs` | `readListView(input)`: one page of a list or a view, from `stored`. `refreshRowSources(input)`: a list's row sources answered as keep rows. |
| `read-data/store.mjs` | `storeOf(stored)`: plain filters over the records handed in. |
| `read-data/sources.mjs` | The folder side of a row source: the documents and json-items read and change functions, run on this computer. |
| `read-data/list-view.json` | The bounds, the restore record, the copy rule, the row source kinds and the folder tool each names. |
| `do-work/read-list-view.mjs` | The command line above: JSON on standard input, `op` names the run, `--deadline-ms` bounds it. |
| `read-data/list-copy.mjs` | `syncRowSource(input)`: the two-way sync of a source declared `original: "list"`, which a refresh of that list runs. |
| `read-data/copy-readable.mjs` | `copyReadable({ names, list, reading })`: whether a list's file copy may be read now, read-only. A copy guard asks it. |
| `read-data/joined-copy.mjs` | `writeJoinedCopy(spec)`: one file made from many rows' text in order. |
| `test/read-a-list-view.test.mjs` | Tests on a made-up bakery's chores: a refresh's keep rows (only what changed, removals, the expected value), a read that reads no folder, paging, a store that moved a record refusing its keep row, changed paths, scoped refreshes, views and sorts, the bounds, native addresses. |
| `test/list-copy.test.mjs` | Tests on a made-up bakery's notes in a real folder: a folder never read, list and file edits, both sides changed, removals on either side, a restore that removes nothing and carries the newer files back, an AI's row becoming a file, a dry run, a sync not handed its history refused, `paths`. |
| `test/json-items-copy.test.mjs` | The same sync on one made-up kitchen rules file that holds many rows. |
| `test/copy-readable.test.mjs` | A reading that answered keeps the copy closed; an unavailable code or an unreachable store opens it; no reading keeps it closed. |
| `test/joined-copy.test.mjs` | One file from a made-up bakery's rule rows: order and header, nothing written twice, a copy over budget written with a warning, no rows refused, a dry run, a missing stored list refused. |
| `test/list-title-projection.test.mjs` | Titles derived from a formula on each read, bad formula DATA refused. |
| `test/row-record-address.test.mjs` | A declared native address reads its own prefix and refresh writes only it. |
| `test/refresh-changes-run-deadline.test.mjs` | Changed documents reconciled alone; the command line's deadline and stdin reads. |
| `test/support/stored.mjs` | Made-up chores, recipes on disk, and the store's own refusal of a moved record. |
| `test/support/sync-store.mjs` | A made-up store with version history for the two-way sync tests. |
| `kits/read-a-list-view.json`, `tool-rows.json`, `part.json` | The AI's kit, the Workshop row and the public entries. |

## Dependencies

**Depends on:**
- Node;
- the folder functions of `tools/documents-as-list-rows` (`read-data/rows.mjs`, `read-data/json-items.mjs`), imported in the same process;
- for a view's rules, the Rust formula engine's `filterRecords` (`tools/formula-engine`), called in the same process;
- for a refresh's canonical identities, `tools/content-identity`.

**Depended on by:**
- the Lists screen;
- the view publish of `tools/export-records-as-list-rows`, which calls this read.

## Screens moved from the web client

These files were moved byte for byte from the web client (`moved-from.json` names each file's source path, commit and identity). Their imports of the web shell's files stay as written; the client build answers them with the shell's files and opens each screen as a screen module named by its row (`screen.module`).

| File | Purpose |
|------|---------|
| `web/src/workspace/record-set-screen.tsx` | Sent, Spend, Visitors and Price tests (`tool:screen-sent`, `tool:screen-spend`, `tool:screen-visitors`, `tool:screen-price-tests`): any list whose answer describes itself, drawn in the record views; each row's `input` names what it reads. |
| `web/src/workspace/chart-screen.tsx` | Chart (`tool:screen-chart`): any reading or list as one chart. |
| `show/record-set-mount.tsx` | The module entry the row names for `record-set`: `mount` is `mountRecordSetScreen`. |
| `show/chart-mount.tsx` | The module entry the row names for `chart`: `mount` is `mountChartScreen`. |
