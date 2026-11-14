# choose-per-observer

Pure leaf primitives for observer-conditioned, self-recording selection over the fact log. Implements the DECIDE + OBSERVE generative primitive (plan §4) that collapses A/B testing, personalization, feature flags, bandit optimization, and customer-360 tracking into two verbs over one log.

## Files

### Saved work result learning

Observation and transcript builders require explicit `at` time. Installed targets
read it from `readTrustedRuntimeClockMs(context)`; browser view capture supplies
its event time at the browser boundary. Missing time fails before a write, not by
reading the system clock in a derivation. Replays retain the original observed time.

`action:choose-per-observer:observe-saved-work-result` accepts exactly one of
`binding_ref` or `permission_lease_ref`, plus optional `saved_delivery`.
The permission form closes the automatic handoff: it rereads the canonical
`permission_lease` at the permission owner's label-hash address. That note must
allow both `learn-local-saved-result` and `learn-local-useful-impact`, carry its
verified decision proof, remain unrevoked, and bind the exact context through the
permission owner's `bound_context`. The context names work/user/installation/
observer refs, `selection_surface_ref`, `applicability_ref`, the selected
`candidate_id`, its render-owned `candidate_material_ref`, and approved
`useful_impact`. The candidate material is never inferred from result bytes and
never treated as permission to execute. The selector verifies the complete saved
Work Control result lineage. A deterministic binding and observation commit together under all
owner/permission bases. Nothing creates or broadens a lease. Missing work,
usefulness evidence or consent refuses without publishing a binding. A later
approved measurement updates the same binding; replay remains idempotent.
Fleet's existing bounded cycle discovers these explicit leases and calls the
same action, avoiding duplicate calls through an already-derived binding.
The current `saved-work-result-learning-binding` supplies `work_ref`, `observer_id`,
`candidate_id`, `candidate_material_ref`, `installation_ref`, `user_ref`, `permission_lease_ref`, and active
`state`. The existing permission lease must explicitly grant
`learn-local-saved-result` for that work, observer, installation and user.
This action never creates a grant. Fleet discovers configured bindings through
its existing evaluation cycle; no additional clock or transcript store exists.

The action rereads Work Control fact, progress, result, derivative and continuation
receipt, binds their revisions and evidence, and writes a refs-only observation
with all current source/permission bases in one atomic batch. Retry rereads the
same owners; lost responses recover only if those owners still match.

An optional `selection_surface_ref` plus `applicability_ref` selects through the
existing scorer using that freshly checked fact and the surface's current decider.
The surface must have matching applicability and link the configured candidate to
the exact permission-bound render material. The return's `choice` contains only candidate/material refs.
Call this action again for a later choice; do not use its historical observation
as proof that permission or the saved result is still current.

`saved_result_revision` measures revision freshness, **not usefulness, customer
success or publication**. A revision-driven choice change does not satisfy Fleet's
separate real-outcome or consenting-second-installation completion gate. Private
result prose stays in Work Control; no transfer or profile/worker launch occurs.

Optional `useful_impact` measures a separate, explicitly approved Customer-loop
attempt through `content-analytics`'s existing `measureCustomerLoop`. The canonical
permission note must additionally allow `learn-local-useful-impact` and bind the exact same
`useful_impact` object inside `bound_context`. This is configuration of existing permission, not a grant
created by the selector. Its fields are:

- `measurement_revision`: monotonic nonnegative integer, independent of saved-result revision.
- `result_ref`, `saved_result_revision`: exact Work Control result identity/integer revision.
- `tenant_ref`, `recipient_ref`, `provider_ref`, `job_ref`, `job_revision`,
  `run_ref`, `result_revision`: opaque Customer-loop journey identities. The last
  revision is a string owned by Customer-loop, not an inferred conversion of the
  Work Control integer. `run_ref` must equal the saved delivery run's `id`.
