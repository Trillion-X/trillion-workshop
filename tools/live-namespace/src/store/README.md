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
| `copy-from-archive.sql` | The `INSERT ... SELECT` a table that copies the account owner's archive tables in |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `Rows::get` / `get_many` | `(scope, id)` / `(scope, &[id])` | One row, or rows in the order asked (none where there is none) |
| `Rows::list_page` / `ids` | `(scope, after, limit)` | A scope in id (byte) order strictly after a cursor, at most 1000 rows and 4 MiB a page |
| `Rows::mutate` | `(scope, Mutation { id, expected_version, request_key, deleted, value }) -> Change` | Make, change or delete one row only if it is at `expected_version` (0: not there yet; a deleted row keeps its version) |
| `Rows::held_record_with_version` | `(scope, id) -> (version, Option<Record>)` | The version a change must name, tombstones included |
| `Rows::stamp` | `(scope) -> i64` | How many changes the scope has had |
| `Rows::totals` | `() -> Vec<Total>` | The declared totals: files by store, names, chunks and uploads, with their bytes |
| `Rows::search` | `(&[word], hits) -> Vec<Record>` | File rows whose names together hold every word (candidates; `account_files/words.rs` decides) |
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

## Copying the account owner's rows in

The archive's `ns_name`, `ns_folder`, `ns_file`, `ns_chunk`, `ns_alias` and `ns_spans` are the same columns as here, so each copies in with one
`INSERT ... SELECT` (`copy-from-archive.sql`): `scope` is made from the row's own id, `version` is 1 and an empty archive `extra` is no extra. The
test `the_archive_tables_copy_in_with_one_insert_select_each_and_read_back_as_the_files_expect` runs that file over archive-shaped tables and reads
the copy through `Rows`. The archive has 912,272 names, 128,859 folders, 670,627 files, 767,895 chunks, 63,700 aliases and 165,674 span rows.

## Dependencies

**Depends on:** rusqlite (bundled SQLite), postgres and tokio-postgres-rustls (Postgres, encrypted), serde_json, content-crypto (BLAKE3 for a change's identity), `crate::refusal_cause`.

**Depended on by:** `src/account_files` (every record it reads or changes), `src/serve` (opens the rows).
