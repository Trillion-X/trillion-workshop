# choose-per-observer/do-work

Purpose: Operational logic that executes decisions and mirrors observer facts outbound.

## Files Table

| File | Purpose |
|------|---------|
| `mirror-facts.ts` | Outbound subscriber (T9 Wave-3): filters observer facts by address, maps fields (via `read-data/map-fact-fields.ts`, re-exported here), emits to venues via injected `EmitFn`. DATA-driven configuration (no venue enum). |
| `__tests__/mirror-facts.test.ts` | 15 tests for mirror-facts: field mapping, address matching, multi-venue emission, zero-code-diff extensibility. All passing. |

## Key Types / Functions

| Name | Type | Role |
|------|------|------|
| `MirrorRecord` | Interface | Mirror configuration: `subscribe_address`, `endpoint_venue_ref`, optional `field_map`, `label`. |
| `EmitFn` | Type | Injected emission function: `(venueRef: string, eventData: Record<string, unknown>) => Promise<void>`. |
| `mapFactFields` | Function | `(fact: ObserverFact, fieldMap?: Record<string, unknown>) => Record<string, unknown>` — extracts/renames fields from fact.value by field_map. If no map, returns `{value: fact.value}`. Defined in `read-data/map-fact-fields.ts` (public), re-exported here. |
| `factMatches` | Function | `(fact: ObserverFact, subscribeAddress: string) => boolean` — prefix-matches fact path against subscription address path portion. Example: fact path `['signal','source']` matches subscription `observer::obs-1::signal`. |
| `mirrorFacts` | Function | `async (facts: ObserverFact[], mirrorRecords: MirrorRecord[], emitFn: EmitFn) => Promise<void>` — main coordinator: filters, maps, emits. |

## Dependencies

**Depends on:**
- `choose-per-observer/read-data/score-candidates` — `ObserverFact` type

**Depended on by:**
- `choose-per-observer/index.ts` — public barrel export

## Design Invariants (L100 Generalization)

- **Zero venue enum**: A new tracker/pixel = a new `MirrorRecord` DATA row. No code changes.
- **Data-driven configuration**: Mirror address patterns, venue refs, and field mappings all live in DATA. Implementation is generic and extends infinitely.
- **Field mapping flexibility**: Optional `field_map` allows transforming fact.value into venue-specific event payload. Absence = identity (wrap value as `{value}`).
- **Address prefix matching**: Subscriptions match on fact path prefix, enabling broad subscribe-to-category semantics (e.g., subscribe to `signal::*` via address `observer::obs-1::signal`).
- **Injected I/O**: `EmitFn` is a parameter, enabling testability and runtime flexibility (stdout, HTTP, database, message queue).

## Why This Design

Mirror facts outbound without coupling to specific venues or payload formats. DATA controls which facts go where and how they transform. Adding a new telemetry sink = adding a DATA record, not changing code. The generic `mirrorFacts` function + opaque `field_map` transformation handle all cases.
