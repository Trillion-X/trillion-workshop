# built-stored-bytes/

The timed-action engine built from `../crates/timed-action` by `tools/build-engine-modules-for-web-hosts/build/build-timed-action.mjs` (the only writer). Regenerate; never edit.

## Files

| File | Purpose |
|------|---------|
| `timed-action/timed_action_bg.wasm` | The crate's library compiled for `wasm32-unknown-unknown` |
| `timed-action/timed_action.js` | wasm-bindgen `web` glue: `initSync({ module: bytes })` in Node and Workers, `init({ module_or_path })` in a page; then each export is a direct call into the engine |
| `component/timed-action.wasm` | The crate's command compiled for `wasm32-wasip2`: the export name is argv[1], the request is read on stdin, the answer is `{"result": ...}` or `{"error": ...}` |

The zones are jiff's bundled tz database, compiled into both files, so no host zone data is read.

## Dependencies

**Depends on:** `../crates/timed-action`, `../do-work/quiet-hours.json` (read into the build).

**Depended on by:** `../do-work/timed-action.mjs` (Node), `../do-work/timed-action-in-a-page.mjs` (pages, Workers), and the tool rows in `../tool-rows.json` (the component).
