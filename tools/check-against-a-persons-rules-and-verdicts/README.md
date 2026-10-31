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
| `part.json` | `do-work/rules-and-verdicts.mjs` is public. |
| `tool-rows.json` | The two rows. Each packs `tools/judge-words` (`do-work`), `tools/where-a-person-stands` (the one identity of a judged thing) and `@noble/hashes`. |
| `test/rules-and-verdicts.test.mjs` | Every rule of the order above, on made-up rules, lines and stands. |
| `test/rows.test.mjs` | Each row's sample, run as the container runs it; refusals; a question answered by id on a second run. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| Unit | `{ text, kind, field?, path?, facts?, context?, context_requires_review?, also_found?, where? }` or `{ view, kind, ... }` | One thing to check. `facts` is what a row's `when` and `held_when` read. `also_found` are findings the caller already has (each `outcome: fail` or `uncertain`). |
| Rule document | `{ rows, fold, stage: { default }, stance_rule, novel: { rule, says }, agree_clears: { rules } }` | The person's own rules. `fold` is how two texts are one text (`tools/where-a-person-stands` `foldWith`). |
| Stand | `{ kind, artifact, text? \| contains? \| view?, stance, why, at }` | As `tool:read-where-you-stand` gives it. `stance: null` is no stand. |
| Result | `{ ...unit, verdict, breaks, uncertain, advisory, qualification, applicable_rule_ids }` | `advisory` is true when only unqualified model rows or `held_when` rows found something. |
| Question | `{ id, rule, question, options, fail, text, context? }` | One sentence a model row asks about. |
| `check` | `(units, rules, { answers, stands, verdictRules, stage, fieldsByKind, asOf }) -> { results, questions }` | The whole check. |
| `examplesFromStands` | `(compiled, stands) -> { items, rows }` | Good and bad examples for the reading rows. |

## Dependencies

**Depends on:** `tools/judge-words` (`makeJudge`, `ruleApplies`, `valuesAt`), `tools/where-a-person-stands` (`artifactRef`, `foldWith`), `@noble/hashes`, Node 24 in the tool container.

**Depended on by:** `tool-rows.json`; a content check that imports `do-work/rules-and-verdicts.mjs`.
