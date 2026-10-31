# tools/evaluate-progress/

Measures worked out over a person's records, and the bands, gates and scores that act on them. A measure is a definition the person (or their AI) gives: an op, the records it reads (a match on fields and a path to the value) and the op's params. One reducer runs every definition, so a count, a ratio, a ranked and packed list and a state walked through events are the same operation with different definitions. The tool names no field, word, band or threshold: they all arrive in the request. This includes the sort field of `latest`, the kind a scored response fact carries and the tone of a nudge; a request that leaves one out is refused with a sentence.

An op that is not known, or that fails, gives a measure with `ok: false` and confidence 0. It never gives a made-up number or throws. The gates say no when they cannot tell: an unfinished assessment, an unknown risk or a threshold that is not a number never releases an output or sends a nudge.

This is taken from the progression evaluator package. Its measure reducer, op catalog, pipeline, band and rule evaluation, corroboration, grounding, questionnaire scoring and person-stitching are the same code here. Its safety and nudge gates are the generic `risk-gate` and `nudge-gate` (the old wording, the fixed tone and the hard-coded framing are now the caller's). Not carried: the engine's accepted-effects target, the process-script wrappers and built bundles, and the measure-to-visual-database materializer (all engine or screen plumbing), and the package's stored measure definitions, rules and thresholds (a person's own data).

## Files

| File | Purpose |
|------|---------|
| `read-data/derive-measure.ts` | The one reducer: select fact windows, run the op from the op map handed in, give value, confidence, basis and ok |
| `read-data/measure-ops.ts` | The op catalog (below) |
| `read-data/measure-pipeline.ts` | Stages that read the raw facts or the rows an earlier stage emitted |
| `read-data/band-membership.ts` | The half-open band `[min, max)`: contains, index of, payload of |
| `read-data/get-path.ts` | Read a value at a path array |
| `read-data/evaluate-progression.ts` | The rules a person's numbers fire, in rule order |
| `read-data/corroboration-gate.ts` | Required checks plus a quorum of optional ones |
| `read-data/risk-gate.ts` | Release an output only under the caller's risk threshold; otherwise hold it back with the caller's resources |
| `read-data/nudge-gate.ts` | Opt-out, then rate limit, then risk; the tone and framing are the caller's |
| `read-data/verify-grounding.ts` | Every claim cites a source that was really read |
| `read-data/score-instrument.ts` | Questionnaire responses into scored facts, reverse-keyed items reflected |
| `read-data/cohort-stitch.ts` | Records sharing a key become one person with a stage, a source and a value |
| `do-work/requests.mjs` | One function per row: checks the request, refuses with a sentence, calls the above |
| `do-work/run-request.mjs` | `node do-work/run-request.mjs <function>`: the request on standard input, `{ result }` or `{ error }` out |
| `part.json` | The one public module |
| `tool-rows.json` | The eight Workshop rows |
| `test/*.test.mjs` | Every op, the pipeline, bands, rules, the gates, scoring, stitching and each row's sample run in the container |

## The rows

| Row | Function | What it does |
|-----|----------|--------------|
| `tool:work-out-measures` | `workOutMeasures` | Definitions (or one, or a pipeline) over facts, answered with value, confidence, basis, ok |
| `tool:pick-fired-rules` | `pickFiredRules` | The rules whose band holds each metric's number, with their adjustments |
| `tool:check-corroboration` | `checkCorroboration` | Is there enough independent support to act |
| `tool:hold-back-on-risk` | `holdBackOnRisk` | Release, or hold back with the support resources |
| `tool:decide-a-nudge` | `decideNudge` | Whether to nudge now; with `allowed_tones`, a nudge in an unlisted tone is not sent |
| `tool:check-claims-are-grounded` | `checkClaimsAreGrounded` | Are the claims' citations real |
| `tool:score-questionnaire-responses` | `scoreResponses` | Scored facts per response |
| `tool:stitch-facts-into-people` | `stitchFacts` | The people the records make, best stage first |

