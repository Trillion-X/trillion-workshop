# storage

The one storage boundary: product code reads and writes stored families only through the generic typed operations
of `Storage`, over families declared as DATA, and a supply implements them (SQLite on disk, or memory), so another
database can stand behind the same code. The record store (`record_store/`) is built on it.

## Files

| File | Purpose |
| --- | --- |
| `mod.rs` | The `Storage` operation contract, `Scope`, `Range`, `Read`, `When`, `Value`, `Row` and `Error` |
| `schema.rs` | Loads, merges and validates every families file once (`FILES`: this `families.json` and an owner's own, such as `record_store/families.json`; a schema spans files, a family declared twice refuses every lookup); answers schema, family, field and order lookups |
| `families.json` | DATA: every stored family the boundary may touch: key, fields, named orders, arrival order, readers |
| `sqlite.rs` | The SQLite supply: `lend` an owner's handle, `open_pinned` an immutable file, `open_owned` a file it creates with its declared families (tables, order indexes, partial indexes), custody, `reclaim` (VACUUM + checked WAL truncate), statement building |
| `sqlite/first_write.rs` | Tables made by their first write (old trillion `schema-on-first-write.mjs`): the SQL seam keeps a declaration of a missing table and makes it, with its indexes, just before the first statement that changes it; until then it reads as empty. Per family the same rule is DATA: `"made": "first_write"` (`schema.rs` `Made`), honoured by `sqlite.rs` (`declared_tables` leaves the family out; reads, counts, erases and compare-and-sets answer empty; the first put makes it in its own transaction) |
| `sqlite/record_tables.rs` | Typed SQL tables per declared kind (old trillion `record-tables.mjs`): a kind whose declaration says `"table": true` gets `rt_<hash>` with typed columns per field, generations on a type change, column-limit compaction, JSON-spelling partial indexes and a dated schema history; each layout is a runtime family (`schema.rs` `runtime_family`) the generic operations read by key |
| `sqlite/database.rs` | A database of any schema per addressed resource (old trillion `database-supply.mjs`, PGlite there): one SQLite file each; each command commits its change, its revision compare-and-swap and its request-key receipt in one transaction, with rights asked before and again at commit; no image per commit |
| `sqlite/generations.rs`, `sqlite/generations.json` | Log generations (old trillion `sealLog` .. `dropSealedLog`, `let-go-of-table.mjs`): seal a log whole, page it back sized from row headers, keep the copied position, let it go children first (views, triggers, indexes), rows above `drop_rows`, then one DROP |
| `memory.rs` | The in-memory supply: the same contract over ordered maps (SQLite's value order, row-value bounds decided at the first position where the two sides differ and refused only at a NULL reached there, partial orders, undo-log scopes; a dropped open scope is a crash), `reopen` for restarts |
| `record_store/` | The record store on the boundary (its own README) |
| `tests.rs` | Every operation against real scratch SQLite, and the memory supply against SQLite on 4,000 random operations (unit tests) |

## Key Types / Functions

| Type | Signature / Shape | Role |
| --- | --- | --- |
| `Storage` | `get`, `scan`, `read_many`, `put`, `write_many`, `count`, `erase`, `present`, `custody`, `location`, `scoped`, `writing`, `changes`, `mark`, `schema_mark`, `allocated_bytes`, `reclaim`, `open_scope`, `close_scope` | The operation contract; object safe, every method `&self`. `read_many` (point gets and ranges mixed, one `Reply` each) and `write_many` have default bodies that ask one at a time; a supply on a network sends each as one request. The scope rule: an operation that fails inside a scope changes nothing and leaves the scope usable |
| `Write<'a>` | `Put { family, row, when }`, `Erase { family, range }` | One write of a `write_many` batch |
| `Scope<'a>` | `Scope::begin(&dyn Storage, Intent) -> Result<Scope>`, `commit()`, `rollback()`; `Deref<Target = dyn Storage>` | One atomic unit; dropped unfinished, it rolls back |
| `Intent` | `Read` or `Write` | A consistent read, or the write reservation |
| `Read<'a>` | `{ field, at_most: Option<usize> }`; `whole`, `at_most`, `arrival` | One field to read, optionally bounded in stored bytes |
| `Value` | `Null`, `Integer(i64)`, `Real(f64)`, `Text(String)`, `Blob(Vec<u8>)`, `Oversized(u64)` | One stored scalar; `Oversized` only comes back from a bounded read |
| `Row` | `Row(Vec<Value>)`, `take(at)` | The values of one row, in requested order |
| `Order<'a>` | `Key`, `Named(&str)`, `Arrival` | Which declared order a scan walks |
| `Bound` | `Unbounded`, `Included(Vec<Value>)`, `Excluded(Vec<Value>)` | One end of a range over the order's cursor fields |
| `Range<'a>` | `{ order, from, to, reverse, limit }`; `all`, `prefix`, `after`, `order`, `reverse`, `limit` | A walk; `from` is where it starts, in walk direction |
| `When<'a>` | `Always`, `Absent`, `New`, `Matches(&[(&str, Value)])` | How a put meets an existing key (upsert, keep, refuse, compare-and-set) |
| `Error` | `Undeclared`, `Invalid`, `Busy`, `Interrupted`, `TooBig`, `Conflict`, `Moved`, `ReadOnly`, `Unavailable` | Storage failures; no database error type crosses the boundary |
| `Schema`, `Family` | `schema(name) -> Result<&'static Schema>`, `Schema::family(name)` | The declared DATA rows |
| `ARRIVAL` | `"@arrival"` | Reserved field name of a row's arrival position |
| `sqlite::lend` | `lend(&Connection, schema, Access) -> Result<Supply<&Connection>>` | Accept an owner's open handle; the owner's limits and handlers stay its own |
| `sqlite::open_pinned` | `open_pinned(&Path, schema, Bounds) -> Result<Supply<Connection>>` | Open a pinned file read-only and immutable, hardened, every operation bounded |
| `sqlite::Access` | `Read`, `Write` | The access a handle must keep; `custody` refuses a change |
| `sqlite::Bounds` | `{ value_bytes, work, deadline }` | Per-source value bound and per-operation work and time allowance |
| `sqlite::Supply<C>` | `C: Borrow<Connection>` | One SQLite handle implementing `Storage` |

## Dependencies

**Depends on:** `rusqlite` (only in `sqlite.rs` and `tests.rs`), `serde`, `serde_json`.

**Depended on by:** `account_rights` and `account_rights::update` (policy directory and gates), `workspace_publication`
(R2 inventory ledger), `import` (`immutable_uri`), and the test `tests/account_rights.rs`.

## Usage

```rust
use crate::storage::{Intent, Range, Read, Scope, Storage, Value, When};

fn rename(store: &dyn Storage) -> crate::storage::Result<()> {
    let tx = Scope::begin(store, Intent::Write)?;
    let row = tx.get("policy_directory", &[Value::from("revision")], &[Read::at_most("value", 4096)])?;
    tx.put("policy_directory", &[("name", Value::from("revision")), ("value", Value::from("2"))], When::Always)?;
    tx.erase("policy_directory", &Range::prefix("source-snapshot:"))?;
    tx.commit()
}
```

## Invariants

- Only names declared in a families file reach a statement; values are always bound parameters.
- A bounded read never materializes an oversized value; it returns `Value::Oversized(stored_bytes)`.
- No operation exposes a raw handle, a timer or an alarm. Deferred work belongs to the engine's scheduler, not here.
- `Range::prefix` is a byte-order prefix (case significant), unlike SQL `LIKE`.
- Handles are isolated. One handle holds the write reservation at a time; another handle's write is `Busy` (after the
  supply's bounded wait), never interleaved, and a refused `Scope::begin` leaves the handle usable. Another handle
  reads only committed rows, and a `Read` scope keeps the rows committed when it opened. The memory supply keeps this
  the way SQLite's WAL does (`memory.rs`), so the in-process conformance reference is not weaker than the database.
- A write that a supply's bound stops (cancellation, deadline, work) can make SQLite roll the whole transaction back
  on its own. The supply notices (the handle is back in autocommit), refuses every further operation of that scope so
  none can commit on its own outside it, and lets the scope close: a rollback succeeds, a commit is refused.
- `tests/storage_contract.rs` is the boundary's consumer-side conformance suite over both in-process supplies.

## Why This Design?

The inventory in `docs/storage-boundary.md` found about 500 SQL statements in product code, almost all keyed point
reads, keyset scans, upserts, compare-and-set updates and prefix deletes, plus the same custody block copied six times.
Those shapes are this folder's operation set. Layout is not in the contract: the current engine's one-row-per-key
tables, the record store current-plus-replaced-history layout, or another database implement the same operations.

## Where the declarations go next

The storage-convergence plan puts the per-family declaration in one DATA owner, Trillion `src/stored-families.json`
(code owner `src/stored-families.mjs`). It does not exist yet. When it lands, `schema.rs` reads that file with
`include_bytes!` (as `src/account_files/identity` reads its DATA) and `families.json` here is deleted.
