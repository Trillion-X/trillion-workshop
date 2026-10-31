# tools/judge-words/

Judges words a person will read, and any JSON a person makes (a plan, a take's measures, a report, a whole script given as blocks, evidence about where its words came from), against rule rows the caller hands in, and says which rows each one breaks, with why and what to do instead. One row shape serves every kind of thing checked: a kind is a word in the row's `kinds`, never code. Ported from the copy judge `parts/judge-words`; the selectors, grammar checks and owner paths are unchanged, and rows gain `kinds`, value `path` with `where`, tests that say what must hold, and `because` and `at_most` carried onto every finding.

The content gate (bitfield-packages `packages/content-gate`) is merged in, so there is one judge: its pattern, required-kinds, kind-order and length-bound evaluators are word, path and count rows; its framework, feeling, remembering, voice and humour evaluators are `groups` rows (named groups of markers, the share found, groups found together in one line, a marker said again later, one word said three times); its weighted score and least score are row `weight` and the request's `min_score`; its non-gating outcomes are rows with `at_most`; its evidence evaluators are `evidence` rows. Every framework, word list, share, weight and least score is the person's DATA, handed in as rows; none is in the code.

## Files

| File | Purpose |
|------|---------|
| `do-work/judge-words.mjs` | The judge: compiles rule rows once, walks any JSON for the words a person reads or the values a path names, judges rows per item or `across` every item, returns machine-readable findings, a weighted score and plain-word lines. `judge` is the tool's whole answer. |
| `do-work/evidence-checks.mjs` | The evidence checks a row names with `evidence`: exact UTF-8 source and destination spans, complete per-block review, a captured answer set against its pinned identities and thresholds. Ported from the content gate's provenance evaluators. |
| `do-work/judge-against-rules.mjs` | `tool:judge-against-rules`: one JSON request on standard input, `{ result }` on the last line; a request that is not JSON or a row it cannot compile is refused with `{ error }`. |
| `part.json` | `do-work/judge-words.mjs` is public, so a check may import the same judge. |
| `tool-rows.json` | The Workshop row Trillion reads for this folder: `tool:judge-against-rules`. |
| `test/judge-words.test.mjs` | Kinds, path rows, every test, capped findings, owner paths. |
| `test/judge-against-rules-row.test.mjs` | The row's samples, run as the container runs them; refusals; evidence missing fails closed. |
| `test/scored-rows.test.mjs` | Weights, the score, `min_score`, capped rows (the content gate's engine tests). |
| `test/block-rows.test.mjs` | Blocks as items: offsets, scoped and normalized patterns, kinds forbidden or required, `includes_all`, `in_order`, lengths as counts (the content gate's standard evaluator tests). |
| `test/group-rows.test.mjs` | `groups` rows: share found, together, said again later, said three times, weights (the content gate's framework, feeling, remembering, voice and humour tests). |
| `test/evidence-rows.test.mjs` | Each evidence check, and a required reference field as a path row (the content gate's provenance tests). |
| `test/page-and-script-rows.test.mjs` | A whole page and a whole script judged by a person's rows (the content gate's page and script proofs). |
| `test/fixtures/made-up-rule-sets.json` | Five made-up rule sets of the shape a person hands in: a framework, feelings, remembering, voice cues, humour. |
| `test/fixtures/made-up-page-and-script.json` | A made-up sales page and video script with known counts and gaps, and their rows. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| Rule row | `{ id, says?, suggest?, words \| pattern(+flags) \| exact \| check \| groups \| path \| evidence, where?, where_pattern?, kinds?, when?, fields?, under?, allow?, normalize?, across?, weight?, required?, count_at_least?, count_at_most?, value_at_least?, value_at_most?, equals?, includes_all?, in_order?, repeated_at_least?, percent_found_at_least?, together_at_least?, because?, at_most? }` | One rule. Exactly one selector. Each test says what must hold; a row without a test flags every piece it selects. `count_*` counts what the row selects (word matches in a text, or values at a path after `where`). A value test, or `in_order`, that selects nothing is a finding (found `null`). `when` (one `{ path, where }` or a list) chooses the artifacts a row is for by a value they hold, such as a plan's format. `across: true` judges every item the row applies to together, once. |
| Group | `{ id, label?, words?, patterns?, weight?, apart_at_least? }` | One named group of a `groups` row: found when one of its markers is in the text; with `apart_at_least`, only when one marker is in two items that far apart (needs `across`). |
| Item | `{ text, field?, path?, kind? }` or `{ value, path?, kind? }`, or both | Text for word and group rows; any JSON for `path` and `evidence` rows. A block of a script is `{ text, kind, path: ['blocks', i], value: <the block> }`. |
| Finding | `{ rule, says, text?, found, path?, offset?, index?, kind?, test?, limit?, missing?, score?, suggest?, because?, at_most? }` | `path` is the concrete place (`segments.2.kind`); `offset` is where a word was found in its item's text; `index` is where in the evidence an evidence check stopped; `test` and `limit` name the test that did not hold; `missing` is the groups not found; `score` is the share a share test found. |
| `makeJudge` | `(rules) -> (items) -> findings` | Compiles rows once; a row it cannot compile throws with why. |
| `scoreOf` | `(rules, items, findings) -> number \| null` | The weighted score of the rows that apply: 100 for a row that found nothing, its share for a share test, else 0. |
| `ruleApplies` | `(rule, item) -> boolean` | Kinds, `when` over the item's `value`, what the item carries (a `path` or `evidence` row needs a `value`; a word row skips an item with a `value` and no `text`), `fields` and `under`. |
| `valuesAt` | `(value, path) -> [{ value, path }]` | Every JSON node a dot path selects (`*` one segment, `**` any depth). |
| `wordsIn` / `stringsIn` | `(value, owner) -> [{ text, field, path }]` | The words of any JSON, chosen by the owner's `fields`, `paths`, `skip_keys`, `skip_paths`. |
| `judge` | `(input) -> { passed, status, score, coverage, findings, lines, said }` | The tool's answer. `status`: `no-input`, `no-applicable-rule`, `failed` (an uncapped finding, or a score under `min_score`), `held` (every finding is from a row with `at_most`), `passed`. |
| `findingsInWords` | `(findings) -> [string]` | Where, what was found or which test did not hold, why, what to do instead. |
| `CHECK_NAMES` / `TEST_NAMES` / `SELECTOR_NAMES` / `NORMALIZE_NAMES` / `EVIDENCE_CHECK_NAMES` | `string[]` | The grammar checks, tests, selectors, normalizations and evidence checks a row may name. A caller that sorts rows (such as a rule document's test rows) reads `SELECTOR_NAMES` rather than keeping its own list. |

## Dependencies

**Depends on:** nothing (Node 24 in the tool container runs the scripts).

**Depended on by:** `tool-rows.json`; `tools/check-against-a-persons-rules-and-verdicts` (`makeJudge`, `ruleApplies`, `valuesAt`); a content check that imports `do-work/judge-words.mjs`.
