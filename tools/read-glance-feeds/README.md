# tools/read-glance-feeds/

Reads one glance feed or an ordered surface of feeds from the person's own records through `records-door`. The feed's
record type, prefix, row path, filters, order and displayed fields are DATA in `read-data/glance-feeds.json`; the reader
contains no feed IDs, product-specific record types or API routes.

A source may instead name a packaged reader with `{ module, export, input?, rows }`. The relative module and export
come only from trusted package DATA, never the action input. That function receives `(input, { door })`; `rows` selects
its returned array. This composes an existing record-layout owner without copying its migration rules into each feed.
Missing readers, wrong shapes, denied reads and the source-row bound still return an unavailable feed.

## Call

The Workshop action is `tool:read-glance-feeds`.

Input is `{ "feed": "told" }` or `{ "surface": "watch", "limit": 20 }`. Give exactly one of `feed` or `surface`.
`limit` is a positive whole number per feed and defaults to 50.

The result is `{ feeds: [{ id, label, about, status, empty?, rows?, error? }] }`, with `surface` added when requested.
`status` is `ready` with `empty` and `rows`, or `unavailable` with `error: { code, message }`. An empty `rows` array
means a successful empty read. A failed, denied or malformed record read is unavailable, never an empty feed. Each ready
row has `{ id, title, source, flagged }`, and may also have `detail`, `note`, `open`, `time`, `fraction`, `read` or
`actions`. `source` is the exact raw row from the record; this keeps action data and read state available to Watch.

Surface reads run each declared feed concurrently and return them in the order in DATA. A surface naming an unknown
feed is invalid rather than partially returned.

## Current data coverage

The feeds read `record:habit`, `record:waiting-on-you`, `record:pursuit`, and waiting `ai-job` records under matching
prefix rights. `told` and `running` compose the existing told reader, which owns the legacy whole-head and current
indexed notice layouts. They require the same notice-kind list right as the notices tool. Current index membership is
preserved, so orphaned old item records never reappear as live notices. Running reports retain their actual progress.
The historical `today`, `needle-mover` and `decisions` feeds remain in the surface DATA
and return `unavailable` with an explicit reason because their current record contracts are not adopted here. A failed
read of one source also returns that feed as unavailable while successful siblings are returned in DATA order.

## Files

- `read-data/glance-feeds.json`: record source queries, feed projections and surface order.
- `read-data/glance-feeds.mjs`: generic feed reader.
- `do-work/read-glance-feeds.mjs`: command line entry point.
- `tool-rows.json`: registered action and its narrow record rights.
- `test/read-glance-feeds.test.mjs`: projection, ordering, filtering, concurrency and failure tests.
