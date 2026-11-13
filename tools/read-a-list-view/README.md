# tools/read-a-list-view/

Reads one page of what a person's list shows, from their records only. A list's rows are the records of its row type. The rows of each row source the list declares (`row_sources: [{ source, id?, root?, of, match?, exclude?, paths?, text_extensions?, content?, values? }]`) are among those records too: a refresh writes them there. So opening a list or a saved view runs no tool. With a saved view, the rule filter of `tools/formulas` decides in the same process which rows the view's rules keep, and they come in the view's order.

A refresh is the one thing that runs the source tools. It runs the tool each row source names, reads and writes bounded pages, and removes obsolete rows only after the source ends successfully. It writes only the rows that changed.

Ported from:
- the read path of the lists in the earlier Trillion app (`src/lists.mjs` `withRowSources`), where a source row's id is `<source>~<id>`;
- the view read of `tools/export-records-as-list-rows` (`read-data/view_publish.py`): the rule filter, then the sort.

## Running it

From the root of the Workshop checkout, on the person's own computer:

```
node tools/read-a-list-view/do-work/read-list-view.mjs --config FILE (--list ID | --view ID) [--after CURSOR] [--limit N]
node tools/read-a-list-view/do-work/read-list-view.mjs --config FILE --refresh LIST_ID [--sources '["source-id"]'] [--paths '["/folder/name.md"]'] [--dry-run yes]
```

A read prints the page as JSON: `{ list, fields, rows: [{ id, record_id, values, title, source? }], next, complete, of? }`.
- `values` is each row's whole value, not only the view's columns.
- `record_id` is the row's full record id.
- `source` names the logical row source a row came from (`id`, or the source kind when `id` is omitted).
- `of` is how many rows a view read before its rules kept some.
- Pass `next` as `--after` to read the next page; it is null on the last page.

A refresh prints `{ list, sources: [{ source, rows, written, removed, unchanged, refused }] }`. `refused` names the rows whose values the door refused, for example a value that does not fit the list's field kind. If either command cannot finish, it exits 2 and says why on standard error.

The config is JSON. Nothing in the code names a list, view, record type, address or tool; the config names them all:

| Key | Holds |
|---|---|
| `transport` | `{ url, credential: { keychain_item } \| { key_file } }`: the door's MCP address, and where the computer keeps the person's key: a keychain item (read with `security`) or a key file the person names (read on any place). The key is sent only in the Authorization header. Any answer that contains the key is refused. |
| `records` | `{ address, read_method, list_method, write_method?, history_method? }`: where the door reads one record (`{ type, id }`), lists a page of one type (`{ type, limit, after, prefix? }`), for a refresh writes records and, for a list that is the original, reads a record's newest versions with their times (`{ id, limit }`, answering `{ versions: [{ value, deleted, at }] }`). |
| `tools` | `{ address, run_method }`: where the door runs a tool (`{ tool, input }`), for a refresh's source tools. |
| `local_tools` | `{ <tool id>: { module, export, input? } }`: tools a refresh runs on this computer instead of through the door. Each gives the module's path under the Workshop's `tools` folder, the function it exports, and the input every run gets (for the documents source, `{ root }`, the folder the documents are in). Its answer is read as a run's `result`. |
| `names` | `{ list_type, list_record, row_type, view_type? }`: the type of a list's record and its id (`{list_id}` marks where the list's id goes), the type of its rows (`{row_type}`), and the type of a saved view. |
| `source_answer_bytes` | The room a source tool's answer has in the door's reply, sent to each source as `most_bytes` during a refresh. A door answers a run within one MCP message, and the local door's message is 65,536 bytes holding the answer twice (as text and as structured content). Without this, a page of big documents would end in an unknown outcome. 28,000 leaves room for the run's envelope and the text copy's escapes. |

## How a page is made

- A page holds `--limit` rows, or `read_page_rows` when no limit is given, and never more than `rows_per_read`. Each records:list asks for at most `door_page_rows`, because the door refuses a page of 2,000; the read asks again until the page is full.
- A list that declares more than `row_sources_per_list` sources is refused, and so is a source that no row serves.
- A view with rules or a sort needs every row before it can order them, so it reads at most `rows_per_read` rows in all. The rule filter (`tools/formulas` `filterRecords`, imported and called in the same process) answers which rows to keep, and gets only the fields the rules read. A rule the filter cannot use is refused, never shown as an empty view. The kept rows are sorted and then paged. `complete` is false when the list had more rows than `rows_per_read`.
- The sort compares values by the UTF-8 bytes of their canonical JSON (keys sorted, no spaces), from the last sort entry to the first, with empty values last. This is the order the view publish used, so a published file's hash does not change.

## How a refresh writes

