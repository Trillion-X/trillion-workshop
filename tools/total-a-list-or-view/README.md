# tools/total-a-list-or-view/

Totals over one of a person's lists, or one of its saved views, without reading the rows: how many rows, and the sum, average, median, smallest or largest of a field, over the whole list or for each value of one field.

This is old Trillion's `read_list_aggregates` (`src/list-tools.mjs:171`, which called `POST /lists/<id>/aggregate`), moved over unchanged: the arithmetic is `aggregateRows` in `tools/query-and-change-list-rows/src/list-aggregates.mjs`, and the lists are read by the list owner (`tools/keep-lists-of-rows/lists.mjs`) over the records the caller hands in. The tool has no records door and keeps nothing: your AI reads the list, its rows and its saved views from the store that holds them and passes them in `records`. The measures are rows of `tools/keep-and-wake-ai-sessions-on-this-computer/src/lists.json` `aggregates`; nothing here names one.

## Running it

`tool:total-a-list-or-view` through `tools:run` with:

| Input | Holds |
|---|---|
| `list_id` | The list's record id, like `list:orders`. |
| `type` | The kind of the list's rows, `record:` and the list's `row_type` (`record:order`). A `type` that is not the list's row kind is refused. |
| `records` | `[{ id, type, value }]`: the list record (type `list`), its rows (type `record:<row_type>`) and, for `view_id`, its saved views and filters (types `list-view`, `list-filter`), as the store that holds them returned them. Nothing else is read. |
| `measures` | `[{ op, field? }]`, at most 20: `count` (rows), `filled` or `distinct` (any field), `sum`, `average`, `median`, `min`, `max` (a number field). |
| `group_by` | Optional. A field of the list: one set of totals for each value it holds (at most 100 groups; a field of several tags counts the row once per tag). |
| `view_id` | Optional. A saved view of the list: only the rows it keeps are totalled, read the way the page shows the view. |

It answers `{ list_id, view_id?, rows_counted, complete, measures: [{ field, op, label, value }], group_by?, groups?: [{ key, rows, measures }], groups_more? }`. `complete` is false when it stopped before the end (20,000 rows), so a partial total is never taken for the whole.

## What the run may reach

Only the records in its request. It has no records door, writes nothing and keeps nothing; the totals come back in the answer. A saved view or filter the list names is read from `records`, so hand those in too when `view_id` is asked.

## Files

| File | Purpose |
|---|---|
| `do-work/total-a-list.mjs` | `totalAList(input)`: checks the list and its row kind, then runs `aggregateRows` over the records in the request. |
| `tool-rows.json` | The one row, `tool:total-a-list-or-view`, with a sample run. |
| `test/total-a-list-or-view.test.mjs` | Totals, groups and a saved view over a made-up bakery's orders, run in process over the records in the request with no door; and the row declares none. |
