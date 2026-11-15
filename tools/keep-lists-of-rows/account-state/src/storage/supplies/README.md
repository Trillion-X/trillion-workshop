# storage supplies

Supplies of the `Storage` contract (`src/storage/mod.rs`) for databases other than SQLite and memory. They exist to show that the record store (`src/storage/record_store/`) is coupled to the contract and to no database: the engine, the contract and the families file are not changed for any supply, and each supply runs the same conformance suite against a real running server.

This folder is its own crate (`[workspace]` in `Cargo.toml`), not a module of `trillion-local`: declaring a module needs a line in `src/storage/mod.rs`, a file another owner holds. It depends on `trillion-local` by path and on no driver by default; each wire protocol is a Cargo feature.

## Files

| File | Purpose |
| --- | --- |
| `lib.rs` | Crate root: feature-gated protocol modules, `open(kind, url, store_name)` returning a `Dynamic` supply that also counts round trips |
| `codec/mod.rs` | The contract's value order as bytes (NULL, numbers by value, text, blob), self-delimiting, so byte order is the contract order; plain form for row bodies |
| `layout.rs` | Which fields of a family are ordered (key or order fields) and which are plain, from the DATA declarations |
| `sql/mod.rs` | One supply for every relational server over a `Wire` (a pipeline of statements in one request): tables, partial orders, compare-and-set, bounded reads, batch reads (`IN` over the key) and batch writes, scopes whose opening travels with their first operation, a savepoint around each statement on a server that aborts a transaction at one failed statement, byte accounting read in the request that changes the bytes |
| `kv/mod.rs` | One supply for every ordered key-value store over a `Backend` (get, batch get, ordered range, one guarded batch): rows, orders, arrival, compare-and-set, buffered scopes that remember the rows they read |
| `kv/wal.rs` | A guarded batch for a store without a multi-key transaction, or whose transaction is smaller than the batch: pieces, a one-key commit marker, recovery; a fixed number of requests however large the batch where the store has multi-key puts and deletes (`Plain::put_many`, `delete_many`) |
| `kv/names.rs` | A key as the lowercase hex of its bytes (text order is byte order) and as its flipped hex (ascending is descending), for stores keyed by text |
| `postgres/` `mysql/` `libsql/` | `Wire`s: Postgres wire (PostgreSQL, CockroachDB), MySQL wire (MySQL, MariaDB) and libSQL's Hrana over HTTP (sqld, Turso; SQLite dialect) |
| `redis/` `dynamodb/` `s3/` `mongo/` `couchdb/` `surreal/` | `Backend`s: Redis protocol (Redis, Valkey), DynamoDB API, S3 API, Mongo wire (MongoDB, FerretDB), CouchDB HTTP, SurrealDB |
| `build.rs`, `tests/replacement/store_under_test.rs`, `tests/conformance.rs` | Builds the parent's `tests/records_conformance.rs` with only its `Engine` chooser replaced, so a supply passes the parent's own test bodies or it does not |
| `tests/differential.rs` | The same random operations against the memory supply and the supply under test, over every order kind and every `When` |
| `tests/roundtrips.rs` | Network round trips per create, update, current read, as-of read and page of 100 |
| `tests/write_reads.rs` | Reads per write on a seeded store, relational (SQLite through rusqlite) and key-value (an in-process map), held to the memory supply's count; another handle's commit still reloads |
| `engines/` | `servers.txt` (label, supply, URL per local server), `servers.sh` (start or remove one throwaway server on RAM), `run-servers.sh` (run the suites against each), `keep-binaries.sh` (keep the compiled suites between runs), `summarize.py` (the result tables) |

## Running

```bash
cd "$(git rev-parse --show-toplevel)"
python3 "$HOME/dev/ai-command-center/.claude/hooks/run-contained-cargo.py" test --no-run \
  --features postgres,mysql,redis,dynamodb,s3,mongo,couchdb,surreal,libsql \
  --manifest-path src/storage/supplies/Cargo.toml \
  --then bash src/storage/supplies/servers/keep-binaries.sh {cargo_target_dir} .local/supplies-bin
MANAGE_SERVERS=1 SUPPLY_HISTORY_VERSIONS=300 bash src/storage/supplies/servers/run-servers.sh \
  .local/supplies-bin .local/supplies-runs/<run> differential,conformance,roundtrips [engine...]
python3 src/storage/supplies/servers/summarize.py .local/supplies-runs/<run>
```

`SUPPLY_HISTORY_VERSIONS` shortens the as-of case's long history (the parent writes 100,000 versions); the `asof` suite runs that case alone at the parent's full length. `STORAGE_SUPPLY_DEBUG=1` prints the driver error behind a mapped `storage::Error`.

## Batches and round trips

`read_many` and `write_many` (contract, `../mod.rs`) are one request on every supply here except S3-compatible storage, MongoDB, FerretDB and DynamoDB, whose `read_many` is a batch get followed by one request per range. `read_many` takes point gets and ranges in one list; a change reads the record's current row and the exit step's three ranges in one `read_many`, so a relational create is 3 round trips (opening and reads, writes with the byte total, commit) and a Redis, Valkey or SurrealDB create is 2 (reads, commit):