- A source row's record id is `<row type>:<logical source id>~<its id, URI-encoded>`. The optional source `id` distinguishes two folders served by the same `source` tool. Without it, the kind is the identity, preserving existing record IDs. IDs must be unique within the list and cannot contain `~`, path separators or control characters.
- Existing source records are read in bounded pages; only their IDs and BLAKE3 identities of canonical values are retained. Source bodies are then read and written one bounded page at a time. A refresh is not limited by a view's `rows_per_read`, so a large collection needs more pages rather than a higher per-page limit.
- A row whose value identity equals the existing record's is left alone. The source must reach a successful terminal page before any obsolete row is removed. If a later page fails, repeats its cursor, repeats a row ID or is cancelled, unread existing rows survive. Earlier successfully saved page changes may remain and a retry compares them normally. An answer missing its rows array is refused; an explicit empty terminal array is a complete empty collection.
- The list's own rows and the rows of other source IDs are never touched. A second refresh with nothing changed writes nothing. The local `refreshRowSources` function accepts an optional `AbortSignal` as `signal`, checked around source/list reads and before each write batch.
- Writes go in batches of at most `write_rows` records and `write_bytes` bytes, each with its own request key. If the door refuses a batch as written, its records are sent again one at a time: the others are written, and the refused ones are named.

## A list that is the original, a folder that is its copy

A person's AIs are not all on one computer: a web chat, a phone app or a service can write to their list through their door, but never to a folder on their computer. So a list can be the original and a folder its copy, for apps that read only files. The row source says so: `original: "list"`. A refresh of that list is then a two-way sync (`read-data/list-copy.mjs`), and the source kind must name the tool that writes its copy (`change` in `list-view.json`; for documents, `tool:change-a-document-row`) and the fields that hold a document's text and parts (`copy`).

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

A file is written or removed only while it is still the one read (the change tool checks its identity), and a row is overwritten only by a write the door keeps as a new version, so nothing is overwritten silently. No row is removed for a file the source did not answer: list-only rows are judged after the source's last page.

A restore never becomes a removal. When the account is brought back from an older copy of its state, it keeps a restore generation, the record `list-view.json` `restore` names (`setting:restore-generation`, `{ value: { generation, restored_at } }`). A removal judged from a row version older than `restored_at` is not trusted, because the folder may hold newer copies than the restored rows. A file whose row history ends in such a removal is carried back up to the list (`carried_after_restore`), and rows whose file is gone are kept (`kept_after_restore`). A removal written after the restore is judged as always. On Nov 3, 2026 the account was restored from an Oct 30 copy while the folders kept every newer memory; this is that case.

While every holder of the account is unreachable, the copy is the only place its text can be read. `--copy-readable LIST_ID` answers `{ readable: true }` only when reading the list answers one of the codes in `list-view.json` `copies_when_unreachable` (or nothing answers at all); any answer from the list keeps the copy closed. A copy guard asks it before refusing an agent's read of a copy; the copy is never written except by this sync.

`--paths '["/folder/agent/name.md"]'` settles only those documents: what a hook runs right after an app writes a file (one document took 0.7 s on a list of 4,425). `--dry-run yes` plans the same and writes nothing; read its `planned` before the first real run. The answer is `{ source, original: "list", documents, unchanged, pushed, pulled, adopted, removed_rows, removed_files, conflicts: [{ document, kept, because }], refused: [{ document, because }], planned? }`.

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

