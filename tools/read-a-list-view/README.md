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
node tools/read-a-list-view/do-work/read-list-view.mjs --config FILE --refresh LIST_ID
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
| `transport` | `{ url, credential: { keychain_item } }`: the door's MCP address, and the name of the keychain item that holds the person's key. The key is read with `security` and is sent only in the Authorization header. Any answer that contains the key is refused. |
| `records` | `{ address, read_method, list_method, write_method? }`: where the door reads one record (`{ type, id }`), lists a page of one type (`{ type, limit, after, prefix? }`) and, for a refresh, writes records. |
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

## Bounds

The bounds are this tool's own DATA, `limits` in `read-data/list-view.json`. Reading a list is this tool's job; the engine only stores and lists records. A caller never passes them.
- `read_page_rows` (50): a page when no limit is given, and the most one source tool's page asks for.
- `door_page_rows` (500): the most one records:list asks for, the records door's own page, so 2,000 rows are a few calls rather than forty.
- `rows_per_read` (2,000): the most rows one view read gathers. Refreshes stream bounded pages until each source ends.
- `row_sources_per_list` (5): the most row sources one list may declare.
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
| `text_extensions` | An array of nonempty extension strings, forwarded unchanged. The document source permits these UTF-8 file extensions only with exact `paths`; this selects text to read and never executes source files. |
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
| `read-data/door.mjs` | `openDoor(config)`: the person's door over MCP from their computer, with `read`, `list`, `run` (through the door, or on this computer for a tool in `local_tools`) and `write`. An answer that comes as byte pages (a record too big for one message) is joined with `tools/records-door` `wholeAnswer`. |
| `do-work/read-list-view.mjs` | The command line above. |
| `test/read-a-list-view.test.mjs` | Tests on a made-up bakery: a refresh's writes (only what changed, removals, bounded batches, a refused row), a read that runs no tool, the bounds, a view's rules and sort, a local tool, byte pages, and the door's key handling. |

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