- `attribution_window_ms`: positive bounded-integer window approved in the lease.
- `event_refs`: 4–64 exact `{address, content_hash, address_mode?}` records;
  `delivery_ref`: the same descriptor for the existing `content-generation.run`.
  Modes are `identity-text` (default) or `label-hash`. Hashes are native `1f:` hashes.

The selector rereads and fences the delivery proof, its execution and document
bases, and every event. Exactly one content/result/run/outcome per attempt is
required, with matching journey identities and an explicit boolean `useful` on
the outcome. Missing, duplicate, conflicting, late, or changed evidence refuses
the entire write. A completed process, a saved document, or a newer revision
cannot supply that boolean. The approved producer and outcome evidence remain
responsible for its real-world truth; a caller's free-form assertion is not a
measurement. Synthetic test records never establish actual customer usefulness.

This mode writes `useful_result_count` through the existing observation owner.
A later approved measurement can change the choice without changing the saved
result revision; a negative measurement removes the preference. Exact replay
preserves the observation bytes and count, while rechecking permission and all
bases. The response identifies the `measurement.metric` and `measurement.value`.
No private event fields or document text are copied into observations.

Understanding's existing continuation may call the same action with optional
`saved_delivery: {result_ref, result_content_hash, input_refs}`. Configure its
successor `input` as `{binding_ref}` and `feedback_field` as `saved_delivery`.
The feedback must exactly match the permission-bound delivery and its
`input_refs: [{canonical_address, expected_content_hash}]`; it never creates
permission or useful-impact evidence. UI/readback and Fleet use this same action,
not a separate endpoint. Installation, genuine later usefulness and compatible
second-installation transfer remain separate checks.

| File | Purpose |
|------|---------|
| `index.ts` | Public barrel export for all Wave-1 primitives |
| `things-to-store-and-run.json` | Package boundary: stored-bytes entries + contract record |
| `vitest.config.mjs` | Vitest config (node env, `@/` alias to repo root) |
| `read-data/score-candidates.ts` | Pure evaluator: `scoreCandidates(surface, facts, decider, registry, stickyKey)` → `{ranked, winner, findings, op_used}` |
| `read-data/decider-schema.ts` | `DeciderProgram` type + `validateDecider(record, knownOps)` |
| `read-data/candidate-set-schema.ts` | `SelectionSurface` type + `validateCandidateSet(record)` |
| `read-data/attribute-outcomes.ts` | ATTRIBUTE op: `attributeOutcomes(config, assignments, outcomes, at)` — pure DATA-configured join from assignment records × outcome records → per-candidate observation facts (`candidate/outcome/<metric>/<candidate_id>`); `validateAttributionJoin`, `readAtPath` |
| `read-data/scope-records.ts` | Owner boundary for consumers: `scopeRecordsForObserver(records, scopingProjection, cookieString)` — resolves the observer from a DATA `observer-source` row, applies every applicable selection-surface/decider row, returns the scoped list + decisions. Consumers never touch surface/decider/observer vocabulary |
| `write-data/observe.ts` | `buildObservationRecord`, `buildWriteBatchEntry`, `appendObservation` |
| `__tests__/score-candidates.test.ts` | 30 tests: ops, absent-fact neutral, gate degenerate, trust filter, sticky_hash, adversarial |
| `__tests__/decider-schema.test.ts` | 33 tests: valid programs, invalid fields, unknown op rejection, multi-error |
| `__tests__/candidate-set-schema.test.ts` | 31 tests: N=0/1/≥2, invalid fields, duplicates, golden static-page case |
| `__tests__/observe.test.ts` | 22 tests: record shape, address format, append-only, trust verbatim, read-back contract |
| `__tests__/attribute-outcomes.test.ts` | 26 tests: config validation, join fold, where filters, conflict/dup assignments, value summing, convergent re-projection, cross-family genericity, 10k linear fold |
| `__tests__/scope-records.test.ts` | 10 tests: scoping, stickiness, absent cookie/source rows, data-driven cookie name, non-applicable surfaces, missing decider, ref prefixes, cross-family deletion test |
| `__tests__/entry-scope-import-contract.test.mjs` | Package-DATA contract: every entry source imports its declared `entry_name` scope; rejects import drift even when a stale copied scope exists, and rejects undeclared generated scope directories |

