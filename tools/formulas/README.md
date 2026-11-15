# tools/formulas/

Keeps the rows of a list that match a person's rules, evaluates a formula over rows, and gives a record the label of the first of a person's rules that holds. A rule is a comparison a person picks for a field ("is any of", "has all of", "contains", "is more than", "is between", "is empty", "is known" and more), and rules join in all-of and any-of groups that can be negated and nested. The tool names no field, value or word: the records, the fields (an id, a kind and a path into each record), the rule tree and, if wanted, the comparisons themselves all arrive in the request.

Logic has three states, and only a true answer keeps a row. A value that is unknown (missing, null) has no answer to a comparison that has to look at it (contains, starts with, more than, less than, between, after, before, has any of and the like), and NOT of unknown stays unknown, so such a row matches neither the comparison nor its negation (does not contain, has none of). Two comparisons treat an unknown value as a value like any other: `is any of` / `is none of` ask whether it is in the list and `is` / `is not` whether it equals the word. An unknown value is not in the list and not equal to the word, so `is none of` and `is not` keep it. This is what the engine operators the package ran (`in_list`, `eq`) answer. A rule that is not finished (an unknown field or comparison, a comparison the field's kind does not offer, missing values) is left out and returned in `incomplete`, never guessed. A group whose combinator is not in the vocabulary is refused with a sentence naming the ones that are. A tree with no finished rule keeps every row. A row whose value is of the wrong kind for a comparison is counted in `error_rows` and left out; a binding that errors anywhere inside it, a nested argument included, is an error for that row.

A comparison is a row of data in the formula engine's `tools/formula-engine/rules/rule-operators.json`: an id, what it takes, the field kinds that offer it and a binding template over the engine's operators. Adding a comparison is one row there, no code. Send `operators` in a request to use a person's own rows instead; their combinators join with the engine's own (`op:core.and`, `op:core.or`).

This tool keeps no evaluator of its own. `do-work/requests.mjs` compiles a rule tree with the formula engine's compiler (`tools/formula-engine/rules/compile-rules.mjs`) and the formula engine decides every row and every formula: the evaluator built from trillion-rust `crates/ops-core` to WebAssembly (`tools/formula-engine/built-stored-bytes/evaluate-over-rows`, loaded by `rules/evaluate-over-rows.mjs` the first time a rule or formula is asked). Until 2026-11-14 this folder held its own copy of that compiler, of the comparison rows and a JavaScript re-implementation of nineteen engine operators; they were deleted so one engine answers every rule. Each row packs `tools/formula-engine` (`rules`, `built-stored-bytes`) beside this folder. A run keeps nothing between requests, so the package's bit-set index for tag and choice picks is not carried: one built per request would cost more than it saves. The slot's classifier (`classify_by_rules`: facts read from a record, rules in order, the first that holds gives its label) is a generic rule-to-label step of about a hundred lines and is carried as `tool:classify-a-record`; its default tone word is not (a tone or severity is returned as given, or null).

Not carried: the formula engine's human formula language (the text-to-binding lexer, parser and human formula writer of the formula crates), its reactive and dependency-graph evaluation, the engine's slot wrapper, the stored measure and formula records, and the builder screen that drew the rule tree. A binding may use any operator the engine registers (arithmetic, rounding, dates and the rest of the operator library included); one it does not register is refused with the engine's words, `operator not registered: <op>`.

## The `like` comparison

`like` is offered by fields of kind `meaning`. The tool compares no meaning itself: the field holds a list the caller already worked out for each record (for example the words or ideas a meaning search found it close to), and `like` keeps the rows whose list holds the given text exactly (lower-cased on both sides). A record with no list is unknown and is left out.

## Operators a formula uses

The engine's operators (trillion-rust `crates/ops-core`), among them `op:core.and`, `or`, `not`, `is_null`, `is_empty`, `eq`, `gt`, `ge`, `lt`, `le`, `in_list`, `index_of`, `lower`, `contains`, `starts_with`, `join`, and three that build a value from a row's fields: `coalesce` (the first of `values` that is not unknown), `if` (the value received must be true or false, else it is an error; answers `then` or `else`) and `text_concat` (the text `values` one after another, unknown ones skipped, any other kind an error). A nested binding in an argument is evaluated over the value the step receives, so a value built from several fields selects the row once and reads each field in its own argument binding.

## Files

| File | Purpose |
|------|---------|
| `do-work/classify-by-rules.mjs` | The classifier: project facts out of a record, run the rules in order, answer the first that holds; refuses an unfinished request |
| `do-work/requests.mjs` | One function per row: checks the request, refuses with a sentence, compiles with the formula engine and asks it, or calls the classifier or the history code |
| `do-work/run-request.mjs` | `node do-work/run-request.mjs <function>`: the request on standard input, `{ result }` or `{ error }` out |
| `read-data/list-value-history.mjs` | A field's values over time: `keepValueHistory` adds the step a write took, `historyValues` works out value_at, previous_value, value_set_at, time_spent_in and has_been_in from the kept steps as intervals, `fieldHistoryOf` says them as lines; moved unchanged from old trillion `src/list-value-history.mjs` |
| `read-data/write-via.mjs`, `read-data/write-via.json` | The road a write came by (`viaOf`) and the plain words for it (`viaWords`); moved unchanged from old trillion `src/write-via.mjs` |
| `read-data/lists.json`, `read-data/list-refusals.mjs` | The slices of old trillion `src/lists.json` the history code reads (the history field kind, `value_history`, its refusal words), and `listSay` without the old app's configuration-error branch |
| `part.json` | The public modules |
| `tool-rows.json` | The six Workshop rows |
| `test/*.test.mjs` | Rule trees, the formula engine's three-state logic, errors and path safety as these rows run it, the classifier, and each row's sample run in the container with the formula engine packed beside it |

## The rows

| Row | Does |
|-----|------|
| `tool:filter-rows-by-rules` | Records, fields and a rule tree in; the matching positions and records, the fields read, unfinished rules and error rows out |
| `tool:evaluate-a-formula` | A binding and rows in; one value per row and the rows that errored out |
| `tool:list-comparisons` | The comparisons and combinators on offer, for one field kind or all |
| `tool:classify-a-record` | A record, facts and rules in order in; the first rule that holds (key, label, tone, severity) out, or none |
| `tool:work-out-history-values` | A row's kept history and history fields in; the value at a moment, the one before, since when, time spent in a value and whether it ever held one out (null when the history needed was not kept) |
| `tool:read-a-fields-history` | One field's kept history in; each value it held, from when until when, and who changed it by which road, in plain words |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| rule tree | `{ kind: "group", combinator, negate, rules }` or `{ kind: "rule", field, operator, params }` | What a person picked; params by the comparison's `input`: `values`, `value`, `text`, `min`/`max`, none |
| field | `{ id, kind, path? }` | `kind` selects the comparisons (`applies_to`); `path` is keys and positions into a record, the id by default |
| `ruleVocabulary(operatorData)` | `-> { operators, combinators, operatorsFor(kind), firstCombinator }` | Lookups over the comparison rows |
| `compileRules(tree, { fields, vocabulary })` | `-> { binding \| null, reads, incomplete }` | Fills templates into one binding; null binding means every row; throws for an unknown combinator |
| `filterRows(rows, binding)` | `-> { matches, errorRows, firstError }` | Positions of the rows the binding holds for |
| `evaluateBinding(binding, input)` | `-> { value, error }` | One binding over one value, in three-state logic |
| `classifyByRules(request)` | `{ facts, rules, record, now_ms? } -> { result: { key, label, tone, severity } \| null }` | The first rule whose clauses all hold |

## Dependencies

None outside the folder: plain JavaScript run by Node, no packages. The records, fields, rules, bindings and the clock (`now_ms`) all come in the request, so the tool holds no records access, no credential and no network (`internet: false` on every row).
