# tools/live-records/rows-store/

The person's rows in their own SQL database behind one small trait, and the refusal causes every error here carries. A crate two tools share:
`tools/live-records` (the person's records) and `tools/live-namespace` (the person's files), so there is one copy of the store.

## Files

| File | Purpose |
|------|---------|
| `src/lib.rs` | The crate: `store`, `refusal_cause` and the macros of the causes (exported at the root) |
| `src/store/` | `Rows` (what the files ask), `RecordRows` (what the records ask: ranges, several rows in one transaction, scopes, text), `SqlStore`; its own README says how |
| `src/cause_book/` | The engine's refusal causes, moved from `tools/live-namespace` (see `../moved-from.json`) |
| `content-crypto/` | BLAKE3 and the other primitives the identities use, moved from `tools/live-namespace` |

## Dependencies

**Depends on:** rusqlite (bundled SQLite), postgres and tokio-postgres-rustls, serde_json, content-crypto.

**Depended on by:** `tools/live-records`, `tools/live-namespace` (it re-exports `store`, `refusal_cause` and the cause macros under its own root).

## Build and test

    cd tools/live-records/rows-store && cargo test

The crate is its own workspace, so its cause coordinates are taken from its own root.
