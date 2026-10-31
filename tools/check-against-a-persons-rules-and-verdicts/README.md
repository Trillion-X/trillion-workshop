# tools/check-against-a-persons-rules-and-verdicts/

Checks words, or anything else made for a person (a title, a script line, a plan as JSON), against that person's own rules and the verdicts they already gave, and says pass, fail or uncertain for each thing, with every finding and why. Nothing about any person is built in: their rule rows, their rule document and their stands are input, read at run time from their records or their files.

What decides, in order:

1. **Their exact stand on the thing** (from `tool:read-where-you-stand`): disagree fails it, partly holds it at review and fails it at final, agree passes it and clears the generic rules their document names in `agree_clears`, unless a row is newer than the stand. A stand on a part (`contains`) decides every thing holding that part. A reworded thing gets no verdict from a stand on the original.
2. **Their rows for the thing's kind**: a stated row fails; an inferred row (`at_most: "uncertain"`) only holds; a `required` inferred row that finds nothing holds at review and fails at final. A row whose `because` names stands takes its strength from the newest of them, and only holds once all of them are taken back. A `part` row gives a thing the stand on a part of it (a take gets its voice's).
3. **Reading rows and ask rows** (a question a model answers): asked only once the row's calibration is `usable`; a capped row never fails. The tool never calls a model: it lists the questions by id, and the caller sends the answers back.
4. **Generic rule rows** (`rules`), judged by `tools/judge-words`. A row's `held_when` (over a unit's `facts`) makes its finding only hold on those units.

Nothing passes on silence: a thing no rule applies to is unqualified, and a thing nothing of the person's judges is novel (held at review, failed at final).

## Run it

```
jq -n --slurpfile rules <rule rows>.json --slurpfile doc <rule document>.json --slurpfile stands <stands>.json \
  --slurpfile units <units>.json '{rules: $rules[0], verdict_rules: $doc[0], stands: $stands[0], units: $units[0], stage: "review"}' \
  | node tools/check-against-a-persons-rules-and-verdicts/do-work/check-against-their-rules-and-verdicts.mjs
```

The last line is `{ "result": { status, passed, results, questions, lines } }`. To use a model's answers, send the same request again with `answers: { "<question id>": { "<option>": <probability> } }`.

## Files

| File | Purpose |
|------|---------|
| `do-work/rules-and-verdicts.mjs` | The check: `compileVerdictRules`, `governing`, `verdictFindings`, `check`, `statusOf`, `linesOf`, `examplesFromStands`. Its header holds the invariants. |
| `do-work/check-against-their-rules-and-verdicts.mjs` | `tool:check-against-a-persons-rules-and-verdicts`: one JSON request on standard input, `{ result }` or `{ error }` on the last line. |
| `do-work/examples-from-where-they-stand.mjs` | `tool:make-examples-from-where-a-person-stands`: the person's stands as good and bad examples for their reading rows. |
| `read-data/words.json` | Every word the tool says: its own finding ids, the words of each finding, the refusals. |
| `do-work/check-copy.mjs` | `tool:check-copy`: the words of a site, a page, JSON, a deck or a picture reading, and the whole set, checked in one call. Reads units (`do-work/read-words.mjs`), hands them to the checker above, and adds the checks on the whole set that no unit can show: a locked line or promised feature gone (with the approval rule), an id gone from the baseline, a row for the wrong audience, an offer listing fewer lines than the others, a count that is not a published list view, a picture with no recorded reading. Exit 0 passed, 1 failed or a problem, 3 held. |
| `do-work/check-copy-words.mjs` | The container entry for `tool:check-copy`: one JSON request on standard input, `{ result }` or `{ error }` on the last line. |
| `do-work/read-words.mjs` | The unit readers: prose strings of any JSON, the visible lines of an HTML page and its JSON-LD, the `slide-words` block of a rendered deck, and Markdown headings, paragraphs, lists, table cells and fenced display text. It retains each block's role and mapped field; unresolved Markdown quotes and unsupported blocks become coverage problems. One unit per distinct content and judging context. Reads no file. |
| `read-data/copy-grammar-rules.json` | The only rows kept for `tool:check-copy`: mechanical grammar, used when the caller sends no rules. No word list, no product, no person. |
| `read-data/copy-words.json` | Every sentence `tool:check-copy` says that is not a rule's own: its refusals, problems and required-line wording. |
| `test/check-copy.test.mjs` | `tool:check-copy` on made-up rules, lines, pages, decks and picture readings. |
| `part.json` | `do-work/rules-and-verdicts.mjs` is public. |
| `tool-rows.json` | The two rows. Each packs `tools/judge-words` (`do-work`), `tools/where-a-person-stands` (the one identity of a judged thing) and `@noble/hashes`. |
| `test/rules-and-verdicts.test.mjs` | Every rule of the order above, on made-up rules, lines and stands. |
| `test/rows.test.mjs` | Each row's sample, run as the container runs it; refusals; a question answered by id on a second run. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| Unit | `{ text, kind, field?, path?, facts?, context?, context_requires_review?, context_requires_review_rules?, context_requires_review_checks?, also_found?, where? }` or `{ view, kind, ... }` | One thing to check. `facts` is what a row's `when` and `held_when` read. Context review can be all findings, selected rule ids, or selected grammar checks; only listed findings become uncertain and the other findings remain in force. `also_found` are findings the caller already has (each `outcome: fail` or `uncertain`). |
| Rule document | `{ rows, fold, stage: { default }, stance_rule, novel: { rule, says }, agree_clears: { rules } }` | The person's own rules. `fold` is how two texts are one text (`tools/where-a-person-stands` `foldWith`). |
| Stand | `{ kind, artifact, text? \| contains? \| view?, stance, why, at }` | As `tool:read-where-you-stand` gives it. `stance: null` is no stand. |
| Result | `{ ...unit, verdict, breaks, uncertain, advisory, qualification, applicable_rule_ids }` | `advisory` is true when only unqualified model rows or `held_when` rows found something. |
| Question | `{ id, rule, question, options, fail, text, context? }` | One sentence a model row asks about. |
| `check` | `(units, rules, { answers, stands, verdictRules, stage, fieldsByKind, asOf }) -> { results, questions }` | The whole check. |
| `examplesFromStands` | `(compiled, stands) -> { items, rows }` | Good and bad examples for the reading rows. |

## Dependencies

**Depends on:** `tools/judge-words` (`makeJudge`, `ruleApplies`, `valuesAt`), `tools/where-a-person-stands` (`artifactRef`, `foldWith`), `@noble/hashes`, Node 24 in the tool container.

**Depended on by:** `tool-rows.json`; a content check that imports `do-work/rules-and-verdicts.mjs`.
