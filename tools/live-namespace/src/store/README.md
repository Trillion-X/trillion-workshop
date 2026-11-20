# src/store/

Where the person's files keep their names index: the names, folders, files, chunks, aliases and spans, and the few small rows beside
them, as plain rows in the person's own SQL database. `Rows` is the whole of what the account files ask of it; `SqlStore` is its one
implementation, over SQLite (a file of the person's own) or Postgres (the person's database), the same statements.

## Files

| File | Purpose |
|------|---------|
| `mod.rs` | `Rows` (the trait), `SqlStore` (its implementation), `Record`, `Mutation`, `Change`, `Page`, `Total`, `Error`, and the tests |
| `link.rs` | `Link`: one connection to SQLite or Postgres behind `query`, `execute`, `batch` and the transaction brackets; `Cell`, `Dialect` |
| `tables.json` | DATA: which table keeps which scope, each table's columns, and the declared totals |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `Rows::get` / `get_many` | `(scope, id)` / `(scope, &[id])` | One row, or rows in the order asked (none where there is none) |
| `Rows::get_scoped` | `&[(scope, id)]` | Rows of many scopes read together, in the order asked; one read per table, not per scope (`newest_of_many` reads every identity's results this way) |
| `Rows::list_page` / `ids` | `(scope, after, limit)` | A scope in id (byte) order strictly after a cursor, at most 1000 rows and 4 MiB a page |
| `Rows::mutate` | `(scope, Mutation { id, expected_version, request_key, deleted, value }) -> Change` | Make, change or delete one row only if it is at `expected_version` (0: not there yet; a deleted row keeps its version) |
| `Rows::held_record_with_version` | `(scope, id) -> (version, Option<Record>)` | The version a change must name, tombstones included |
| `Rows::stamp` | `(scope) -> i64` | How many changes the scope has had |
| `Rows::totals` | `() -> Vec<Total>` | The declared totals: files by store, names, chunks and uploads, with their bytes |
| `Rows::search` | `(&[word], hits) -> Vec<Record>` | File rows whose names together hold every word (candidates; `account_files/words.rs` decides) |
| `Rows::order` | `() -> i64` | The last number of the store's one change order (`ns_order`); every change takes the next inside its own transaction |
| `Rows::changes` | `(&[prefix], after, limit) -> Page<Changed, i64>` | The rows and tombstones of some scopes whose last change is after a number, in change order; a cursor never expires |
| `Rows::minted` | `(&[prefix], minted) -> Option<(scope, Record)>` | The live row holding a minted id (tables.json `minted`, the stable `item` of names and folders) |
| `Rows::wait_for_order` | `(after, until) -> i64` | Holds until a change past `after` commits (this process at once; on Postgres any process, by `NOTIFY` heard on the connection `SqlStore::hearing` gives) or `until` |
| `SqlStore::open` / `memory` | `(Link)` / `()` | Rows in a database, its tables made when they are not there / rows that live as long as the store |

## How it works

- A scope is the string a family of rows is kept under (`@namespace/files`, `@namespace/names/<folder>`). `tables.json` says which table
  holds a scope; a scope no table claims is in `ns_record`, one JSON value a row.
- A record is one flat object. A field whose value fits its column (a whole number, text, a list or object as JSON text) is in that
  column; any other field is in `extra`, so no record loses a field.
- A change is one transaction: the row, its tombstone or version, and the scope's stamp. The version, the last request key and its
  identity are on the row, so the retry of a row's last change answers that change again and another change under that key is a conflict.
- A change that would leave the row as it is writes nothing.
- Ids are compared as bytes in both databases (`COLLATE "C"` in Postgres), so a walk by cursor is the same everywhere.
- Totals and word search are asked of the database when they are called, not kept: nothing to drift from the rows.
- Every change takes the next number of one change order for the whole store (`ns_order`, its row locked to the commit, so changes commit
  in their order) and the row or its tombstone keeps it as `changed`; `changes` walks it after a cursor. A table's `minted` column
  (tables.json) is filled by the store from the same order for a new row, kept by a changed row and its tombstone, and carried by a value
  that holds it (a rename).

## Dependencies

**Depends on:** rusqlite (bundled SQLite), postgres and tokio-postgres-rustls (Postgres, encrypted), serde_json, content-crypto (BLAKE3 for a change's identity), `crate::refusal_cause`.

**Depended on by:** `src/account_files` (every record it reads or changes), `src/serve` (opens the rows).
