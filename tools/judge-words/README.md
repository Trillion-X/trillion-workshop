# tools/judge-words/

Judges words a person will read, and any JSON a person makes (a plan, a take's measures, a report), against rule rows the caller hands in, and says which rows each one breaks, with why and what to do instead. One row shape serves every kind of thing checked: a kind is a word in the row's `kinds`, never code. Ported from the copy judge `parts/judge-words`; the selectors, grammar checks and owner paths are unchanged, and rows gain `kinds`, value `path` with `where`, tests that say what must hold, and `because` and `at_most` carried onto every finding.

## Files

| File | Purpose |
|------|---------|
| `do-work/judge-words.mjs` | The judge: compiles rule rows once, walks any JSON for the words a person reads or the values a path names, returns machine-readable findings and plain-word lines. `judge` is the tool's whole answer. |
| `do-work/judge-against-rules.mjs` | `tool:judge-against-rules`: one JSON request on standard input, `{ result }` on the last line; a row it cannot compile is refused with `{ error }`. |
| `part.json` | `do-work/judge-words.mjs` is public, so a check may import the same judge. |
| `tool-rows.json` | The Workshop row Trillion reads for this folder: `tool:judge-against-rules`. |
| `test/judge-words.test.mjs` | Kinds, path rows, every test, capped findings, owner paths. |
| `test/judge-against-rules-row.test.mjs` | The row's sample, run as the container runs it. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| Rule row | `{ id, says?, suggest?, words \| pattern(+flags) \| exact \| check \| path, where?, kinds?, fields?, under?, allow?, required?, count_at_least?, count_at_most?, value_at_least?, value_at_most?, equals?, because?, at_most? }` | One rule. Exactly one selector. Each test says what must hold; a row without a test flags every piece it selects. `count_*` counts what the row selects (word matches in a text, or values at a path after `where`). A value test that selects nothing is a finding (found `null`). |
| Item | `{ text, field?, path?, kind? }` or `{ value, path?, kind? }` | Text for word rows; any JSON for `path` rows. |
| Finding | `{ rule, says, text?, found, path?, kind?, test?, limit?, suggest?, because?, at_most? }` | `path` is the concrete place (`segments.2.kind`); `test` and `limit` name the test that did not hold; `found` is the count for count and `required` tests. |
| `makeJudge` | `(rules) -> (items) -> findings` | Compiles rows once; a row it cannot compile throws with why. |
| `ruleApplies` | `(rule, item) -> boolean` | Kinds, what the item carries (a `path` row needs a `value`; a word row skips an item with a `value` and no `text`), `fields` and `under`. |
| `valuesAt` | `(value, path) -> [{ value, path }]` | Every JSON node a dot path selects (`*` one segment, `**` any depth). |
| `wordsIn` / `stringsIn` | `(value, owner) -> [{ text, field, path }]` | The words of any JSON, chosen by the owner's `fields`, `paths`, `skip_keys`, `skip_paths`. |
| `judge` | `(input) -> { passed, status, coverage, findings, lines, said }` | The tool's answer. `status`: `no-input`, `no-applicable-rule`, `failed`, `held` (every finding is from a row with `at_most`), `passed`. |
| `findingsInWords` | `(findings) -> [string]` | Where, what was found or which test did not hold, why, what to do instead. |
| `CHECK_NAMES` / `TEST_NAMES` | `string[]` | The grammar checks and tests a row may name. |

## Dependencies

**Depends on:** nothing (Node 24 in the tool container runs the scripts).

**Depended on by:** `tool-rows.json`, a content check that imports `do-work/judge-words.mjs`.
