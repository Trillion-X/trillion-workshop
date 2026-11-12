# tools/choose-the-feed-each-widget-shows/

Which feed each widget on a glance surface shows. A person picks a feed for a widget when they add or edit it; a widget whose feed was never picked takes the surface's feed at its size's place, so no two sizes start on the same feed. The caller reads the widgets and the rows each feed has kept from the person's records and hands them over. Nothing is read, kept or drawn here.

Ported from old trillion `ios/Activity/GlanceFeeds.swift`, `GlanceFeed.unpicked(at:)` and `bundledSurface()` at commit `38a3d8ec5e` (the default-feed rule). The surface order and feed ids are the Workshop's `read-glance-feeds/read-data/glance-feeds.json`, which carries the old `records/glance-feeds.json` `surfaces`.

## Rule

- Places: small 0, medium 1, large 2, extra large 3 (the old commit's "small the first feed, medium the second, large the third, extra large the fourth").
- Feeds taken first are the surface's feeds with rows; before any row is kept, every feed of the surface counts. The place wraps round the list.
- A picked feed is shown whatever its size; any feed id the glance DATA names is allowed.

## Files

| File | Purpose |
|------|---------|
| `do-work/choose-the-feed-each-widget-shows.mjs` | `tool:choose-the-feed-each-widget-shows`: one JSON input on standard input, `{ result }` or `{ error }` on the last line. |
| `test/choose-the-feed-each-widget-shows.test.mjs` | Tests for the places, the rows-first order with wrap, picked feeds, and refusals. |
| `tool-rows.json` | The Workshop row. |

## Dependencies

**Depends on:** `read-glance-feeds/read-data/glance-feeds.json` (packed by the row).

**Depended on by:** `tool-rows.json`, the test.
