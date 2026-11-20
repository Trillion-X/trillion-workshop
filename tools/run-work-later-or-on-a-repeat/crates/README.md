# crates/

The Cargo workspace of the timed-action engine. The one member is `timed-action/`: wall time, recurrence, due evaluation, spreads, quiet hours, zone
drift and the scheduled-action writes. It replaced the TypeScript that was in `../do-work/` and `tools/wall-time` (deleted in
the same landing).

Build it two ways with `tools/build-engine-modules-for-web-hosts/build/build-timed-action.mjs` (the only writer of
`../built-stored-bytes/`). Its tests are `cargo test` here; `cargo clippy --all-targets -- -D warnings` must be clean.

| Path | Purpose |
|------|---------|
| `Cargo.toml` | The workspace: `serde_json` with `preserve_order`, `wasm-bindgen` pinned to the CLI the build script finds (0.2.120) |
| `timed-action/src/requests.rs` | The one table of exports (the TypeScript's camelCase names) and their request shapes |
| `timed-action/src/host.rs` | The wasm-bindgen exports for pages and Node tools (`wasm32-unknown-unknown`) |
| `timed-action/src/main.rs` | The WASI command: export name as argument, request on stdin (`wasm32-wasip2`) |
| `timed-action/tests/ported_cases.rs` | The TypeScript-era test cases, ported one for one, through `requests::call` |
