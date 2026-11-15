# Journal Module — Workflow Durability Layer

Append-only journal for workflow execution state with chain integrity, crash recovery, multi-device sync, and WASM dual-target support.

## Files

| File | Purpose |
|------|---------|
| `mod.rs` | Module root — re-exports all submodules |
| `writer.rs` | MPSC group-commit writer loop — the single write path for all journal entries |
| `store.rs` | `JournalStore` trait (L069 generative primitive) + `LibsqlJournalStore` + `InMemoryJournalStore` |
| `encoding.rs` | CBOR canonical encoding + SHA-256 hashing + CRC32 framing for crash recovery |
| `compactor.rs` | `EpochGenesisCompactor` — epoch-based compaction with snapshot + genesis record |
| `projector.rs` | `JournalProjector` — replays journal entries into `ExecutionContext` for resume |
| `resume.rs` | Resume orchestration — coordinates projector + writer for workflow restart |
| `sync.rs` | `SyncClient` state machine + `SyncTransport` trait for multi-device sync |
| `lease.rs` | `LeaseManager` — time-bounded actor leases with fencing tokens |
| `latest_accepted_journal_position.rs` | Latest accepted journal sequence + HLC time floor per device |
| `platform.rs` | Platform abstraction — `NativeDbExecutor` (native) + `platform_sleep` (cfg-gated) |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `JournalStore` (trait) | `async fn append()`, `read_entries()`, `read_latest_accepted_position()`, `write_latest_accepted_position()` | L069 generative primitive — all database access goes through this trait |
| `LibsqlJournalStore` | `impl JournalStore` with `libsql::Connection` | Native SQLite implementation |
| `InMemoryJournalStore` | `impl JournalStore` with `Vec<JournalWriteEntry>` | Test/WASM implementation |
| `LatestAcceptedJournalPosition` | `{ latest_accepted_sequence: u64, latest_accepted_hybrid_logical_time: u64 }` | Typed latest accepted journal position for device sync state |
| `JournalWriter<S>` | `mpsc::Receiver` + `JournalStore` + broadcast | Group-commit writer loop |
| `JournalWriterHandle` | `mpsc::Sender<WriteRequest>` | Cloneable handle for submitting entries |
| `EpochGenesisCompactor` | `compact()` → `CompactionResult` | Epoch boundary compaction |
| `JournalProjector` | `project_steps()`, `project_execution_context()` | Replay journal → execution state |
| `SyncClient` | `SyncState` machine + `confirmed_seq` + `partition_id` | Multi-device sync state machine |
| `SyncTransport` (trait) | `async fn send_segment(&self, segment: &JournalSegment)` | Transport abstraction (native HTTP / WASM SAB copy) |
| `SyncTransportResponse` | `Confirmed { new_seq }` / `Rejected { rollback_to }` | Authority response to segment |
| `LeaseManager` | `acquire()`, `renew()`, `release()`, `validate_fencing_token()` | Actor lease lifecycle |
| `NativeDbExecutor` | `execute<F, R>(&self, f: F) -> R` with semaphore | Bounded spawn_blocking for native non-WASM DB ops |
| `platform_sleep` | `async fn(Duration)` | cfg-gated: tokio (native non-WASM) / no-op yield (WASM) |

## Dependencies

**Depends on:** `domain::journal` (JournalRecord, JournalEntry, CborValue, LeaseBinding, DurabilityError), `domain::types` (StepOutput), `async_trait`, `sha2`, `crc32fast`, `ciborium`, `tokio` (native only), `libsql` (native only)

**Depended on by:** `executor::context` (record_step_output_journaled), `executor::runner` (journal writer lifecycle)

## Architecture

```
ExecutionContext
    │ record_step_output_journaled()
    ▼
JournalWriterHandle ──mpsc──► JournalWriter<S>
                                  │ group commit
                                  ▼
                              JournalStore (trait)
                              ├── LibsqlJournalStore (native)
                              └── InMemoryJournalStore (test/WASM)

SyncClient ──SyncTransport──► Authority (remote)
    │                              │
    ▼                              ▼
JournalSegment              SyncTransportResponse
```

## Platform Gating

Native blocking code is behind `#[cfg(all(feature = "native", not(target_family = "wasm")))]`. WASM targets use the non-blocking branch even when Cargo default features are accidentally present during test commands. The production workflow slot still compiles with `--no-default-features`; the target-aware guard prevents the broader category of `spawn_blocking` or native timer paths crossing into WASM.
