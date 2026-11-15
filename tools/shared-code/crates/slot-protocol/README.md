# slot-protocol/

Leaf protocol crate for slot dispatch, envelope identity, subscription filtering, and self-describing slot-door metadata.

Plain English: this crate describes the slot door and envelope protocol. It must not decide what machine runs behind the door. Plugged-call state belongs to the generic slot call boundary; Wasmtime/process/provider details stay behind private runners.

## Files

| File | Purpose |
|------|---------|
| `src/selector.rs` | Delta types, coarse `EnvelopeSelector`, and exact subscribed-slot `SlotSubscription` contract |
| `src/dispatch_slot.rs` | Single generic slot-door implementation; commits query-emitted `WriteEntry` records through `DispatchHandle` before acknowledging mutating queries |
| `src/handler.rs` | Generic query handler contract, `QueryResult`, and `WriteEntry` write-batch encoding |
| `src/slot_state.rs` | Slot-door state and slot activation helpers: stored bytes, boundary data, private-runner input, and plug-call state |
| `src/delta.rs` | Canonical JSON payload for subscribed-slot delta delivery |
| `src/engine_operation.rs` | Binary operation frame and open operation registry for routing many engine operations through one already-selected carrier target |
| `src/dispatch_handle.rs` | Generic dispatch-handle trait, including opaque self-contained mesh segment read/ingest primitives |
| `src/query.rs` | Opaque direct-read replies and filtered live-state request/reply frames. Data-owner query languages stay in the owning slot/package, not this universal protocol crate |
| `src/query_context.rs` | Generic query-context frame utilities that preserve slot-owned query config and caller-owned opaque context without naming either side |
| `src/web_host.rs` | wasm32-unknown-unknown only: `install_host_dispatch(js_sys::Function)` + `async dispatch(target, &PartitionKey, Option<&[u8]>) -> Result<Arc<[u8]>, String>`. Lets a slot crate compiled as a plain wasm-bindgen module (Cloudflare Worker, browser) reach other slots through a host function that receives target, partition multihash wire bytes and payload already separated (no envelope encoding in JS). Each slot crate wraps it into its own dispatch type |
| `wit/handler.wit` | Component-model WIT contract: async `talk-to-other-slots.send-request-bytes(...)` plus async query handler exports |
| `benches/direct_read_reply.rs` | Isolates current direct-read reply encode cost into current code-hex+Vec, precomputed-hash+Vec, precomputed-hash+IoSlice, and raw-multihash+IoSlice probe families |
| `tests/n_target_benchmark.rs` | Neutral slot-door to plug-call dispatch proof; fixture names intentionally avoid product, storage, network, language, and runtime/provider vocabulary |

## Current Architecture Notes

- `EnvelopeSelector` is the engine-side coarse subscription gate.
- `SlotSubscription` is the slot-facing exact feed contract used by the composition-root delta forwarder for:
  - boot hydration through `bootstrap_addresses`, `bootstrap_path_prefix`, and `bootstrap_path_segments`
  - live-batch filtering through `live_addresses`, `live_path_prefix`, and `live_path_segments`
- `LiveStateEntry` is the boot-time current-state primitive: authoritative address + content hash, durable path metadata, and current payload bytes.
- `LiveStatePointer` is the payload-free sibling: authoritative address + content hash + durable path metadata. Use it when a caller must filter current state before deciding which payloads to read.
- `ListLiveStateRequest` is the talk-to-other-slots current-state materialization request. Empty `addresses` and empty `path_prefix` mean match-all; non-empty filters intersect by address and durable path prefix before payload bytes are considered. `cursor`/`offset`/`limit` page the selector-matching stream, and `content = hash_only` returns payload-free address/hash/path pointers instead of copying payload bytes into the reply.
- Subscribed-slot `DeltaPayload` asserts carry the same durable path metadata as
  `asserts[].path`, encoded as canonical multihash wire hex per segment, so
  hash-only subscribers can classify records without reading payload bytes.