## The ops

A definition is `{ id, op, inputs: [{ match?, field? }], params?, window?, emit?, failClosed? }`. `match` keeps records whose fields deep-equal the given values (none keeps all) and `field` is the path array to the value read from each. Ops read `inputs[0]` unless said.

| Op | Params | Value |
|----|--------|-------|
| `count`, `sum`, `distinct` | | the number of records, the sum of the field, the number of distinct field values |
| `ratio` | `mode: "sum"` (else counts) | `inputs[0]` over `inputs[1]`; 0 with confidence 0 when the second is empty |
| `bin` | `edges` | `{ counts }` per `[edge, next edge)` |
| `band` | `bands: [{ min?, max?, payload? }]` | the payload (or index) of the band holding the latest value |
| `rank` | `ascending` | record ids by the field, largest first |
| `latest` | `sortBy` (path, required) | the field of the record with the highest sort key |
| `quantile` | `q` (0 to 1, median when not a number) or `reduce: "min"` / `"max"` | the interpolated quantile |
| `angle` | | the angle in degrees at the point of `inputs[1]` between `inputs[0]` and `inputs[2]` |
| `rollup` | `groupBy` (path), `reduce: "count" / "sum" / "avg"` | `{ groups, keys }` |
| `formula` | `expr`: `{ const }`, `{ input, reduce }`, `{ recode, map, default }`, `{ op: add / sub / mul / div, args }` | the number, or null with confidence 0 |
| `reduce-graph` | `graph: { start, transitions: [{ from, on, to }] }`, `eventField` | `{ state, path }` |
| `weighted-rank` | `weights` (field to weight), `limit`, `ascending` | `{ ranked, top, scores }`, each with its strongest field |
| `derive-spans` | `timeField`, `timeUnit`, `fps`, `preS`, `postS`, `scoreField`, `scoreScale`, `scoreClamp`, `minScore`, `category` | a list of `{ id, start, end, score, category }` |
| `constrained-span-pack` | `startField`, `endField`, `scoreField`, `categoryField`, `mergeGapS`, `maxMergedDurationS`, `perCategoryQuota`, `defaultQuota`, `maxDurationS`, `maxCount` | `{ selected, rejected, totalDurationS }`, best score first, no overlaps |
| `relevance-rank` | `queryTerms`, `candidateFields`, `weights`, `scoreField`, `minScore`, `topK` | `{ ranked, top, scores }` by weighted word overlap |
| `mutual-overlap` | `xField`, `yField`, `combine`, `minScore`, `topK` | pairs whose words each give what the other wants |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `deriveMeasure` | `(facts, definition, opMap) -> MeasureFact` | `{ measureId, emit, value, window, provenance, confidence, basis, ok, error? }` |
| `runMeasurePipeline` | `(facts, { stages: [{ id, def, from? }], result? }, opMap) -> { stages, order, result }` | `from` names stage ids or `"$facts"` |
| `evaluateProgression` | `({ signals, rules }) -> { fired, adjustments, matched }` | Rule `{ id, metricRef, band, adjustment }` |
| `evaluateRiskGate` | `(assessment, { threshold, supportResources }) -> { release, hold_back, reason, support_resources, categories }` | Fails closed |
| `decideNudge` | `(context, { riskThreshold, framingRef, tone }) -> { nudge, tone, framing_ref, reason }` | Fails closed |
| `stitchCohortLedger` | `(facts, config) -> { ledger }` | Union of records by shared key values, scoped by path; `stage` and `stageRank` are null for a person no rule reaches when the config has no `baseStage` |

## Dependencies

None outside the folder: plain TypeScript run by Node's type stripping, no packages. Records come to the tool in the request (`facts`), so it holds no records access, no credential and no network (`internet: false` on every row).

The `measures` field `measure_id` picks one definition from `measures` and `params_override` merges params into the chosen ones; both are refused when a `pipeline` is sent.
