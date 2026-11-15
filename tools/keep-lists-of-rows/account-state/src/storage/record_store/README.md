# record store

The record store. Each record has one current row, and a version gets a history row only when it is replaced.
Request receipts live in a bounded ring inside the current row. Search goes through one port whose shipped layout is daily-flushed segments: changes wait in a memory tail at 0 rows per write and are persisted as packed segments inside writes. A destroyed
record cannot be read from the moment it is destroyed, and its rows are physically removed when the undo window
ends. The store implements `crate::records::Records`.

It uses only the storage boundary (`crate::storage::Storage`), so the same code runs on the in-memory supply and on
the SQLite supply. It asks for many rows together (`read_many`: a declared-order page reads its records, a search its
candidates, a segment its parts, an import its ids in one batch each; a change reads the record's current row together
with the exit step's three ranges) and sends the writes of one step together
(`write_many`: a change's version rows and order rows; a segment's parts; a custody exit's erases), so a supply on a
network pays a request for each batch rather than for each row. The counted work (`Work`: seeks and rows read) is
still in logical reads, so a batch of k keys counts k seeks. Design: storage-convergence plan section 5a (`notes/projects/trillion-storage-convergence-2026-10-27/plans/2026-10-27-how-trillion-saves-and-reads-data.md`
in ai-command-center). Logic taken from the simulator candidate `simulation/src/candidates/s2h_history_on_replace.rs`
and `receipts.rs`, without the simulator's SQL.

## Files

| File | Purpose |
| --- | --- |
| `mod.rs` | `RecordStore<S: Storage>`: the `Records` operations plus `as_of`, `search`, `erase`, `restore` and `retire`; stamps; the exit step |
| `ring.rs` | `Ring` / `Receipt`: the receipt ring inside the current row |
| `search.rs` | `Layout` (DATA; shipped: `segments`), `Term`, `terms`, `words` |
| `segments.rs` | The `segments` search engine: the per-scope memory tail, flush inside writes (a write never merges), merges in resumable steps of about `merge_bytes` run by idle upkeep (`search_merge`), exact confirmation by current stamp, the bounded cold start, erase rewrites of covering segments, and undo on rollback; `search`; the search walk (`search_walk`, `search_ready`) that indexes the rows a scope held before its index or its current terms existed, a page per step, its frontier and cursor kept in `search_walk` |
| `follow.rs` | `apply_from_writer` (a copy applies the writer's changes, refusing stale terms and out-of-order changes), `FeedSource`, `catch_up` |
| `orders.rs` | Declared field orders: `Declared` (DATA in `settings.json` `orders`), `value_of` (the field's ECMA JSON text as UTF-16BE bytes) |
| `totals.rs` | Declared totals: `Declared` (DATA in `settings.json` `totals`: a kind, an optional group field, an optional integer sum field), `contribution`, `Total` |
| `keep.rs` | Keep rules: a row of the person's rules kind (`settings.json` `keep`) says how long a kind of records is kept (`keep_for` and its unit, by the record's newest write), how many of its newest are kept (`keep_newest`), how many records one step destroys (`page`) and looks at (`walk`) and how often a finished sweep restarts (`every`); `Row::read`, `keep_rows`, `keep_step`, `keep_pass`, `Walks`. Destruction is the store's `erase_cascading`; the account's idle upkeep (`native_boot/own_records_start.rs` `Reclaim::step`) runs the pass. Tests: `keep_tests.rs` |
| `families.json` | DATA: every family of schema `record_store` (`versions`, `custody`, `ordered`, `order_state`, `totals`, `search_segments`, `search_parts`, `search_walk`, `follow`), merged with the other families files by `../schema.rs` |
| `settings.rs` | Loads and validates `settings.json`; `Settings::limits(host, volume)` resolves a host's `Limits`; `volume_free_bytes` |
| `settings.json` | DATA: receipt window and bound, undo window, exit step, search layout and fields, declared orders and totals, and each host's limits (`hosts`) |
| `store_size.rs` | Store size rows (`SizeRow`, `Level`, `resolve`: the account's plan or contract row, else the computer's, else the default), volume stores (`VolumeStores`) and the history bound (`HistoryBound`), ported one to one from old trillion `src/store-size.json`, `own-record-volume.json` and `src/record-history.json` into `settings.json` (`store_size`, `volume_stores`, `history`) |
| `page_tests.rs` | Measures bytes on disk per 100,000 records of a synthetic copy at 4 KiB pages and at the shipped `page_bytes` |
| `native.rs` | The native current-record seam: `CurrentRecords` (`stored`, `ids_of_type`, `work`), `body` / `stored_form` (a native stored form as a record store value), `RecordStoreCurrent` (the seam over record store) |
| `legacy.rs` | The old engine behind the seam (`Legacy`, its public readers only) and `refused` (its refusals named). No SQL: the migration's bulk reads of the old tables live in the tool `examples/record_store_migrate.rs` |
| `migrate.rs` | The one-way migration and its proof: `migrate(&mut dyn Source, ..)` -> `Report`; `Source` (`tail`, `checkpoint_page`, `canonical`) is how it reads the old engine |

The families are DATA, schema `record_store`, all in this folder's `families.json`: `versions` (with the orders `live`,
`live_kind`, `changed`, `ending` and `gone`), `custody`, `ordered`, `order_state`, `totals`, `search_segments`,
`search_parts` and `search_walk`. The loader merges every families file, and a family declared twice refuses every lookup, so no other
file declares them. The earlier `terms` family (one packed search row per record) is gone: nothing reads it, and the
loader refuses a family without readers.

## Key Types / Functions

| Type | Signature / Shape | Role |
| --- | --- | --- |
| `RecordStore<S>` | `new(storage, clock, limits)`, `with_settings(storage, clock, &Settings, limits)` | The store over one supply of schema `record_store` |
| `Records for RecordStore<S>` | `get`, `mutate`, `list_page`, `changes_page`, `mutate_admitted` | The record contract |
| `as_of` | `(account, resource, id, at) -> Read` | The version live at stamp `at`: one ordered seek, one row |
| `search` | `(account, resource, field?, word, limit) -> Found` | Records whose declared text fields hold the word, newest first |
| `search_walk` | `(account, resource, rows) -> Walked` | One step of the walk over the rows written before the index (or before its current terms): the next `rows` current records in id order, indexed and the cursor moved in one write scope; `done` once every row at or below the frontier is indexed. The account's idle upkeep calls it (native_boot/own_records_start.rs) |
| `search_ready` | `(account, resource) -> bool` | Whether the scope's walk is done |
| `erase` / `restore` | `-> Option<Erased>` / `(&Erased, ..) -> bool` | Destroy (into custody, leaving a tombstone with receipts) / the operator's restore inside the window |
| `retire` | `(account, resource) -> u64` | One exit step for a scope no one writes to (a host timer's call) |
| `import` | `(account, resource, &[(id, value)]) -> usize` | Bulk version-1 creates for a migration; an existing id refuses the call; no client request bound (the supply's value bound applies) |
| `ids` / `ids_of_kind` | `(account, resource, [kind,] cursor, limit) -> (ids, next)` | Live ids without values, one ordered walk of `live` (ascending) or `live_kind` (descending) |
| `stamp` | `(account, resource) -> i64` | The newest committed stamp of a scope (2 rows): as-of at it reads the scope as it is now |
| `ordered_page` | `(account, resource, order, cursor?, reverse, limit) -> Ordered` | A page of live records in a declared order: one range scan plus one get per record; refused until the order is filled for the scope |
| `get_many` | `(account, resource, &[id]) -> Vec<Option<Record>>` | The live records of several ids of one scope in one batch read (the supply's `read_many`: one request on a networked supply) |
| `totals` | `(account) -> Vec<Total>` | Every declared total of an account, one row per total and group: one range scan |
| `search_merge` | `(account, resource, bytes) -> Merged` | One step of the merges a scope's word index owes: reads about `bytes` of the inputs' parts, writes the merged parts, committed alone; `done` when no merge is owed |
| `fill_order` | `(account, resource, order, limit) -> bool` | Fill a declared order for records a scope held before the order existed; one bounded, resumable step per call; true when complete |
| `Work` | `{ seeks, rows_read }` | Rows read through the boundary; every read also reports its own counts in `work` |
| `Clock` | `now_ms()` | The wall clock that stamps are minted from (`RealClock`; tests supply their own) |

## Rows per operation (measured by `tests/records_conformance.rs` on both supplies)

| Operation | Table rows written | Order entries | Rows read |
| --- | --- | --- | --- |
| create | 1 (`versions` current) | live +1, changed +1 | 1 (current row, for receipts and compare-and-set) |
| update | 2 (replaced version + current) | changed moves (−1 +1), ending +1 | 1 |
| search (segments) | 0 per write while the tail is under `flush_records` (256) and younger than `flush_seconds` (1 day); the write that flushes adds 1 meta row + its parts and never merges, whatever the index's size (simulation: +0.11 rows per create, +0.00 per edit) | — | — |
| each declared order that covers the record | create +1 `ordered` row; update +0 when the ordered value is unchanged, +2 (erase + put) when it moves; delete and erase remove it | — | — |
| each declared total that covers the record's kind | 1 `totals` row rewritten per touched group per write step (a create, a delete or an erase touches 1; an update that changes the group touches 2), read with the step's other total rows in one batch get; an import of N records of one group in one step rewrites it once | — | 1 batch get per step that touches a total |
| totals of an account | 0 | — | 1 range scan (one row per total and group) |
| ordered page of N | 0 | — | 1 range scan (N rows, +1 when more remain) + N gets |
| get / as-of | 0 | — | 1 (as-of: 1 at 10 versions and at 100,000 versions) |
| retry inside the receipt window | 0 | — | 1, plus 1 when the version is no longer current |
| search | 0 | — | the memory tail, then 1 part per segment (newest first) until `limit` results are confirmed, plus 1 current row per candidate (simulation: about 18 rows for 20 results) |
| first use of a scope after a restart (search) | 0 | — | the segment meta rows + the walk row + the current rows changed after the floor (the newest segment's `hi` or the walk's frontier; bounded by `flush_records`, and by `flush_records` + 1 for a store written before its index) |
| search walk step | 1 segment (meta + parts) and the walk row | — | `walk_rows` ids and current rows past the cursor |
| search merge step (idle upkeep) | the merge's next parts and its meta row; the last step also drops its `fan_in` inputs | — | the inputs' segment metas and about `merge_bytes` (4 MiB) of their parts |

## Usage

```rust
use trillion_local::storage::{memory::Memory, record store::{record store, RealClock}, sqlite};
let supply = sqlite::open_owned(&real_path, "record_store", bounds)?;
let volume = Volume { store_bytes: supply.allocated_bytes()?, free_bytes: settings::volume_free_bytes(&real_path)? };
let store = RecordStore::new(supply, Box::new(RealClock), record_store_resources::computer_limits_from(computers::this_computer(), &volume)?)?;
let scratch = RecordStore::new(Memory::open("record_store")?, Box::new(RealClock), settings::Limits::fixed(1 << 20, 10 << 30))?;
```

## Migration from the old engine (`migrate.rs`, `examples/record_store_migrate.rs`)

1. `Source::tail`: the ids named by the journal rows after `record_keys_meta.covered` (`CanonicalHead::affected_ids`).
2. `Source::checkpoint_page`: the kept-run checkpoint (`i\0<id>` keys) in pages of up to 4,096 records. A page that does not
   fit the range reader's allowances is read again in halves. Each page is written with `import` as version 1.
3. The replay: each tail id is read once through the canonical reader (`LegacyRecords::read_stored`, which replays
   the tail) and written as its next version (or created, or deleted). Before it, `stamp` records the checkpoint stamp.
4. The proof: every old-engine record is read back from record store and compared by BLAKE3 digest; record store's live ids are walked
   for any the old engine lacks; sampled untouched ids are read again through the canonical reader and must equal their
   checkpoint form; sampled as-of reads at the checkpoint stamp must equal the checkpoint form (no record for ids the
   replay created).

On a clone of the person's account made October 27, 2026 (`.local/record_store-migration-20261027`, never the live state), run
October 28, 2026 00:21-00:34 PDT: 2,404,438 checkpoint records in 627 pages, plus 132 journal rows naming 108 ids, all
created after the checkpoint. 2,404,546 records read back, with 0 mismatched, 0 extra and equal digests. 20 of 20
canonical re-reads matched, and 20 of 20 as-of reads at the checkpoint stamp matched (10 of them on created ids, which
had no record then); each as-of read was 1 seek and 1 row. Old-engine cost per page: median 198 statements and 929
rows, at most 1,026 and 1,790; 43 pages were read again in halves. record store cost per page: 1 seek per record (the
existence check). The record store file is 11.9 GB (4.19 GB of stored forms; the largest is 4.26 MB). That is above the
Worker host's 10 GiB budget; the run used the `native` host's limits (8 MiB records, a budget sized to the disk).

## Native-serve startup reads on record store (`examples/record_store_native_serve_probe.rs`)

The probe replays the own-records read shapes of the six startup requests on the old engine and on the migrated record store
copy of the same clone, counting at each engine's storage edge (statements or seeks, rows, cell bytes). Viewer reads no
own record; show-rules (`workspace_records`) and screens (`workshop_*`) read other tables the switch leaves alone. Run
October 28, 2026 01:24-01:28 PDT; the old engine is the canonical reader at its request bounds. Its own id pages refuse
this account (the journal tail past its checkpoint), so its column reads the same records with record store's id pages:

| Request | Old engine: statements / rows / bytes / ms | record store: seeks / rows / bytes / ms | Records | Same answer |
| --- | --- | --- | --- | --- |
| pursuits | 17,620 / 78,787 / 46.4 MB / 12,486 | 304 / 327 / 0.20 MB / 19.8 | 176 | yes |
| needs-you-hold | 56 / 261 / 170 KB / 32 | 1 / 1 / 556 B / 0.06 | 1 | yes |
| decisions (100 newest by id) | 152,542 / 691,441 / 459 MB / 117,107 | 2,582 / 2,896 / 18.7 MB / 231 | 2,497 | yes |
| decisions (100 newest by `created_at`, declared order) | 27,632 / 129,436 / 83.0 MB / 31,253 | 499 / 813 / 2.4 MB / 54-402 | 414 | yes |

The last row ran October 28, 2026 02:28-03:01 PDT, after the declared order `decision/created_at` was filled on the
migrated copy (2,405 steps of 1,000 records, 821 s, once). Its page of the 100 newest decisions alone is 101 seeks and
201 rows (101 order rows plus 100 records), 213 KB, 4.3 ms. The order equals the old index order rebuilt from the
old engine's own reading of all 5,982 decisions (field JSON text by UTF-16 code unit, then id): no difference. record store
milliseconds vary with machine load between runs (12.9-182 for pursuits, 54-402 for decisions).

## Invariants

- Stamps (`ms << 16 | counter`) are minted inside the write and increase per account/resource. A scope that has
  not been used since the store opened recovers its newest stamp from its `changed` and `ending` orders (2 rows).
  After a commit whose outcome is unknown, the cached stamp is dropped so the next write recovers it again. Every
  write reads the storage mark (`Storage::mark`) inside its write reservation; when another handle (another store,
  connection or process on the same storage) committed since, the cached stamps and the search memory are dropped and
  recovered from storage, so no stamp is minted at or below one another store minted (which would collide with its
  history rows or land behind a feed reader's cursor) and a search sees the other store's changes. A search reads the
  mark too. The server supplies in `../supplies` subtract their own commits from that mark, as SQLite and memory
  count only other handles' commits. A steady writer therefore keeps its caches; another handle's commit still
  forces recovery. `../supplies/tests/write_reads.rs` bounds seeded writes against memory and checks that another
  handle's write refreshes stamps and search.
- A request key is scoped to the record it addresses. A key that has left the ring is applied as new, and
  compare-and-set then refuses to apply it a second time.
- The change feed lists each changed record once, at its newest version. A cursor older than the undo window may
  miss a deletion whose tombstone has already left, so that consumer must start again from the beginning.
- `erase` keeps a tombstone with the next version and the ring, so compare-and-set continues and retries are
  answered without showing the destroyed value. When custody is removed, the store is rewritten
  (`Storage::reclaim`) so the removed bytes leave the file.
- Limits are per host (`settings.json` `hosts`, resolved by `Settings::limits` when a store opens): `worker` keeps the
  Durable Object's 10 GiB storage limit and the 1 MiB remote record bound; `native` keeps the 8 MiB bound the
  account's records were written under and grows while its volume keeps 10 GiB free. A change that would leave the
  supply above the host's `byte_budget`, or a record above its `max_record_bytes`, is refused and rolled back. A
  remote call (`mutate_admitted`) also keeps the record contract's 1 MiB bound on every host.

## Size levels, overflow stores and history bound (storage audit, November 3, 2026)

- Every store runs under a size row (`RecordStore::set_size_row`; the shipped default is old trillion's 10 GiB with `warn` at
  70%, `refuse-growth` at 85% and `full` within 256 MiB). `RecordStore::level` answers where it stands. The person's own writes
  are never refused by a level; a host refuses a growth command (`store_size.growth_operations`). The volume's further
  stores (`record_store_resources::books::Books`, `<stem>.overflow-N.<ext>`) are named by the account's span directory
  (`record_store_resources::book_directory`, one row in the primary book, changed only by a split). The own-records point
  read asks the span owner only (`OwnRead::stored`), and an id page (`OwnRead::ids_of_type`) walks the spans from the one
  holding its bound. Not yet wired: writes route to the primary; value-ordered and referrer reads do not span the stores.
- History is bounded by bytes as well as time: once a store's last measured size reaches `history.from_level`, replaced
  versions older than `history.keep_ms` (1 hour) leave in the exit step, up to `rows_per_step` (4,096 at a level that
  waits for recovery). Below it the undo window holds. Tombstones and custody always keep the undo window.
- A resource whose row in `../record_store_resources.json` says `"history": "overwrite"` keeps no history row: its current row is
  rewritten in place (the secrets vault).
- A new store file starts with `page_bytes` (32 KiB) pages, so a 1-8 KB record stays in its leaf instead of taking a
  fresh 4 KiB overflow page; a file that already has pages keeps its own size. Measured by `page_tests.rs` (100,000
  synthetic records, mean 1.8 KB): 377.5 MB on disk at 4 KiB pages, 258.6 MB at 32 KiB.

## Why This Design?

As-of reads cost one row because history is keyed by (record, `valid_to`) and the current row sits at
`valid_to = MAX`. The first row after (record, T) is the version that was live at T, whatever the history size.
This replaces the plan's skew-binary `skip_at` walk, which needs O(log v) reads. The cost is that a history row
holds the whole replaced value, not a reverse diff.

Receipts in the row the request changes add 0 rows per write. Search uses daily-flushed segments (the storage simulation's winner, October 27-28, 2026): +0.11 rows per create
above the floor, about 18 rows per search, and a cold start bounded by the unflushed tail; never one row per word. Destruction goes to custody instead of being deleted at once (plan CP6).

## Ported from old trillion (2026-11-04)

| File | Purpose |
| --- | --- |
| `history_chain.rs` | The chain proof of kept history files (each names the BLAKE3 identity of the one before; the store keeps the head), paged checks with names-only walks and anchored tails, substitutions for files rewritten by erasure, the gzip archive form and the verified keep with its readback (old `src/record-history.mjs`) |
| `history_archive.rs` | Replaced versions of a resource the DATA names (`settings.json` `history_archive.resources`, none shipped) move out as chained JSONL files in the account's own files (`account_files/history_keeper.rs`) before they leave the store; pins hold history from a stamp; restore after a full chain check; erasure from kept files |
| `partial.rs` | Record size without reading it, selected fields, every field but some (read and write), list members (count, read, write, where), each with a byte budget checked before parse, and a bounded LRU memory of records (old `eeaf-sqlite-store.mjs` partial reads) |
| `shared.rs` | Content-addressed shared child objects stored once (`kept_shared_objects`), chosen per kind by DATA (`settings.json` `shared_children`, none shipped), with a byte-bounded memory and an expansion budget (old `contentId`) |