- `EnvelopeSelector` and `SlotSubscription` can match by exact address, path prefix, or any path segment. Path-segment matching lets a slot ask for records tagged with the slot's own neutral facet without knowing the package path prefix that carried those records.
- `SlotSubscription.content` decides whether the forwarder inlines payload bytes (`inline`) or ships only address+hash (`hash_only`).
- `SlotSubscription.gap_recovery` names exactly one current-state repair owner. The default `runner_rehydrates_bootstrap` preserves gap-blind read models; `consumer_reconciles_current_state` forwards only the gap sentinel to a stateful consumer that already performs bounded reconciliation through the generic live-state owner.
- `SlotSubscription.wait_until_initial_delivery_finishes` decides whether app-open readiness waits for that slot's initial delivery to finish. The default is `true`; background observers can set it to `false` so their initial feed continues after the app is already open.
- `slot_config_path()` is the canonical structural path for SlotConfig Envelope records. It does not name a specific slot; it marks the record role so boot discovery can stay metadata-first.
- Generic slot law is slot door state, stored-byte references, boundary data, private-runner input, and plug-call state. `execution_model`, `runtime`, and provider registries are not generic protocol law.
- `SlotPlugConfig.permission` carries the accepted `PlugCallPermissionRow` as data. The slot door can prove which plug call is allowed without naming the private runner that will execute it.
- Resource policy remains valid only inside body-private runner data. It must not become generic slot routing law.
- `bootstrap = all_state` is only valid with `content = hash_only`. Broad-state hydration cannot inline arbitrary payload bytes because live state can contain large binary artifacts as well as JSON rows.
- Package-time address names are compiled into canonical `FactAddress` values before slot-door admission.
- Identity newtypes expose `to_wire_hex()` for text boundaries that carry exact
  address bytes. This is the hex of canonical multihash wire bytes, not the
  serde/display `code:hex` persistence form.
- `Envelope` now has three distinct payload-metadata constructor families:
  - authored payloads: `Envelope::new(...)` / `Envelope::minimal(...)` compute `payload_hash`
  - already-arrived opaque transport bytes: `Envelope::dispatch(...)` / `Envelope::received(...)` skip payload hashing
  - authoritative read/replay bytes: `Envelope::from_known_payload_hash(...)` preserves engine-owned hash authority without re-hashing payload bytes
- Query context has two independent owners:
  - slot-owned config bytes, supplied by the slot door/runtime materialization
  - caller-owned opaque context bytes, supplied by the envelope caller
  `query_context::combine_query_context(...)` writes a self-describing CBOR
  frame whenever caller context exists, and `split_query_context(...)` recovers
  both byte regions. Slot-only config remains unframed so existing query-config
  semantics do not become caller policy.
- Slot-to-slot request transport uses the plain talk-to-other-slots vocabulary:
  - sender/request builder: `make_request_bytes_for_other_slots(...)`
  - receiver/request decoder: `read_request_bytes_from_other_slots(...)`
  - WIT import: `talk-to-other-slots.send-request-bytes(handle-id, payload)`
  - reply readers are separate slot-side outward-talk code, not these request-envelope helpers
- `OtherSlotRequest` is the versioned request frame for that transport. Its
  `reply_delivery` field is generic transport policy: `inline` returns the
  target reply in the invocation response, while `immutable_content` asks the
  receiving dispatcher to publish the exact reply bytes through `CasBlobWriter`
  and return only a fixed-width `ImmutableContentRef`. The legacy request
  helper explicitly produces the versioned `inline` form; decoding rejects
  malformed or unknown request versions rather than guessing a delivery mode.
- `ImmutableContentRef` is an identity, not a byte container. Consumers that
  need content resolve it through the existing CAS reader boundary; they must
  not treat the reference frame as an alternate inline payload encoding.
- The WIT query exports are async. A WASM module that awaits
  `send-request-bytes(...)` must not rely on a guest-side sync `block_on`;
  Wasmtime owns the async export/import path end-to-end so native runners can
  yield without creating a nested runtime.