## Package-entry scope invariant

`things-to-store-and-run.json` is the authority for entry-scope identity. The scoreboard entry declares `entry_name: "scoreboard"`, so its mount imports `.bitfield-entry-scope/scoreboard/runtime-kit-react`. A directory left by an older generated scope is never evidence that a different import is valid.

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `scoreCandidates` | `(surface, facts, decider, registry?, stickyKey?) → ScoreCandidatesResult` | Pure evaluator: scores all candidates, returns ranked list + winner |
| `ScoreCandidatesResult` | `{ranked: CandidateResult[], winner: Candidate\|null, findings: string[], op_used: string}` | Full result of one DECIDE call |
| `ObserverFact` | `{path: string[], trust_ref: string, value: unknown}` | One fact about an observer (input to evaluator) |
| `OpRegistry` | `Record<string, OpHandler>` | The ONLY dispatch table — add a new op by adding one entry |
| `builtinOps` | `OpRegistry` with `sticky_hash, eq, lt, gt, gte, not, and, or, case, outcome` | Built-in op pack; extend by spreading |
| `evalExpr` | `(expr: ScoreExpr, ctx: ScoreContext) → number` | Recursive score expression interpreter; exported for content-gate reuse |
| `DeciderProgram` | `{entity_type:'decider', decider_id, score: ScoreExpr, accepts_trust: string[]}` | DATA record: the rule that picks |
| `validateDecider` | `(record, knownOps?) → DeciderValidationResult` | Validates a decider record; rejects unknown ops when registry supplied |
| `SelectionSurface` | `{entity_type:'selection-surface', address, decider_program_ref, candidates: Candidate[], ...}` | DATA record: N self-describing candidates at an address |
| `validateCandidateSet` | `(record) → CandidateSetValidationResult` | Validates a selection-surface record |
| `ObservationRecord` | `{entity_type:'observation', observer_id, trust_ref, path: string[], value, at, basis?}` | The universal OBSERVE fact shape |
| `attributeOutcomes` | `(config: AttributionJoin, assignments, outcomes, at) → {observations: ObserveOptions[], findings}` | ATTRIBUTE: pure join fold; sums counts + values per (observer, metric, candidate); emissions feed the existing scoreboard |
| `AttributionJoin` | `{entity_type:'attribution-join', join_id, assignment{observer_key_path,candidate_key_path,where?}, outcome{observer_key_path,metric_path,value_path?,where?}, emit{observe_address,metric_map,value_metric?,trust_ref?}}` | DATA record: names the two fact families and how they join — zero code per experiment family |
| `validateAttributionJoin` | `(record) → {valid, errors}` | Validates an attribution-join record; lists every error |
| `readAtPath` | `(record, path: string[]) → unknown` | Structured path walker (records + arrays); undefined on miss |
| `buildObservationRecord` | `(options: ObserveOptions) → {record, address}` | Pure: builds an observation record + its log address |
| `buildWriteBatchEntry` | `(options) → WriteBatchEntry` | Pure: builds the write-batch entry (remove:false always) |
| `appendObservation` | `(options, engineWriteBatch) → Promise<{address}>` | Thin wrapper: calls injected write-batch; not unit-testable standalone |
| `observationAddress` | `(observerId, path) → string` | `observer::<id>::<path::joined>` |

## Dependencies

**Depends on:** nothing at import time (all pure). `appendObservation` accepts an injected `engineWriteBatch` function — no hard engine import.

**Depended on by:** `public-sales-page` (T6 resolver generalization), `background-runner-shell` (T7 scene-assembly decide), `content-gate` (imports `evalExpr` + `builtinOps` as the shared evaluator SSOT for Wave-2+).
