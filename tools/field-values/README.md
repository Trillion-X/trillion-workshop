# tools/field-values/

Works out the value each field of a row holds, the way bookkeeping, spend and CRM tables do: rules that set fields on the rows they match (coding transactions by merchant and amount), a column filled row by row by asking the person's sources in their order until one answer passes their check (an enrichment waterfall), and, when several sources offered a value for one field, which one the field keeps and who set it (what a person typed beats their rules, their rules beat imported sources, those beat an AI's guess). Nothing is written and nothing is fetched: rows, rules, sources and offers arrive in the request, and the answer holds the changes, the rows as they would be and the provenance to keep beside each value, for the list's owner to write.

The three tools share one precedence (`do-work/precedence.mjs` over `read-data/value-sources.json`, or the person's own `precedence` of that shape): source kinds strongest first, how ties inside a kind break (newest, then most confident, then the order handed in), what a value of unknown source does (holds by default, so nothing replaces a value nobody recorded the writer of), a confidence floor per kind (an AI value below 0.5 never wins by default), and words a source may give for its confidence. Rule trees are tools/formulas' own: a rule's `when`, a fill's `run_if` and its `accept` check are matched by that folder's `filterRecords`, so every comparison it offers works here and an unfinished rule is never guessed at.

Taken from what bookkeeping, spend-management and CRM products were seen to do (public reverse-engineering findings on rule engines that write fields, provenance per cell, and waterfalls that stop at the first valid answer); no code of theirs was read or copied. Not carried: their fixed rule kinds (pivot rules, approval matrices) as separate engines, because a rule group of `when` and `set` already covers them; any per-product field names; and the scheduling of fills when rows change, which belongs to whatever runs the person's automations.

## Files

| File | Purpose |
|------|---------|
| `read-data/value-sources.json` | The default precedence: source kinds strongest first, tie breaks, unknown sources, confidence floors and words |
| `do-work/precedence.mjs` | The one precedence: rank of a kind, confidence of a source, floors, the comparison of two offers and why one lost |
| `do-work/row-paths.mjs` | Reading and writing one place in a row by a path, emptiness and sameness of values |
| `do-work/set-fields-by-rules.mjs` | Ordered rule groups over rows: changes, held fields, shadowed rules, rows as they would be, a preview per rule |
| `do-work/settle-field-values.mjs` | Offers per field: the winner with its source, every other offer and why it lost, withdrawals, as_of |
| `do-work/plan-a-column-fill.mjs` | The waterfall: next calls with request keys, values found as offers, rows skipped or out of sources |
| `do-work/requests.mjs` | One function per row: checks the request, refuses with a sentence, calls the above |
| `do-work/run-request.mjs` | `node do-work/run-request.mjs <function>`: the request on standard input, `{ result }` or `{ error }` out |
| `part.json` | The one public module |
| `tool-rows.json` | The three Workshop rows |
| `test/*.test.mjs` | Rules setting fields over a person's values, provenance and undo; precedence, floors, withdrawals and as_of; the waterfall's order, checks, keys and stops; each row's sample run in the container |

## The rows

| Row | Does |
|-----|------|
| `tool:set-fields-by-rules` | Rows, fields and rule groups in; the changes, the fields a stronger source holds, shadowed rules, each changed row and per rule what it matches and would change out |
| `tool:settle-field-values` | Offers (value and source per field of a row) in; the value each field keeps, who set it, every other offer and why it lost out |
| `tool:plan-a-column-fill` | Rows, the column, sources in order, a check and the attempts made so far in; the next calls, the values found as offers, and the rows skipped or out of sources out |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| offer | `{ row, field, value, source: { kind, by?, at?, confidence? }, basis?, withdraws? }` | One value offered for one field of one row; `basis` (reasoning, citations) rides with the value if it wins |
| precedence | `{ kinds: [{ id, says, confidence_at_least? }], same_kind_order, unknown_source, confidence_words }` | Who wins; strongest kind first |
| rule | `{ id, says?, when?, set: [{ field, value } \| { field, from }] }` | `when` is a tools/formulas rule tree; no `when` matches every row |
| provenance | `{ path, kind_key, by_key }` | Where each row keeps who wrote each field, e.g. `{ path: ["_stamps"], kind_key: "class", by_key: "by" }` |
| source (fill) | `{ id, tool, input: { name: { from } \| { value } }, answer_path?, kind?, cost? }` | One place to ask, in order |
| `precedenceOf(request)` | `-> { rankOf, confidenceOf, belowFloor, compare, whyLost, tied, mayReplace, kinds }` | The one precedence every tool asks |
| `setFieldsByRules(request)` | `-> { total, changes, held, shadowed, rows, rules, incomplete }` | Checked by `setFields` |
| `settleFieldValues(request)` | `-> { cells, counts }` | Checked by `settleValues` |
| `planAColumnFill(request)` | `-> { calls, filled, skipped, exhausted, waiting, done, cost }` | Checked by `planColumnFill` |

## Dependencies

**Depends on:** `tools/formulas` (`do-work/requests.mjs` `filterRecords`: every rule tree), `tools/content-identity` (`canonicalJson`, `makeHashCodeHexFromJson`: sameness of values and each call's request key) and its `@noble/hashes` module; every row packs all three. No records access, no credential and no network (`internet: false`): the rows, rules, sources, answers and times all come in the request.

**Depended on by:** nothing yet; a list's owner writes the answers, and an AI runs the planned calls through `tools:run` with the request keys given.
