# trigger-engine — Subscribed Data-Driven Trigger Slot

`trigger-engine` is a live subscribed slot. It bootstraps trigger rules from
package-owned rule records, then consumes the shared live delta firehose in
hash-only mode, resolves changed bytes through talk_to_other_slots when needed,
exposes generic envelope metadata like `address`, `address_text`, and
`content_hash`, keeps those rules in local state, evaluates rule-owned
`match_condition` bindings, optionally calls rule-owned evaluator targets, and
dispatches rule-owned output templates to rule-owned targets.

It does not hardcode sibling slot names, it does not hardcode another slot's
payload shape, it does not use reactive edges, and it does not require a
separate trigger-orchestrator.

## Files

| File | Purpose |
|------|---------|
| `src/lib.rs` | Crate root and public exports |
| `src/talk_to_other_slots/make_request_bytes_for_other_slots.rs` | Build outward request bytes from an `Envelope` |
| `src/talk_to_other_slots/read_reply_bytes_from_other_slots.rs` | Decode direct-read reply bytes for hash-only input resolution |
| `src/slot_work/rule_record.rs` | Trigger rule record structs |
| `src/slot_work/rule_state.rs` | Live trigger rule state |
| `src/slot_work/delta_apply.rs` | Delta ingest, rule-state updates, and mutation fan-out |
| `src/slot_work/match_rules.rs` | Local binding normalization, rule matching, and template evaluation |
| `src/slot_work/dispatch_output.rs` | Optional evaluator calls and opaque rule-owned output dispatch |

## Runtime Model

1. Envelope engine delivers package-owned rule records to the subscribed slot as
   normal asserts whose path contains `trigger-rule`.
2. Envelope engine also delivers live delta batches to the subscribed slot as
   hash-only asserts/retracts.
3. For hash-only rule assertions on the `trigger-rule` path, `trigger-engine`
   resolves the address through talk_to_other_slots, decodes the engine's
   `DirectReadReply`, and only then parses the returned payload bytes as
   trigger JSON.
4. Live delta asserts/retracts update local rule state only through that rule
   path. Trigger-looking JSON on any other path remains normal mutation data.
5. Non-rule mutations are retained as bounded generic observations and become
   `{ change, envelope }` contexts for currently hydrated rules.
6. When a rule arrives after a real observation, the stored observation is
   replayed through that changed rule once. This makes rule hydration
   order-independent without synthesizing fake lifecycle input.
7. Each active non-interval rule evaluates its own `match_condition`.
8. If the rule declares an evaluator, `trigger-engine` renders `request_template` and dispatches opaque bytes to the rule-owned evaluator address.
9. On match, `trigger-engine` renders `dispatch.output_template` and dispatches opaque bytes to `dispatch.target`.
10. `dispatch.delivery` optionally selects whether that dispatch returns inline or
    through the generic durable send-later transport. The field is transport
    policy, not a trigger-specific queue.

The package slot policy keeps the component instance persistent because
subscribed rule state is resident slot state. Query-scoped component execution
would erase hydrated rules between boot/live delta delivery and later mutation
dispatch.

## Key Contracts

- `slot-protocol::DeltaPayload`
  - shared subscribed delta wire contract
- `TriggerRule`
  - `{ id?, match_condition, evaluator?, dispatch, topic?, trigger_type?, is_active }`
- `RuleEvaluator`
  - `{ address, request_template, matched_path?, bindings_path? }`
- `RuleDispatch`
  - `{ target, output_template, delivery?, max_attempts? }`
  - omitted `delivery` means `inline`
  - `later_with_durable_outcome` maps to the generic `slot-protocol`
    reply-delivery boundary

## Dispatch delivery contract

Inline dispatch retains the existing bounded synchronous retry behavior and
reports `succeeded` after target completion. A rule may instead opt in with:

```json
"delivery": "later_with_durable_outcome"
```

The trigger slot then submits one exact generic request and records `accepted`
when durable submission succeeds. It does not wait for target completion and does
not synchronously retry: any configured retry count collapses to one durable
attempt because the transport identity already identifies that exact request.
Target success/failure is read separately from the generic
`current-item/send-later-outcome` record. Targets that can cause external
effects must be idempotent for that request identity.

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `TriggerHandler<I>` | `new(I)`, `handle_with_writes(&Envelope) -> Result<HandleOutcome, String>` (async on wasm32) | Holds resident rules; applies one delta |
| `HandleOutcome` | `{ response, failure_writes, outcome_writes }` | JSON response bytes plus durable failure and dispatch-outcome writes |
| `TalkToOtherSlots` | `dispatch(&Envelope, ReplyDelivery) -> Result<Vec<u8>, String>` | Everything outside: direct reads, live-state pages, evaluator calls, dispatches |
| `TriggerRule` | `{ id?, match_condition, evaluator?, dispatch, topic?, trigger_type?, is_active }` | A rule record |
| `RuleDispatch` | `{ target, output_template, delivery, outcome_correlation_template?, max_attempts? }` | Where a matched rule sends |
| `RuleEvaluator` | `{ address, request_template, matched_path?, bindings_path? }` | Optional outside check before dispatch |

