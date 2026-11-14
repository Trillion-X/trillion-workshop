# Visual Database Do Work

This folder contains outbound work helpers for `visual-database`.

The package does not mutate addressed records directly. It converts action descriptors and record context into target requests so the owning package, workflow definition, or target slot remains the authority for state changes. The ONE durable-write primitive lives here too: every board mutation (field edit, lane move, manual reorder, new record, new view) is a configuration of one engine write-batch request.

## Files

| File | Purpose |
|------|---------|
| `record-writes.ts` | THE one mutation primitive: `writeAddressedRecords` (atomic batch) with `writeAddressedRecord` as its single-entry configuration; `createRecordWriter` factory |
| `visual-database-actions.ts` | Converts action descriptors + record context into owner/slot target requests; one descriptor can dispatch multiple owner definitions or a direct owner target such as AI Work Control's start-assigned-work target; missing targets return a structured descriptor error instead of a workflow fallback |
| `visual-database-action-conformance.json` | Shared conformance fixtures for browser and JSCore action interpretation: explicit workflow target, explicit session target, explicit owner target, and missing-target descriptor error |
| `fractional-order.ts` | Lexicographic fractional indexing (pure math, zero imports): `keyBetween`, `spreadKeys`, `isOrderKey` over a 62-digit ASCII-monotonic alphabet |
| `fractional-order.test.ts` | W4 acceptance-math fixtures — the execution contract for ordering (run with `npm test`) |
| `resolve-derived-fields.ts` | Addressed-cell dependency resolver: flat reverse edges drive dirty-only recomputation; evaluators are opaque Envelope addresses; cycles/missing refs remain diagnostics, never source writes |
| `resolve-derived-fields.test.ts` | Cross-row/table edges, fan-out/fan-in dirty propagation, cycles, and deleted-dependency fixtures |
| `cell-expression.ts` | Caller-ready assembly and validation for independently addressed source, cache, and provenance values; field defaults materialize only where source is absent |
| `migrate-field-derivations.ts` | Idempotently converts legacy field-wide derives into field default-expression templates without writing any cell |
| `migrate-field-derivations-target.ts` | Admitted owner target: validates one addressed fields record, runs the pure migration, and commits its one CAS-guarded write through the existing engine batch boundary |

## Key Types / Functions

| Export | Signature | Role |
|--------|-----------|------|
| `RecordWriter` | `(options: AddressedWrite) => Promise<void>` with `.batch(writes) => Promise<void>` | ONE primitive, two arities. `.batch` is one atomic engine request for N records (lane move + reorder in one drag, migrate-by-touch) |
| `writeAddressedRecords` | `(partitionLabel, writes: AddressedWrite[]) → Promise<void>` | The atomic batch write through the runtime-owned `engine.operation.label-addressed` target |
| `interpretVisualDatabaseActionRequests` | `(action, context) → { ok: true, requests } \| { ok: false, error }` | The blind descriptor interpreter. Requires explicit `target`, binds selected record refs and caller answers, and emits generic observability fields |
| `buildVisualDatabaseActionRequests` | `(action, context) → VisualDatabaseTargetRequest[]` | Data-defined owner-action composition, used by the assignee record handoff to call owner definitions, or to call AI Work Control's direct start-work target, without Visual Database knowing owner internals |
| `AddressedWrite` | `{ addressLabel, payload, pathLabels? }` | One batch entry; `pathLabels` defaults to `PUBLISHED_RECORD_PATH` |
| `keyBetween(a, b)` | `(string \| null, string \| null) → string` | Deterministic shortest key strictly between a and b. Equal keys are ordered by descriptor identity; keys never exhaust or end in `'0'` |
| `spreadKeys(count)` | `(number) → string[]` | Evenly spaced keys for migrate-by-touch (single digits up to 61) |
| `isOrderKey(value)` | `(unknown) → value is string` | Read-side tolerance check; legacy numeric sort values fail it and trigger migrate-by-touch |
| `buildAddressedCellValueWrites(values)` | `(AddressedCellValues) → AddressedWrite[]` | Preserves expression, cache, and provenance as separate write entries in one atomic request |
| `ORDER_ALPHABET` | `'0–9A–Za–z'` (62 digits) | ASCII-monotonic, so plain string `<` IS the comparator |

## Dependencies

**Depends on:** `@bitfield/runtime-kit` (transport), `@bitfield/runtime-kit/protocol` (request building). `fractional-order.ts` depends on nothing.
**Depended on by:** `show/VisualDatabaseSurface.tsx`, `show/field-editors.tsx`, `show/mount-visual-database.tsx`.

## DM lead extraction

| File | Purpose |
|---|---|
| `do-work/process-scripts/extract-dm-leads.mjs` | Turns decoded conversation atoms into CRM `customer` and `lead-event` record writes. Pure data mapping: atoms in, writes out, no network or clock. Contains ZERO business or channel vocabulary. |
| `do-work/__tests__/extract-dm-leads.test.mjs` | Holds that property: a new buying-intent phrase and a new channel are each one DATA row with zero code change, a decoder that names its own channel is believed over any rule, signal precedence is authored DATA order, an empty descriptor classifies nothing, a malformed pattern degrades to no-match, and the extractor names no channel or keyword. 9 tests. |

**Where the vocabulary lives:** `package::visual-database::lead-signal-descriptor::default`,
a published record carrying `signals` (ordered; first match wins), `channel_rules`
(detection plus each channel's `identity_template`), `self_fields` (which provenance
fields name us, so our own messages are not leads) and `handle_fields`.

**Why this exists as a file at all.** The predecessor was 170 lines of python inlined as
base64 inside `things-to-store-and-run.json`. No file search could find it, no test
covered it, no README listed it, and it was invisible to review. It hardcoded a closed
keyword list, two channel names, per-channel identity formats and per-channel
provenance field names, so a new channel or a new word meant editing code that nobody
could see. It also named `python3`, a runtime the live app does not carry, so the step
could not run at all.
