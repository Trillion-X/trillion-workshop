# tools/read-a-list-view/

Reads one page of what a person's list shows: its own rows and the rows from each of its row sources, through the person's own door. The list's own rows are the records of its row type. Each row source the list declares (`row_sources: [{ source, of, match? }]`) is read by running the tool that serves it, so nothing is copied into the list. With a saved view, the person's rule-filter tool decides which rows the view's rules keep, and they come in the view's order. It writes nothing.

Ported from:
- the read path of the lists in the earlier Trillion app (`src/lists.mjs` `withRowSources`): own rows first, then each source in order;
- the view read of `tools/export-records-as-list-rows` (`read-data/view_publish.py`): the rule filter, then the sort.

## Running it

From the root of the Workshop checkout, on the person's own computer:

```
node tools/read-a-list-view/do-work/read-list-view.mjs --config FILE (--list ID | --view ID) [--after CURSOR] [--limit N]
```

It prints the page as JSON: `{ list, fields, rows: [{ id, record_id?, values, title, source? }], next, complete, of? }`. `values` is each row's whole value, not only the view's columns. `record_id` is an own row's full record id. `of` is how many rows a view read before its rules kept some. Pass `next` as `--after` to read the next page; it is null on the last page. If it cannot read the page, it exits 2 and says why on standard error.

The config is JSON. Nothing in the code names a list, view, record type, address or tool; the config names them all:

| Key | Holds |
|---|---|
| `transport` | `{ url, credential: { keychain_item } }`: the door's MCP address, and the name of the keychain item that holds the person's key. The key is read with `security` and is sent only in the Authorization header. Any answer that contains the key is refused. |
| `records` | `{ address, read_method, list_method }`: where the door reads one record (`{ type, id }`) and lists a page of one type (`{ type, limit, after }`). |
| `tools` | `{ address, run_method }`: where the door runs a tool (`{ tool, input }`). |
| `names` | `{ list_type, list_record, row_type, view_type? }`: the type of a list's record and its id (`{list_id}` marks where the list's id goes), the type of its rows (`{row_type}`), and the type of a saved view. |
| `filter` | `{ tool }`: the person's rule-filter tool. Needed only for a view that has rules. |
| `sources` | More row sources, shaped like the rows of `read-data/list-view.json`. |
| `source_answer_bytes` | The room a source tool's answer has in the door's reply, sent to each source as `most_bytes`. A door answers a run within one MCP message, and the local door's message is 65,536 bytes holding the answer twice (as text and as structured content), so a page of big documents would otherwise make an unknown outcome. 28,000 leaves room for the run's envelope and the text copy's escapes. |

## How a page is made

- The list's own rows come first, then each source's rows in the order the list declares them. A source row's id is `<source>~<its id>`. A cursor shows where the page stopped, including inside a source (`src~<index>~<that source's cursor>`), so nothing is lost or repeated from one page to the next.
- A page holds `--limit` rows, or `read_page_rows` when no limit is given, and never more than `rows_per_read`. Each records:list and each source page asks for at most `read_page_rows`, because the door refuses a page of 2,000, and the read asks again until the page is full.
- A list that declares more than `row_sources_per_list` sources is refused. So is a source that no row serves, and a source tool that answers no rows: missing rows are never shown as an empty list.
- A view with rules or a sort needs every row before it can order them. It reads at most `rows_per_read` rows in all, keeps the positions the rule filter answers (the filter gets only the fields the rules read), sorts them, and then pages through them. `complete` is false when the list had more rows than `rows_per_read`. The sort compares values by the bytes of their canonical JSON (keys sorted, no spaces), from the last sort entry to the first, with empty values last. This is the order the view publish used, so a published file's hash does not change.

## Bounds

The bounds of a list read are this tool's own DATA, `limits` in `read-data/list-view.json`. Reading a list is this tool's job; the engine only stores and lists records. A caller never passes them.
- `read_page_rows` (50): a page when no limit is given, and the most one request asks for.
- `rows_per_read` (2,000): the most rows one read gathers.
- `row_sources_per_list` (4): the most row sources one list may declare.

## Row sources

`read-data/list-view.json` holds one row per source: the tool that serves it, the input that tool gets (`{of}` is the list's `of`; the page's `limit` and `after` are added), and where the tool's answer keeps the rows and the next cursor. Today it has two sources:
- `documents`: `tool:read-documents-as-list-rows` reads the markdown documents in a folder on the person's computer that they granted.
- `namespace-documents`: `tool:read-namespace-documents-as-list-rows` reads them from a folder of the person's Namespace files, through the files door.

In both, each document is a row and its frontmatter holds the fields. Adding a source means adding a row here.

## Where it runs

On the person's computer, with their own key. A row the engine runs gets record rights for named record kinds only. A list's rows are a kind the list itself names, so a run in the engine could not be granted them ahead of time. A screen that shows a list calls `readListView` with a door of its own (`read`, `list`, `run`).

## Files

| File | Purpose |
|---|---|
| `read-data/list-view.mjs` | `readListView(input, door)`: one page of a list or a view. |
| `read-data/list-view.json` | The bounds of a read, the row sources and the tool that serves each. |
| `read-data/door.mjs` | `openDoor(config)`: the person's door over MCP from their computer, with `read`, `list` and `run`. |
| `do-work/read-list-view.mjs` | The command line above. |
| `test/read-a-list-view.test.mjs` | Paging across own rows and a source, the bounds, a view's rules and sort, and the door's key handling, on a made-up bakery. |

## Dependencies

**Depends on:** Node; the person's door; the tools its row sources name (`tools/documents-as-list-rows`); the person's rule-filter tool (`tools/formulas`) for a view's rules.

**Depended on by:** a screen that shows a list, and the view publish of `tools/export-records-as-list-rows`, which calls this read.
