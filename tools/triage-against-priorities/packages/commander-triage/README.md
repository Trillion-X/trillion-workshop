# commander-triage

Per-item intelligence triage that composes existing engines ONLY (zero new engine) to score every sensed item against the founder's priorities/SSOT and resolve a DATA-selected disposition — the "Napoleon commander" loop, source-blind and enum-free.

## Files

| File | Purpose |
|------|---------|
| `things-to-store-and-run.json` | The package boundary: 16 things — the capability, the original triage/brief DATA, plus one business-ignition policy, one guarded work resolver, and one decision trigger. All behavior is DATA; there is no `.rs`/`.ts` source. |

## Key records

| Address | Kind | Role |
|---------|------|------|
| `package::trigger-engine::trigger-rule::commander-triage-on-ledger` | `trigger-rule` | **Source-blind** delta rule: fires on ANY observed-content admitted ledger batch (`change.accepted.0` present AND `envelope.is_retraction==false`) — names no source. Dispatches `action:commander-triage-batch`. |
| `package::commander-triage::workflow-action::commander-triage-batch` | `action` | Loops `input.batch.accepted`, invokes `commander-triage-observation` per item. |
| `package::commander-triage::workflow-action::commander-triage-observation` | `action` | Nested-dispatches `ai-records-producer` with the raw item (stringified) + the OPEN disposition catalog + priorities feed; validates via an on_result DAG (confidence/membership); materializes ONE `commander-triage.decision`, else a fail-closed `escalate-human` decision. |
| `package::commander-triage::workflow-action::launch-authorized-work` | `action` | CAS-creates one immutable assigned-work source from an admitted launch decision and DATA policy, then calls `process-session.start-authorized-assigned-work-session`. Commander never launches compute directly. |
| `package::trigger-engine::trigger-rule::commander-launch-authorized-work` | `trigger-rule` | Immediately dispatches the guarded resolver for `launch-experiment` decisions that do not need The owner. Records an ignition receipt only after the owner returns a session and authorization provenance. |
| `package::commander-triage::disposition-descriptor::*` | `disposition-descriptor` | 5 proof rows over an OPEN family: retain-only, store-knowledge, integrate-artifact, launch-experiment, escalate-human. Consequential ones fail closed to `needs_human:true` until a deny-by-default guarded op + receipt exists. |

Both trigger rules carry the `trigger-rule` path label required by trigger-engine's bounded cold-boot subscription. The repository-wide `scripts/trigger-rule-bootstrap-path-invariant.test.mjs` guard rejects any trigger rule that would be stored but invisible after restart.
| `package::commander-triage::placeable-surface::commander-brief` | `placeable-surface` | The bounded brief: one visual-database surface deriving attention through formula-engine and selecting the needs-human decision rows. No false launch-success label. |
| `package::ai-records-producer::{instruction,…priorities-feed,input::…}` | producer DATA | The triage rubric instruction block + the founder priorities/SSOT `record_from_matching_records` feed + its input descriptor. |

## Dependencies

**Depends on (via Envelope addresses + log DATA only — never crate imports):** `trigger-engine` (delta rule dispatch), `ai-records-producer` (the triage LLM call — the universal reader; no per-source decode), `visual-database` + `formula-engine` (the bounded brief projection and derived attention), `ui` + `screen-arrangement` (permitted row-open intents), `observed-content` (the admitted ledger batch it triggers on), `ai-work-control` (source/profile/tool/guard/permission/budget readback and reservation-fenced process launch), and the effect owners named by the remaining dispositions (`knowledge-records`, workflow owner-op).

**Depended on by:** the Founder Autonomy Mandate program (this is its per-item triage lane; the standing topic-analyst mode is `autonomous-worker`, a separate lane).

## Deploy

Package-implementation records → activate ONLY via the scoped `bitfield.package_delta/v1` path (`apply-package-delta-live.mjs --package-set-folder <folder> --partition <partition> --package commander-triage`). Not `engine.operation.write-batch`. Correct home = the founder CoS / studio package-set (where the observed-content SENSE + priorities live). Plan: `notes/projects/packages-and-package-sets/commander-triage/plans/2026-07-31-commander-intelligence-triage/`.

## Invariants

- **Source-blind:** zero `source:x`/provider literals in engine records; a source is one `conversation_source_descriptor` DATA row consumed by the existing generic ingest chain (`chat` pkg `run-source-producers`/`decode-one-source`) — this package NEVER grabs or decodes a source itself.
- **No closed enum:** dispositions are DATA descriptors; adding one = one row + one trigger-rule + an existing owner action, zero engine change.
- **Fail-closed:** launch-experiment may create only safe reversible evidence work and must pass `ai-work-control` source/profile/tool/guard/permission/budget readback. External messages, spend, publishing, commitments, credentials, production mutation, and every other consequential effect remain with their authority owners; `ai-action-guard` is a forwarder, not authority.
- **Owner decision, not caller claims:** the launch resolver accepts only `decision_ref`, re-reads the exact current decision and policy, and validates both before materialization. A replay reuses the deterministic source and the downstream reservation/session idempotency fence.
- **Truthful worker launch:** the selected `autonomous-safe-operator` profile owns its exact provider/model/process launch. Authorized work rejects unavailable profiles, missing launches, and model/provider substitutions; it never inherits the package's convenience fallback.
- **Session start is nonterminal:** the ignition receipt says `AUTHORIZED WORK SESSION STARTED`. It cannot claim perpetual motion, a customer outcome, or a successor until those effects have owner readback and measurement.

## Why the DATA reads the way it does

These were `_note` and `_bound_contract` fields inside the record payloads, lifted out on 2026-09-09
because a payload ships to the live log and nothing there reads prose, so it travels forever and
goes stale with nothing to report that it has. They are kept verbatim, because each one is a
source-confirmed fact about a step's shape that is expensive to re-derive.

**`max_iterations` in the fanout is a bound, not a preference.** It equals the ingestion
bounded-chunk contract's page-size ceiling, which is DATA enforced by the observer operation, which
chunks each ledger batch to at most that. `automation.rs` fails loud, erroring the whole loop rather
than dropping silently, if a batch exceeds it, so no observation is lost. The value in the DATA is a
placeholder pending the observer operation's page-size DATA; the ingestion owner must chunk to at
most it and persist per-item receipts under `tolerate_item_errors`.

**Why the two `slot::find-current-items` ask steps resolve at `.output.items`.** Confirmed
2026-08-02 from source: an ask step is `config.name(slot::find-current-items)` plus `config.input`,
and the executor stores the target reply verbatim at `steps.<id>.output` (workflow-core
`step_executor.rs`, `execute_leaf_step_delta` header). A `find-current-items` reply is
`{items:[...]}`, so `.output.items` resolves. The second of the two is the priorities feed
(`source_kind commander.priority`), and an EMPTY one is fine: the rubric fails closed to
`escalate-human`.

**Why the producer step reads structured fields straight off `output.result_payload.items.0`.**
Confirmed 2026-08-02 from source: `ai-records-producer`'s `make-ai-records-from-command-output.py`
`main()` turns a single AI object into `[{kind, **obj}]` and an array through
`build_items_from_extracted` into `{kind, text, **elem}`, and that L090 structural passthrough
preserves `disposition_ref`, `confidence`, `rationale` and `target_artifact_ref`. The action's
`output_template.result_payload` is `lookup('result_payload')`. Commander selects its executor
through `commander-triage.ai-route` DATA, and normalized producer records are validated at
`output.records.0.payload`.
