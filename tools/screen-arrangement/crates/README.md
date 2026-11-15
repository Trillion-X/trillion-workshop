# crates/

The Cargo workspace of this tool: `screen-arrangement/`, the screen arrangement's layout math (split, move, close, focus and float panes and tabs) as one pure JSON-in/JSON-out step, so every arrangement change is decided here and never re-calculated in TypeScript. Built for the page as a plain wasm-bindgen module by `tools/build-engine-modules-for-web-hosts` into `built-stored-bytes/screen-arrangement/`.

## Files

| Folder | Purpose |
|--------|---------|
| `screen-arrangement/` | Split, freeform and overlay arrangement transitions; `src/run_in_a_page.rs` is the page entry (`arrange_screen`). |

## Dependencies

**Depended on by:** `tools/build-engine-modules-for-web-hosts` (`PAGE_COMPILED_MODULES`).
