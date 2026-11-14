# Visual Database Native JSCore Surface

This folder contains the JavaScriptCore screen-command mount for `visual-database`.

The file is intentionally browserless. It talks through the sealed mount bridge with `runtime.target.invoke`, emits `native.view.snapshot.replace`, and disposes with `native.view.snapshot.dispose`.

## Files

| File | Purpose |
|------|---------|
| `mount-visual-database-jscore.js` | The entire native mount: model decode (records/fields/views/actions with field discovery + fallback view), view builders (list/board/timeline/swimlanes/table), explicit-target action interpretation, action envelope dispatch |

## View parity with the browser surface

- The list view mirrors the browser's Amie date buckets (`dateBucketOf`: Earlier/Yesterday/Today/Tomorrow/Later/No date) with completed records (success-tone lane) always separated into a trailing Completed section; Today and Completed persist at 0-count.
- Descriptor-defined metadata is preserved in the native snapshot. Badge fields, due/claim values, attachment refs, and proof refs render as compact chips instead of being dropped by the mobile bridge.
- Defaults are honest: no in-code field/view seeds — fields are discovered from observed records, views fall back to one unscoped list.
- Action dispatch has the same descriptor contract as the browser helper: executable descriptors must carry a target; missing targets produce a generic `missing-target` descriptor error instead of a workflow fallback.

## Dependencies

**Depends on:** the sealed mount bridge only (`runtime.target.invoke`).
**Depended on by:** `things-to-store-and-run.json` native-screen-command entry.
