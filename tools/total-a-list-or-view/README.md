# tools/total-a-list-or-view/

Totals over one of a person's lists, or one of its saved views, without reading the rows: how many rows, and the sum, average, median, smallest or largest of a field, over the whole list or for each value of one field.

This is old Trillion's `read_list_aggregates` (`src/list-tools.mjs:171`, which called `POST /lists/<id>/aggregate`), moved over unchanged: the arithmetic is `aggregateRows` in `tools/query-and-change-list-rows/src/list-aggregates.mjs`, and the lists are read through the records door by the list owner (`tools/keep-lists-of-rows/lists.mjs`) the way `tools/keep-my-calendar-in-my-accounts-own-records-with-its-lists-files` reads them. The measures are rows of `tools/keep-and-wake-ai-sessions-on-this-computer/src/lists.json` `aggregates`; nothing here names one.

## Running it

`tool:total-a-list-or-view` through `tools:run` with:

| Input | Holds |
|---|---|
| `list_id` | The list's record id, like `list:orders`. The run's right to read that one record is filled from it. |
| `type` | The kind of the list's rows, `record:` and the list's `row_type` (`record:order`). The run's right to read and list that kind is filled from it. A `type` that is not the list's row kind is refused. |
| `measures` | `[{ op, field? }]`, at most 20: `count` (rows), `filled` or `distinct` (any field), `sum`, `average`, `median`, `min`, `max` (a number field). |
| `group_by` | Optional. A field of the list: one set of totals for each value it holds (at most 100 groups; a field of several tags counts the row once per tag). |
| `view_id` | Optional. A saved view of the list: only the rows it keeps are totalled, read the way the page shows the view. |

It answers `{ list_id, view_id?, rows_counted, complete, measures: [{ field, op, label, value }], group_by?, groups?: [{ key, rows, measures }], groups_more? }`. `complete` is false when it stopped before the end (20,000 rows), so a partial total is never taken for the whole.

## What the run may reach

It writes nothing. It may read the one list record named by `list_id`, read and list the rows' kind named by `type`, and read and list saved views (`list-view`) and saved filters (`list-filter`). Those two are definitions of lists (rules), not rows, and the list owner lists them by a prefix of the list's slug, which a run's grant cannot be filled with; no other kind is reachable.

## Files

| File | Purpose |
|---|---|
| `do-work/total-a-list.mjs` | `totalAList(input, { door })`: checks the list and its row kind, then runs `aggregateRows` over the records door. |
| `tool-rows.json` | The one row, `tool:total-a-list-or-view`, with a sample run. |
| `test/total-a-list-or-view.test.mjs` | Totals, groups and a saved view over a made-up bakery's orders, run as the container runs the row against the fake records door with exactly the row's rights. |
