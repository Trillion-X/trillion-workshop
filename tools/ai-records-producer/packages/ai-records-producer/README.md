# ai-records-producer — Generic AI-records primitive

An AI agent produces structured records from an instruction. Generalizes `prompt-to-variations` and replaces `agent-producer` as the canonical workflow seam for "run an AI agent, parse its output into record items, write them to the log."

## Files

| File | Purpose |
|------|---------|
| `things-to-store-and-run.json` | All records: capability, contracts, T2 instruction DATA, owner sub-definitions, 23-step main workflow, 2 stored_bytes |
| `index.ts` | TypeScript barrel — result/error/audit type shapes + address helpers |
| `do-work/process-scripts/make-ai-records-command-request.py` | Resolves selected-agent SSOT → ai-agent-profile → provider fallback; hydrates small ordered profile instructions or validates a hash-only by-set-live materialization; snapshots bounded addressed inputs; builds the provider transport descriptor |
| `do-work/process-scripts/make-ai-records-from-command-output.py` | Parses AI CLI stdout into items keyed by `output_kind`; emits result, error, and audit records with prompt/instruction hash observability |
| `do-work/process-scripts/__tests__/test_make_ai_records_command_request.py` | Python tests — resolution, fallback, ordered profile-instruction/addressed-input hydration, and hostile failures |
| `do-work/process-scripts/__tests__/test_make_ai_records_from_command_output.py` | Python tests — parsing, failure paths, streaming, and result/audit observability |
| `__tests__/contract.test.ts` | Vitest structural tests — JSON validity, 23 steps, direct/materialized instruction branches, generic owner queries, L090 genericity gate, T2 breakdown DATA |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `AiRecordsItem` | `{kind:string, text?:string, src?:string}` | One item in a result record; kind is DATA-driven |
| `AiRecordsResult` | `{kind:"ai-records-producer.result", request_id, items, completed_at}` | Successful run record on the log |
| `AiRecordsError` | `{kind:"ai-records-producer.error", code, message, observed_at}` | Failed/empty run record |
| `resultAddress(id)` | `(requestId:string) => string` | Address helper for polling result |
| `errorAddress(id)` | `(requestId:string) => string` | Address helper for polling error |
| `auditRunAddress(id)` | `(requestId:string) => string` | Address for ai-execution-run audit record |
| `action:run-ai-records-production` | workflow, 23 steps | Main entry — resolves at most one profile by exact kind plus dynamic id, branches between bounded direct instruction hydration and owner materialization, resolves addressed inputs, dispatches the selected provider transport, then parses and writes records |
| `action:write-ai-records-producer-record` | loop sub-def, 1 step | Writes a single record emitted by the parser |
| `instr:breakdown` | DATA record, `wrap_prefix` string | T2 config — "Break this goal into 5-9 action steps…" |

## Addressed inputs

`action:run-ai-records-production` accepts optional ordered `input_refs`. A ref is either a canonical address string or `{address|canonical_address, expected_revision?, expected_content_hash?}`. Before provider dispatch, the workflow asks the current-record owner for those addresses and the request builder creates an immutable `ai-records-producer.addressed-input-snapshot/v1`.

Profile instruction hydration is also selective. The workflow resolves at most one profile from caller `agent_ref` or the selected-agent owner, then passes only that profile's bounded authored refs to `ai-instruction-blocks.materialize-harness-prompt`. That owner performs one current block read and returns only the exact ordered direct-profile rows. A direct CLI identity therefore selects zero profile rows; missing or ambiguous rows still fail closed in the final builder, and an empty selection never means “scan every instruction.”

Each snapshot item retains canonical address, current expected revision/content hash, normalized-content SHA-256, byte count, and source provenance. Its canonical JSON is appended to the provider prompt and the request records `snapshot_hash` plus `prompt_hash`. The owner fails closed for missing, retracted, stale, duplicate, malformed, explicitly unauthorized, or oversized inputs. Hard ceilings are 16 items, 32 KiB/item, and 128 KiB total; `input_snapshot_limits` may only make a call stricter.

The workflow’s live owner query accepts canonical top-level `input_refs` and the generic nested action-envelope shape `input.input_refs`; direct and nested values are normalized without consumer-specific branching. The pure builder rejects conflicting direct and nested values as ambiguous. The producer never writes source records, calls a provider, or decides domain authorization.

## Selected-profile instructions

When the selected `agent_ref` resolves to one current `ai-agent-profile`, its ordered `instruction_refs` are resolved against current `ai-instruction-block` owner rows before provider dispatch. Strings remain the normal ref shape; pinned objects may additionally name `expected_revision` and `expected_content_hash`. The builder rejects missing, ambiguous, duplicate, inactive, stale, malformed, and oversized rows instead of silently dropping or truncating instructions.