- Slot request/reply payloads are opaque bytes. A data owner may define its own
  query request, field selection, and reply shapes inside its package boundary;
  readers that need generic materialization must use data-defined extraction
  over the returned bytes instead of adding a new shared query schema here.
- Engine operation frames keep the carrier target stable and put the operation
  id plus opaque request bytes inside the payload. `EngineOperationDescriptor`
  advertises operation ids, and `EngineOperationRegistry` resolves those ids
  without a closed enum or per-operation transport target.
- Mesh sync is a root diff, and it is opaque to callers. A peer sends the root
  it already holds; `root_diff(...)` answers with a `RootDiff` carrying only the
  map nodes and payloads that root is missing, and `sync_mesh(...)` takes one
  back and returns the merged root. Transport providers move the bytes without
  parsing records, hashes, or package state, and there are no cursors or
  per-peer state to keep, because the root each side names is the whole of what
  either needs to know about the other.
- `QueryHandler::engine_operation_descriptors()` is the native-handler catalog
  hook. The default returns no nested operations; handlers that multiplex
  operations behind one route return descriptor data without adding route names.
- `DispatchSlot::query(...)` and `DispatchSlot::query_batch(...)` acknowledge
  mutating handler responses only after every returned `WriteEntry` is accepted
  by the `DispatchHandle` write path. Handlers stay dumb and return data; the
  generic slot primitive owns write durability and failure propagation.
- `WriteEntry.expected_current` is the generic stale-write guard. When present,
  the dispatcher reads the current address once and accepts the write only when
  the live payload hash matches, or when the address is absent and absence was
  the expected current value. Reads and unguarded trusted writes are unchanged.
- Query-emitted write dispatch logs start, per-write acceptance, and completion
  timing using only slot name, write count/index, and elapsed milliseconds. The
  logs expose where a generic mutating query stalls without parsing payloads or
  naming package semantics.
- Private-runner plugs resolve lazily after the `DispatchSlot` door is already
  registered. Boot publishes every admitted route from slot-door state first;
  the machine behind a private door is prepared only when that door receives its
  first query. One slow plugged runner cannot block unrelated target routes.
- `EngineContext` is the native-handler registration context. It now carries:
  - `DispatchHandle` for live envelope reads/writes
  - `CasReader` for immutable blob reads
  - `SlotRegistry` for slot lookup
  - `HandlerTable` for native handler registration
- `DispatchHandle` now has two read families:
  - `read_envelope(...)` for owned async envelope materialization
  - `visit_direct_read(...)` for object-safe caller-thread borrowed read consumption when an implementation can expose a direct local view without rebuilding an owned `Envelope` first
  - `visit_live_state(...)` for selector-filtered borrowed current-state visits; implementations should apply address/path filters before touching payload bytes
  - `scan_live_state(...)` for cursor-bounded selector scans that can return hash-only pointers or inline payload views through one generic visitor contract
- Direct-read reply encoding now has two construction modes over the same wire contract:
  - `encode_direct_read_reply(...)` for callers that already hold a materialized `DirectReadReply`
  - `encode_direct_read_reply_parts(...)` for hot borrowed branches that want to encode directly from `&Hash` + `&[u8]` without first allocating an intermediate `DirectReadReply { String, Vec<u8> }`
- The `direct_read_reply` bench keeps deeper probe families separate from the
  shipped contract:
  - current contract = code-hex hash text plus owned output `Vec<u8>`
  - `*_iovecs_probe` rows = vectored borrowed handoff probes, not shipped truth
  - `binary_multihash_iovecs_probe` is a different-contract probe because it
    replaces the textual hash field with canonical raw multihash bytes
- Viewer-document attachment semantics do **not** live here. This crate stops
  at universal slot/envelope/query/subscription protocol. Any concrete document,
  style, surface, or render-target materialization belongs to the owning runtime
  binding outside this protocol crate.