| Supply | `read_many` | `write_many` / a scope's writes |
| --- | --- | --- |
| Postgres, CockroachDB | a run of gets of one family is one `SELECT ... WHERE (key fields) IN (...)` per 10,000 parameters, each range one `SELECT`, all in one request | the statements in one simple-query request, each between a savepoint and its release |
| MySQL, MariaDB | the same statements | the statements in one multi-statement text request; a savepoint marks the end of a scope's opening |
| libSQL | the same statements | one Hrana `batch` request whose steps each run only if the one before succeeded |
| Redis, Valkey | one Lua script: the keys and every range, atomically | one Lua script for the whole commit |
| DynamoDB | `BatchGetItem`, 100 keys; each range its own `Query` | `TransactWriteItems` (up to 99 writes; more go through the record protocol) |
| MongoDB | `find` with `$in`; each range its own `find` | an `update` command and a `delete` command inside the transaction |
| FerretDB, CouchDB | `find $in` and a `find` per range (FerretDB); one `_all_docs/queries` request (CouchDB) | the record protocol with `update`/`delete` commands (FerretDB) or `_bulk_docs` (CouchDB) |
| SurrealDB | the keys' `SELECT` and each range's `SELECT` as the statements of one request | one `BEGIN ... COMMIT` request |
| S3, MinIO | a loop of GETs: S3 has no multi-get | a loop of PUTs and DELETEs: S3 has no multi-put |

An outermost write scope on a key-value store takes the store's write hold with its first read: it writes its handle's hold into the header, guarded by the header it read (one more request per write scope, measured by `roundtrips` on 2026-11-04). Since the mark leaves out the handle's own commits, a write no longer reloads the record store's stamps and search memory: by `roundtrips` on local throwaway servers on 2026-11-04, a Redis create is 4 requests (9 before) and an update 5 (11 before), a PostgreSQL create 4 (8 before) and an update 4 (8 before). Another handle's write scope that meets a live hold is refused `Busy` at once, as SQLite refuses a second `BEGIN IMMEDIATE`; one that read the header before the hold fails its commit guard. A hold runs out 30 s after it is taken (`kv/mod.rs` `HOLD_MS`), so a process that ended while holding one keeps writers out only that long; a holder whose hold ran out cannot commit, because its guard fails. Folding the hold into Redis's read script would take the extra request away; it is not done yet.

A scope on a key-value store also remembers every row it reads (up to 16 MiB), so a row the engine reads and then writes is read once. The commit is guarded by the header the scope saw with its first read of the store (the header is the first key of that request, so it is never newer than anything read after it), so a remembered row that another handle changed in between makes the commit `Busy` and applies nothing.

## What does not map

The measured results and the per-engine detail are in the AICC project note `notes/projects/trillion-storage-convergence-2026-10-27/storage-supplies-conformance.md`. In short:

- A scope on a key-value store is a write buffer in the process that commits as one guarded batch. Only a backend with a real multi-key transaction (Redis scripts, Mongo replica set, SurrealDB, DynamoDB up to 99 writes) commits it atomically for every reader; the others (S3, CouchDB, standalone FerretDB, a larger DynamoDB scope) are crash-atomic and a concurrent reader can see a batch half applied. `Backend::atomicity` says which.
- `mark` and `custody` are a header key and an identity key the supply keeps; `schema_mark` is constant (no supply here changes shape under a running handle).
- `mark` is the stored commit counter less the commits this handle made (and, inside an outermost relational write scope, less its own pending step), so like SQLite's `data_version` it moves only when another handle commits. The record store keeps its newest stamps and search memory across its own writes; when the counter also counted the handle's own commits, every write reloaded them: on a store of 200 records whose search tail is not flushed yet, 8 seeks and 203 rows read per update where the memory supply makes 4 and 1, because the search reload reads every row changed since the newest search segment (up to `flush_records`). `tests/write_reads.rs` holds a seeded store's reads per write on both supplies to the memory supply's count.
- `reclaim` is `VACUUM FULL` / `OPTIMIZE TABLE` / `compact` where the server has one, `Ok` where a delete leaves nothing (S3), `Unavailable` otherwise (CockroachDB, Redis without an AOF rewrite, DynamoDB).
- `allocated_bytes` on a relational server is the sum of its columns' bytes, kept by triggers inside the transaction. It is the logical bytes the rows hold, not the server's file size: MySQL and MariaDB refresh their catalog sizes lazily and leave off-row values out.

## Dependencies

**Depends on:** `trillion-local` (path), `serde_json`, and per feature: `postgres`, `mysql`, `redis`, `ureq` + `base64` (DynamoDB, CouchDB, SurrealDB), `ureq` + `hmac` + `sha2` + `chrono` (S3 request signing), `mongodb`.

**Depended on by:** nothing in `trillion-local`; the results note under the AICC project folder `trillion-storage-convergence-2026-10-27/`.