Profiles may also carry `instruction_selection` with kind `ai-agent-profile.instruction-selection/v1`. This optional lineage descriptor records a versioned source set, a byte budget, and every candidate's include/exclude disposition plus reason. It does not replace membership: included candidates must exactly equal ordered `instruction_refs`, and the producer rejects duplicate candidates, invalid budgets, hidden membership, or a canonical selection-hash mismatch. Profiles without it remain backward compatible.

Direct selections preserve profile order, then the legacy `wrap_instruction_ref`, then the user request and optional addressed-input snapshot. Their hard ceilings remain 64 instructions, 64 KiB per body, and 256 KiB total; a direct selection descriptor can only tighten that total.

A selection whose `resolve_mode` is `by-set-live` takes the sibling owner path: `ai-instruction-blocks.materialize-harness-prompt` assembles the named `harness-set`, stores the bytes in CAS, and returns only address/hash/count metadata. The producer validates that receipt against the profile's selection cap and request id, requires a process-shaped launch with `system_prompt_transport: "system-prompt-file-flag"`, and adds one `blob_ref` input at `.bitfield-harness/system-prompt.md`. The large prompt therefore never enters workflow argv, captured stdout, or an HTTP body. The request still carries an immutable body-free `ai-records-producer.profile-instruction-snapshot/v1` plus `system_prompt_content_hash`; missing blocks, malformed receipts, over-cap bytes, mount collisions, and unsupported transports fail before provider dispatch. A direct CLI selection that does not resolve to a profile remains backward compatible and has an empty instruction snapshot.

## Dependencies

**Depends on:** `selected-agent` (SSOT for which agent is active), `ai-agent-profile` (published-record rows, `process_launch` field), `ai-instruction-blocks` (current instruction rows and hash-only harness materialization), `ai-providers` (attribute_fact rows, provider/model/is_primary), `cli-registry` (attribute_fact rows, chat_launch descriptor), `workflow` (slot::workflow, compute.process/process_session, loop), `ai-execution-history` (ai-execution-run audit contract)

**Depended on by:** `agent-producer` (deprecated — this package supersedes it), any package that needs "run AI agent → structured record items" (breakdown, summarize, extract, generate)

## Why the DATA reads the way it does

These were `_note` and `_partition_routing_note` fields inside the record payloads, lifted out on
2026-09-09 because a payload ships to the live log and nothing there reads prose, so it travels
forever and goes stale with nothing to report that it has. Each appeared four times, once per copy
of the action definition, which is the other reason to hold them here: one README paragraph replaces
four copies that could drift apart.

**Why the config read has two sources.** It is superset-safe on purpose. Steps 0 and 1 use the
historical current-item `attribute_fact` projection; step 2 reads CLI launch DATA directly from its
canonical `prop:cli_registry:*` fold paths. Those compatibility reads cover live-written
selected-agent and provider config that is present only as published records. The builder combines
the sources WITHOUT copying canonical CLI facts into a second path.

**Why profile resolution happens before instruction hydration.** At most one selected profile is
resolved by exact kind and id first. A caller's `agent_ref` wins after trim and non-empty
extraction; absent or empty input falls back to the selected-agent owner rows. A direct CLI identity
resolves to zero profiles and therefore performs zero profile instruction reads. The final pure
builder independently re-validates profile ambiguity, ordered refs, pins, status and byte ceilings
before provider dispatch.

**Why the harness prompt step omits `partition_label`.** `load_from_live` reads the serving app, so
omitting it is what stops `ai-instruction-blocks` sending a stale or foreign partition identity to
`engine.operation.read-current`.

**Why legacy wrap instructions stay a separate query.** Their required projection is `id` plus
`wrap_prefix`, while profile instruction blocks require `kind`, `id`, `body` and `status`. Keeping
both queries indexable and projection-bounded prevents a multi-kind full-log scan and never asks the
byte parser to seek fields a row kind cannot contain.

**What addressed-input hydration guarantees.** The caller's ordered canonical `input_refs` resolve
through the current-record owner before provider dispatch. The Python builder rejects missing,
duplicate, retracted, stale, malformed, unauthorized and over-budget rows, and snapshots only the
exact returned content into the prompt.

**Where the `process_session` transport's two fields come from, and the sibling that looks right and
is not.** `ProcessSessionResponse` is `#[serde(tag='result')]`, so a live session reply lands at
`output.session_id` directly. That is the same generic ask-step output surface as
`compute.process`'s `output.termination.code` and http-client's `output.status_code`, differing only
in which fields the DATA selects. The second field is
`SessionStarted.snapshot.event_stream_address`, the per-event delta append lane a live subscriber
(composition, chat) tails for output events. It is NOT `snapshot.event_feed_address`, a sibling on
the same `ProcessSessionSnapshot` (`architect/crates/execution-types/src/process_session_types.rs`,
lines 189-211), which is only the bounded HEAD snapshot pointer and carries no incremental tokens.
Both are the empty string for the other two transports.
