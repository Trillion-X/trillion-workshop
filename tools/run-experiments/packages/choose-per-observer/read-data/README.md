# read-data/

**Purpose:** Read operations — evaluators, schema validators, aggregators, and decision orchestrators.

## Files

| File | Purpose |
|------|---------|
| `map-fact-fields.ts` | Pure `mapFactFields(fact, field_map?)`: field_map DATA -> venue event payload; the one mapper outbound mirrors use. Public here (read-data is the declared public-source dir) so `traffic-attribution` composes it without importing do-work. |
| `score-candidates.ts` | Pure evaluator: score all candidates against observer facts using a decider program (Wave-1, T1). Contains `evalExpr`, `scoreCandidates`, built-in ops registry. |
| `decider-schema.ts` | Schema + validator: `DeciderProgram` type and `validateDecider` (Wave-1, T3). Defines `ScoreExpr` union (structured nodes, never string-encoded). |
| `candidate-set-schema.ts` | Schema + validator: `SelectionSurface` type and `validateCandidateSet` (Wave-1, T4). Defines `Candidate` type. |
| `select.ts` | DECIDE orchestrator: `selectWinner` (pure), `claimTranscript` (sticky memoization via observations). Reads fact snapshots, builds decision transcripts (Wave-2, T5). |
| `scoreboard.ts` | Aggregator: `aggregateOutcomes` projects per-candidate outcome metrics from facts. O(facts at address). Includes `readOutcome`, `computeRate` helpers (Wave-2, T11). |

## Key Types

| Type | Signature | Role |
|------|-----------|------|
| `ScoreExpr` | Union: `FactPathNode \| ConstNode \| CandidateScoresNode \| SplitNode \| OpNode` | Structured score expression (never string-encoded predicates). |
| `DeciderProgram` | `{entity_type:'decider', decider_id, score:ScoreExpr, accepts_trust:string[]}` | Program that selects winners. |
| `SelectionSurface` | `{entity_type:'selection-surface', address, decider_program_ref, candidates:Candidate[]}` | Candidate set + decider ref. |
| `DecisionTranscript` | `{entity_type:'transcript', observer_id, address, epoch, winner, ...versions}` | Immutable memoization record. |
| `Scoreboard` | `{address, candidates:Record<id, CandidateOutcomes>, total_events}` | Aggregated outcomes projection. |

## Dependencies

- Pure: zero I/O imports in `score-candidates.ts`, `decider-schema.ts`, `candidate-set-schema.ts`, `scoreboard.ts`.
- `select.ts` injects `appendObservation` (from `write-data/observe.ts`) for memoization writes.

## Non-Negotiable Invariants

1. **Op registry:** Dispatch ops only via `OpRegistry` lookup. Never `switch(op)` / `if op===`. New op = 1 registry entry (L090).
2. **Trust filtering:** Open `trust_ref` DATA property. Never a code enum.
3. **Absent fact → neutral score (0.5).** Unknown op → fail-closed (0.0).
4. **Cardinality 0..∞:** N=0/1/≥2 follow one code path (no branch).
5. **Structured nodes:** `{op, left, right}` shape, never string predicates.
6. **Sticky determinism:** Same inputs → same winner (used by memoization).
