# ai-execution-history

The single execution ledger: generic reading, rendering, start-request forwarding, immutable human review receipts, and session-artifact ingestion for execution records — the ONLY package that owns run and execution-review records (everything else references them by address).

## Files

| File | Purpose |
|------|---------|
| `things-to-store-and-run.json` | Package boundary: contracts, entry, target, `capability:ingest-session-artifacts` |
| `index.ts` | Package barrel |
| `read-data/read-ai-execution-history.ts` | Generic reader: published records → `{runs[], steps[], reviews[]}` |
| `do-work/request-execution-start.ts` | Forwards an execution-start request to a caller-named target |
| `do-work/record-review-decision.ts` | Writes one immutable, idempotent, readback-confirmed execution review receipt; decision vocabulary remains descriptor DATA |
| `do-work/process-scripts/ingest-session-artifacts-to-runs.py` | Standing ingestion: session-artifact JSONL → `ai-execution-run` write dispatches (launcher-blind; shapes are caller DATA rows; idempotent identity; fail-closed rejections) |
| `do-work/process-scripts/__tests__/test_ingest_session_artifacts_to_runs.py` | Proof: two shapes via two DATA rows, idempotent re-run, rejection path, since/limit |
| `show/ExecutionHistoryPanel.tsx` | The run-history surface: `ui`-composed run cards leading with the run objective (never a raw id — L118), derived health badge, timing, cost, step count, plus a header triage count |
| `show/mount-ai-execution-history.tsx` | Mounts `ExecutionHistoryPanel` as the `ai-execution-history.panel` placeable surface; injects owner health rules as DATA |

## Key Types / Records

| Item | Shape / Signature | Role |
|------|-------------------|------|
| `ai-execution-run` record | `{id (required), agent_ref?, started_at?, ended_at?, status?, objective?, launch?, cost?, outcome?, correlation_refs?, provenance?}` — all optional families open/self-describing | THE run ledger record; identity `ai-execution-run:<namespace>:<native_id>`, address `package::ai-execution-history::run::<token>` (re-ingestion folds, never duplicates) |
| `ai-execution-step` record | `{id, run_ref (required), tool_ref?, duration_ms?, status?, sort_order?}` | Per-step truth where artifacts carry it |
| `ai-execution-review-decision` record | `{id, execution_ref, candidate_ref, decision, review_note, reviewer_ref, reviewed_at, evidence_refs, supersedes_review_ref?}` | Immutable human review provenance; the owner supplies time when absent; repeated identity is idempotent or conflicts fail closed |
| `readExecutionHistory(records)` | `PublishedRecord[] → ExecutionHistory` | Blind fold of published records |
| `requestExecutionStart(input)` | `{target, agent_ref?, input?}` → Envelope dispatch | Start-request forwarding |
| `recordReviewDecision(input)` | execution/candidate/reviewer provenance → `{accepted, review_ref, idempotent}` | Basis-safe append and owner readback |
| `capability:ingest-session-artifacts` | config `{partition_label, sources[], since?, limit?}` → `{writes[], rejections[], artifact_count}` | Standing artifact→ledger pipeline; backfill = first invocation |

## Invariants

- Names NO launcher: `claude`/`codex`/anything appear only in caller source DATA rows (`id_namespace`, `launcher_ref`, extract rules). New launcher = one DATA row, zero code.
- Absent artifact truth stays absent — no fabricated status/cost/outcome.
- Unreadable artifact → one machine-readable rejection record, never a silent skip.
- Review decisions are open descriptor-owned strings; this package enforces receipt identity and provenance, not a closed approval taxonomy.

## Dependencies

**Depends on:** `@bitfield/runtime-kit` (`sendRequestToBitfieldTarget`); write application via `engine.operation.write-batch` (caller-side).
**Depended on by:** `agents-hub` (agent cards read runs), `visual-database` projections (DATA views over `kind: ai-execution-run`), `ai-records-producer` (writes run audit records under this contract).
