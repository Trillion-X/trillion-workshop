# write-data/

**Purpose:** Write operations — observer fact append, signal capture, identity derivation.

## Files

| File | Purpose |
|------|---------|
| `observe.ts` | Universal OBSERVE operation: `buildObservationRecord`, `buildWriteBatchEntry`, `appendObservation`. Pure + thin separation for testability. Append-only facts at observer::<id>::* (Wave-1, T2). |
| `capture-signals.ts` | Signal capture: `deriveObserverId` (DATA-ordered source precedence), `buildSignals`, `captureSignals` orchestrator. Identity is open string, signals are DATA-driven. Trust = `trust:observer-supplied` (Wave-2, T8). |

## Key Types

| Type | Signature | Role |
|------|-----------|------|
| `ObservationRecord` | `{entity_type:'observation', observer_id, trust_ref, path:string[], value, at}` | Single fact at observer::<id>::* |
| `WriteBatchEntry` | `{address, path, payload, remove:false}` | Write-batch envelope (append-only). |
| `ObserveOptions` | `{observerId, trustRef, path, value, at?, basis?}` | Options for building an observation. |
| `ObserverIdSource` | `{source_id, extractor?}` | Data descriptor for identity sources. |
| `SignalDescriptor` | `{path, extractor?}` | Data descriptor for signals to capture. |
| `FirstTouchContext` | `{source?, referrer?, utm_*, geo?, device?, is_returning?}` | Request context for extraction. |

## Dependencies

- `observe.ts`: pure (zero imports except types).
- `capture-signals.ts`: uses `observe.ts` for fact building + injected engine write function.

## Non-Negotiable Invariants

1. **Append-only:** `remove:false` always. No update op. No mutation.
2. **Open DATA:** `trust_ref` and `path` are untyped strings/arrays. Never code enums.
3. **Structured path:** `path:string[]` (never dot-encoded). Mirrored from `FactPathNode.fact_path`.
4. **Observer-ID derivation:** ORDERED DATA list of sources. First non-null wins. NEVER fixed code precedence (cookie → header → device-key → anon-hash is DATA precedence, not Physics).
5. **Signals:** DATA-driven list of {path, extractor}. New signal = 1 data row, zero code change.
6. **Idempotent identity:** Same sources → deterministic observer_id.
7. **Injected I/O:** `engineWriteBatch` parameter keeps modules testable without live engine.
