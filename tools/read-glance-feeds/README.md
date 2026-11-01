# tools/read-glance-feeds/

Reads one glance feed or an ordered surface of feeds from the person's own records through `records-door`. The feed's
record type, prefix, row path, filters, order and displayed fields are DATA in `read-data/glance-feeds.json`; the reader
contains no feed IDs, product-specific record types or API routes.

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

The live feeds read `record:habit`, `record:waiting-on-you`, `record:pursuit`, `told-the-person:<seq>`, and waiting
`ai-job` records, each under a matching prefix right. The `told` row path is `value.item`, matching the Workshop
notices record shape. The historical `running`, `today`, `needle-mover` and `decisions` feeds remain in the surface DATA
and return `unavailable` with an explicit reason because their current record contracts are not adopted here. A failed
read of one source also returns that feed as unavailable while successful siblings are returned in DATA order.

## Files

- `read-data/glance-feeds.json`: record source queries, feed projections and surface order.
- `read-data/glance-feeds.mjs`: generic feed reader.
- `do-work/read-glance-feeds.mjs`: command line entry point.
- `tool-rows.json`: registered action and its narrow record rights.
- `test/read-glance-feeds.test.mjs`: projection, ordering, filtering, concurrency and failure tests.
