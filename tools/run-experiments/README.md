# tools/run-experiments/

Experiments and personalization over what each visitor did: choose which version of a page, offer, headline or feature one visitor gets, read how each version did, and credit what visitors did (bought, signed up, clicked) to the version they saw. One idea carries A/B tests, personalization, feature flags and bandits: a set of candidate versions, a decider written as structured data that scores them from what is known about the visitor, and observations that feed the next choice. Three Workshop tools run in the deployed tool container: `tool:choose-what-a-visitor-sees`, `tool:read-experiment-results` and `tool:credit-outcomes-to-candidates`. Ported from bitfield-packages `packages/choose-per-observer` (the scoring, the sticky choice, the outcome counts and the join). Visitor capture and the outbound mirror are `tools/traffic-attribution`'s, so the package's own copies of them (`capture-signals`, `mirror-facts`) were not kept. The scoreboard and builder screens, and the saved-work-result learning that read the old engine's work store, were not brought in.

## Files

| File | Purpose |
|------|---------|
| `read-data/score-candidates.ts` | `scoreCandidates`: scores every candidate from the facts with the decider (ops by registry lookup, an absent fact scores neutral, an unknown op fails closed) and ranks them; `builtinOps`, `evalExpr`. |
| `read-data/decider-schema.ts` | `DeciderProgram` and `validateDecider`: structured score expressions, never string-encoded rules; rejects unknown ops. |
| `read-data/candidate-set-schema.ts` | `SelectionSurface`, `Candidate` and `validateCandidateSet`: zero, one or many candidates follow one path. |
| `read-data/select.ts` | `selectWinner` (pure) and `claimTranscript` (the first choice for a visitor is recorded and every later one reads it back). |
| `read-data/scoreboard.ts` | `aggregateOutcomes`, `readOutcome`, `computeRate`: per-candidate totals from outcome facts. |
| `read-data/attribute-outcomes.ts` | `attributeOutcomes`: joins who saw which candidate with who did what, from a join written as data. |
| `read-data/scope-records.ts` | `scopeRecordsForObserver`: applies every selection surface that fits a visitor to a list of records. |
| `do-work/observe.ts` | `buildObservationRecord`, `buildWriteBatchEntry`, `appendObservation`, `observationAddress`: the one append-only observation shape; the writer is handed in. |
| `do-work/choose-what-a-visitor-sees.mjs` | The command of `tool:choose-what-a-visitor-sees`. |
| `do-work/read-experiment-results.mjs` | The command of `tool:read-experiment-results`. |
| `do-work/credit-outcomes-to-candidates.mjs` | The command of `tool:credit-outcomes-to-candidates`. |
| `data/decider-bandit.example.json` | An example decider: split by visitor until the caller passes the fact `experiment.has_results` true (from `tool:read-experiment-results`), then the version with the best recorded rate. An absent fact scores 0.5, which a `case` reads as true, so a bandit cannot test the rate itself for being known. |
| `data/one-price-test.example.json` | An example price test with one price in it: one candidate offer with all the weight; a second price is one more candidate and one more weight. |
| `data/personalize-by-where-they-came-from.example.json` | An example of one headline per visitor: who they are (an enrichment fact), then where they came from (`visit.utm_source`), then an A/B split between the defaults. |
| `records.json` | The three tool rows. |
| `tool-rows.json` | The tool-row source that lists `records.json`'s rows into the Workshop. |
| `test/` | The package's tests of the files above, `run-experiments-tools.test.mjs`, which runs each tool the way its row runs it, and `examples.test.mjs`, which runs the examples in `data/`, and `observer-bucket.test.mjs`. |
| `part.json` | No public files: only the tool runs this code. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `scoreCandidates` | `(surface, facts, decider, registry?, stickyKey?) => { ranked, winner, findings, op_used }` | One decision. |
| `observerBucket` | `(observerKey, count) => number` | A stable group in `[0, count)` for an observer, for callers that need a group and no decider (a staged rollout, a sampled check). |
| `selectWinner` | `(surface, facts, decider, stickyKey, registry?) => Candidate \| null` | The winner only. |
| `DeciderProgram` | `{ entity_type: 'decider', decider_id, score, accepts_trust }` | The rule that picks, as data. |
| `SelectionSurface` | `{ entity_type: 'selection-surface', address, decider_program_ref, candidates }` | The versions on offer. |
| `AttributionJoin` | `{ entity_type: 'attribution-join', join_id, assignment, outcome, emit }` | Names the two record families and how they join. |
| `ObserverFact` | `{ path: string[], trust_ref, value }` | One thing known about a visitor. |

## Dependencies

**Depends on:** Node 24 (type stripping for `.ts`). What is known about a visitor comes from `tools/traffic-attribution`, the one owner of visitor tracking: a visit's signals (`utm_source`, `referrer` and any other key it captured) are handed in as facts `{ path: ['visit', <key>], value, trust_ref: 'trust:observer-supplied' }`, and the visitor key is the visit's observer id. This folder captures no visit of its own and sends nothing to outside venues; traffic-attribution's `observe-traffic.ts` does both.

**Depended on by:** `tools/traffic-attribution` does not import this folder. The sales page tool takes the chosen version as a handed-in function (`selectWinner`).

## Invariants

- Ops are looked up in a registry, never switched on; a new op is one entry. An absent fact scores neutral (0.5); an unknown op fails closed (0).
- Trust is an open string the decider lists in `accepts_trust`; facts with another trust are not read.
- Zero, one and many candidates take one code path. The same facts, visitor key and decider always give the same winner.
- Observations only append; nothing here updates one. Time is a handed-in `at`, never read from a clock.
- No candidate, metric, source or decider name is written in code; examples are data.