## Dependencies

**Depends on:** `composition-ast` (bindings), `slot-protocol` (envelopes, delta wire, replies), `content-crypto` (multihash decode).

**Depended on by:** `crates/trigger-engine-web`.

## Where it came from

Ported whole from bitfield-packages `packages/trigger-engine/source`. The
engine source is unchanged except that `bitfield-crypto` is `content-crypto`
(the same crate under another name) and two clippy fixes (a `match` in
place of `is_none` + `expect`, test type aliases). Bitfield's WIT
component-model slot entry (`src/slot_entry/`) and its WIT sender
(`talk_to_other_slots/send_request_bytes_to_other_slots.rs`) are not here:
`crates/trigger-engine-web` is the host adapter, implementing
`TalkToOtherSlots` natively and, in a Worker, with one JavaScript `answer`
function. Built for wasm32 the handler is async; natively it is synchronous.

## Runtime Reentry Invariant

The wasm32 `TriggerHandler::handle_with_writes` is async and is awaited by the
host adapter. This source must not block on a future, create a Tokio runtime,
or use `Handle::block_on` from engine callback paths. Sync wrappers belong only
at outer OS entrypoints, never inside runtime-owned execution.

## Key Invariants

- Trigger semantics are owned by rule data, not by hardcoded sibling-slot constants.
- Optional evaluator semantics are owned by the evaluator target, not by `trigger-engine`.
- Delta input arrives through the existing subscribed-slot mechanism, not
  reactive edges and not a separate orchestrator.
- Boot hydration is rule-record-driven; `trigger-engine` is not hydrated with a
  central aggregate catalog and does not require the entire world inline before
  live observation begins.
- Rule hydration has no side effects. Runtime lifecycle facts are ordinary
  delta input: Runtime Kit emits the generic fact after live subscriptions are
  attached, and rules match it through the same mutation path as every other
  event.
- Late rule hydration replays only real previously observed mutations, and only
  for rules whose stored definition changed. Rehydrating identical rule data
  cannot refire old observations.
- Rule side-effect failures are isolated per rule and reported as
  machine-readable dispatch diagnostics. A missing target, evaluator failure, or
  dispatch failure cannot abort trigger state hydration or prevent other matching
  rules from running.
- Send-later submission failures remain rule-attributable trigger diagnostics,
  but accepted submission is not target success. The generic durable outcome, not
  trigger-engine, owns terminal target evidence.
- `trigger-engine` does not parse EEAF row grammar. If an address carries
  textual digest bytes, they surface only as generic `envelope.address_text`.
- Trigger entities are machine-readable JSON. Local matching can summarize
  non-JSON payloads, but evaluator and dispatch templates use checked,
  bounded JSON materialization so callback paths return rule diagnostics instead
  of trapping on hostile or oversized payloads.
- Common local match predicates compile into bounded path comparisons
  (`equals`/`eq`, `not_equals`/`ne`, `in_list`, `starts_with`) before live delta
  fan-out. Richer rule logic remains data-owned and may use evaluator targets,
  but the hot local gate must not JSON-roundtrip Binding ASTs per mutation.
- The fallback compiled predicate stores rich Binding ASTs behind indirection, so
  the common small predicates remain compact in memory while preserving full
  fallback rule capability.
- Path predicates match only when the selected path exists. Explicit JSON `null`
  remains a value, but a missing path is not treated as `null`; this prevents
  narrow rules like `change.property_id != ""` from becoming catch-all triggers.
- Rule evaluation failures include the trigger rule id or address. The slot
  stays generic, but bad rule data must be attributable without guessing.

## Tests

```bash
cd crates && cargo test -p trigger-engine   # 69 tests
```

Coverage includes:
- boot hydration from direct rule records
- hash-only rule hydration followed by later hash-only change delivery with
  envelope predicates
- rule hydration without side effects
- runtime lifecycle delta dispatch after hydrated rules are resident
- side-effect failure isolation for runtime lifecycle rules and normal delta rules
- oversized full-change dispatch materialization returning typed
  `dispatch_failures` instead of aborting the callback
- local rule matching against generic mutation envelopes
- evaluator and dispatch addresses driven by rule data
- ignoring inactive and interval triggers on delta input
- runtime-event dispatch errors carrying the failing trigger rule id