Some apps read one file at start (a coding harness reads AGENTS.md or CLAUDE.md), while the person keeps what it should say as rows every AI reads through the door (for instructions, the door's own `setting:ai-instruction:<id>` rows, which it lays over the shipped instructions). `--write-joined SPEC` makes that file from the rows, one direction only:

```
node tools/read-a-list-view/do-work/read-list-view.mjs --config FILE --write-joined '{"root":"/home/ada/project","name":"/AGENTS.md","type":"setting","prefixes":["setting:ai-instruction:bootstrap-"],"text_at":"value.text","order_at":"value.order","header":"<!-- Made from rows; change the rows. -->","most_bytes":8192}'
```

- The file is `header`, then the text of every row whose id starts with one of `prefixes`, in `order_at` order (then id), a blank line between. A row with no text is left out.
- It is written through `tool:change-a-document-row` only while it is still the file read, and a second run with nothing changed writes nothing.
- `most_bytes` (optional) is a size to warn at, never a refusal: a copy over it is still written, and the answer carries `warning: { code: 'copy_over_size', words }`. A file holds any number of bytes; refusing kept the old copy while every AI read stale instructions (2026-11-12). A copy with no rows is refused and the file is left as it was.
- The answer is `{ name, rows, bytes, written, identity, warning? }`; `--dry-run yes` writes nothing. The person refuses hand edits to such a file with a guard of their own, so the rows stay the original.

## Bounds

The bounds are this tool's own DATA, `limits` in `read-data/list-view.json`. Reading a list is this tool's job; the engine only stores and lists records. A caller never passes them.
- `read_page_rows` (50): a page when no limit is given, and the most one source tool's page asks for.
- `door_page_rows` (500): the most one records:list asks for, the records door's own page, so 2,000 rows are a few calls rather than forty.
- `rows_per_read` (2,000): the most rows one view read gathers. Refreshes stream bounded pages until each source ends.
- `row_sources_per_list` (8): the most row sources one list may declare.
- `write_rows` (64) and `write_bytes` (24,000): the most records and bytes one write of a refresh sends.

## Row sources

`read-data/list-view.json` holds one row per source: the tool that serves it, the input that tool gets (`{of}` is the list's `of`; `limit` and `after` are added), and where the tool's answer keeps the rows and the next cursor. Today it has two sources:
- `documents`: `tool:read-documents-as-list-rows` reads the markdown documents in a folder on the person's computer that they granted.
- `namespace-documents`: `tool:read-namespace-documents-as-list-rows` reads them from a folder of the person's Namespace files, through the files door.

In both, each document is a row and its frontmatter holds the fields. Adding a source means adding a row here.

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

- **On the person's computer**: the command line above, with their own key (`read-data/door.mjs`).
- **In a screen that shows a list**: the screen bundles `read-data/list-view.mjs` and `read-data/list-view.json`, pinned at a Workshop commit, and calls `readListView(input, door)` with a door of its own. A read needs only `read` and `list`. The rule filter comes with the module: it imports `tools/formulas`, so the screen also bundles that folder's `do-work` and `read-data/rule-operators.json`. Canonical refresh value identities reuse `tools/content-identity` (BLAKE3), so that shared module is part of the import closure too. So opening a list sends reads only. The screen's door answers `records:list` as the engine does, so a page holding a record too big for one message comes as byte pages; the screen's door joins them with `tools/records-door` `read-data/byte-pages.mjs` `wholeAnswer` before handing the page on. `refreshRowSources(input, door)` also needs `run` and `write`, and the screen calls it only when the person asks for a refresh.

It is not an engine row. A run the engine starts gets record rights for named record kinds only, and each list's rows are a kind the list itself names, so such a run could not be granted them ahead of time.

## Files

| File | Purpose |
|---|---|
| `read-data/list-view.mjs` | `readListView(input, door)`: one page of a list or a view, from records. `refreshRowSources(input, door)`: a list's row sources written as its records. |
| `read-data/list-view.json` | The bounds, the row sources and the tool that serves each. |
| `read-data/door.mjs` | `openDoor(config)`: the person's door over MCP from their computer, with `read`, `list`, `run` (through the door, or on this computer for a tool in `local_tools`) and `write`. An answer that comes as byte pages (a record too big for one message) is joined with `tools/records-door` `wholeAnswer`. A call over the key's rate (`sign_in_too_many_calls`) is sent again with the same request key after the wait the door names, so a refresh of a large list keeps going instead of stopping half read. |
| `do-work/read-list-view.mjs` | The command line above. |
| `test/read-a-list-view.test.mjs` | Tests on a made-up bakery: a refresh's writes (only what changed, removals, bounded batches, a refused row), a read that runs no tool, the bounds, a view's rules and sort, a local tool, byte pages, and the door's key handling. |
| `read-data/list-copy.mjs` | `syncRowSource(input, door)`: the two-way sync of a source declared `original: "list"`, which a refresh of that list runs. |
| `test/json-items-copy.test.mjs` | The same sync on one made-up kitchen rules file that holds many rows: every item a row, a field changed in the list reaching the file with the rest of the file kept and a list-only switch kept off it, a rule an AI wrote under its own id becoming an item, an item changed in the file reaching the list and an item removed from the list leaving the file. |
| `test/list-copy.test.mjs` | Tests on a made-up bakery's notes over the real door and the real documents tools: a new folder, a row any AI wrote, a taken name, a row another sync already made into its file, one part of a long document, both sides changed, removals on either side, a restore from an older copy that removes nothing and carries the newer files back, a value only the list changed, `paths` and a dry run. |
| `read-data/copy-readable.mjs` | `copyReadable({ names, list }, door)`: whether a list's file copy may be read now, read-only: only when the list answers one of `list-view.json` `copies_when_unreachable` codes or the door cannot be reached. A copy guard asks it (`--copy-readable LIST_ID`). |
| `test/copy-readable.test.mjs` | A list that answers keeps its copy closed with or without its record; an unavailable answer opens it and another refusal does not; a door nothing listens on opens it. |
| `test/door-rate.test.mjs` | A call over the key's rate waits the time the door names and is sent again with the same request key. |
| `read-data/joined-copy.mjs` | `writeJoinedCopy(spec, door)`: one file made from many rows' text in order. |
| `test/joined-copy.test.mjs` | One file from a made-up bakery's rule rows: order and header, nothing written twice, a changed row written, over budget or no rows refused with the file kept, a dry run and a bad spec. |

## Dependencies

**Depends on:**
- Node, or a page with a JavaScript module loader;
- the person's door;
- for a refresh, the tools its row sources name (`tools/documents-as-list-rows`);
- for a view's rules, the rule filter of `tools/formulas`, imported in the same process.
- for a refresh's writes, `writeBatches` of `tools/records-door` (`read-data/write-batches.mjs`), imported in the same process.

**Depended on by:**
- the Lists screen;
- the view publish of `tools/export-records-as-list-rows`, which calls this read.
