# parts/slot-table

A current view where a key (a record id, a file name, anything with text) becomes a small integer slot once, when it is admitted, and every later read or write is an index into flat typed arrays: no text hashed again, no key built, no object walked to learn a kind, a version or a size.

## Files

| File | Purpose |
|------|---------|
| `part.json` | Which files other code may import (`do-work/slot-table.mjs`) |
| `do-work/slot-table.mjs` | The table: interning, slots, typed columns, handles, the CLOCK sweep that keeps it inside its bytes |
| `README.md` | This file |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `slotTable({ capacity_bytes, columns })` | `→ table` | The table. `columns` is DATA: `[{ kind, field, as: 'number' \| 'text' }]`, one typed array each |
| `table.find(key)` | `→ slot \| -1` | The one hash of a key |
| `table.set(key, kind, value, extra, bytes)` | `→ slot` | Admits or updates a key; fills its declared columns; moves its version on; lets the least recently used go past `capacity_bytes` |
| `table.drop(key)`, `table.clear()` | | Lets one key, or every key, go (its generation moves on, so held handles go stale) |
| `table.value(slot)`, `kindOf(slot)`, `kindId(slot)`, `versionOf(slot)`, `bytesOf(slot)`, `extra(slot)`, `keyOf(slot)` | | Reads by slot (the host's own hot path) |
| `table.handleOf(slot)`, `slotOf(handle)`, `handle(key)` | `→ number` | A handle is `generation * SLOT_SPACE + slot`, a plain number; `slotOf` answers -1 once the slot was let go or reused |
| `table.at(handle)`, `versionAt(handle)` | | The value and version a handle names, or undefined / 0 when stale |
| `table.column(kind, field)` | `→ { as, data, get(slot), set(slot, v), getAt(handle), setAt(handle, v) }` | One declared column; a text column's numbers are `table.words` ids |
| `table.slotsOfKind(kind)` | `→ Int32Array` | Every resident slot of one kind (a scan over the kind column) |
| `table.held()` | `→ { slots, slot_space, bytes, capacity_bytes, evictions, kinds, words }` | What it holds |
| `interning()` | `→ { id(text), has(text), text(id), size }` | Text to small integers, never forgotten (for small vocabularies: kinds, hot text values) |
| `SLOT_SPACE` | `2 ** 22` | Slots a table can hold |

## Speed (measured 2026-10-05)

| Operation | node on the Mac | inside a Durable Object |
|---|---|---|
| hot column read by slot | 0.75-1.8 ns | see `scripts/measure-record-speed.mjs` |
| hot column write (value and version) by slot | 1.1-2.5 ns | |
| column read through a generation-checked handle | 4-6 ns | |
| for comparison: `Map.get` with a text key | 31-203 ns | |

## Why This Design?

A JavaScript `Map` keyed by text hashes the key on every lookup and walks a hash chain; a record held as an object scatters its kind, version and size across the heap. Interning the key once and keeping those facts in typed arrays turns every later access into one array index, about the cost of a memory load, and leaves the record store's memory bounded by bytes, never by how many records it holds.

## Invariants

1. Memory is bounded by `capacity_bytes`; a slot let go takes its generation forward, so a stale handle never names another key.
2. The table is a cache of the host's truth: it never invents a value.
3. Columns are DATA; the module names no product, record kind or field. A value of another shape is absent (NaN / -1), never coerced.
4. A key new to the table starts without its reference bit, so one walk over many keys never pushes out what is read again.

## Dependencies

**Depends on:** nothing.

**Depended on by:** `parts/record-log/do-work/record-log-store.mjs` (its resident records), `test/slot-table.test.mjs`.
