# tools/formulas/

Keeps the rows of a list that match a person's rules, evaluates a formula over rows, and gives a record the label of the first of a person's rules that holds. A rule is a comparison a person picks for a field ("is any of", "has all of", "contains", "is more than", "is between", "is empty", "is known" and more), and rules join in all-of and any-of groups that can be negated and nested. The tool names no field, value or word: the records, the fields (an id, a kind and a path into each record), the rule tree and, if wanted, the comparisons themselves all arrive in the request.

Logic has three states, and only a true answer keeps a row. A value that is unknown (missing, null) has no answer to a comparison that has to look at it (contains, starts with, more than, less than, between, after, before, has any of and the like), and NOT of unknown stays unknown, so such a row matches neither the comparison nor its negation (does not contain, has none of). Two comparisons treat an unknown value as a value like any other: `is any of` / `is none of` ask whether it is in the list and `is` / `is not` whether it equals the word. An unknown value is not in the list and not equal to the word, so `is none of` and `is not` keep it. This is what the engine operators the package ran (`in_list`, `eq`) answer. A rule that is not finished (an unknown field or comparison, a comparison the field's kind does not offer, missing values) is left out and returned in `incomplete`, never guessed. A group whose combinator is not in the vocabulary is refused with a sentence naming the ones that are. A tree with no finished rule keeps every row. A row whose value is of the wrong kind for a comparison is counted in `error_rows` and left out.

A comparison is a row of data in `read-data/rule-operators.json`: an id, what it takes, the field kinds that offer it and a binding template over the operators the evaluator runs. Adding a comparison is one row, no code. Send `operators` in a request to use a person's own rows instead.

This is taken from the formula engine package's rule filtering: its comparison rows, rule compiler and the semantics of its row evaluator. The package ran its evaluator as a compiled module of the engine's general operator library, and kept a bit-set index beside it to answer tag and choice picks over a list held in memory. Neither is carried: here the evaluator runs the sixteen operators the comparisons use (below) and a run keeps nothing between requests, so an index built per request would cost more than it saves. The slot's classifier (`classify_by_rules`: facts read from a record, rules in order, the first that holds gives its label) is a generic rule-to-label step of about a hundred lines and is carried as `tool:classify-a-record`; its default tone word is not (a tone or severity is returned as given, or null).

Not carried: the formula engine's human formula language (the text-to-binding lexer, parser and human formula writer of the formula crates), its arithmetic and other operators beyond the sixteen below (add, subtract, multiply, divide, rounding, dates, text building and the rest of the operator library), its reactive and dependency-graph evaluation, the engine's slot wrapper, the stored measure and formula records, and the builder screen that drew the rule tree. A binding that names an operator outside the sixteen is refused with its name; a person who needs arithmetic over rows uses the measures of `evaluate-progress`.

## The `like` comparison

`like` is offered by fields of kind `meaning`. The tool compares no meaning itself: the field holds a list the caller already worked out for each record (for example the words or ideas a meaning search found it close to), and `like` keeps the rows whose list holds the given text exactly (lower-cased on both sides). A record with no list is unknown and is left out.

## Operators the evaluator runs

`op:core.and`, `or`, `not`, `is_null`, `is_empty`, `eq`, `gt`, `ge`, `lt`, `le`, `in_list`, `index_of`, `lower`, `contains`, `starts_with`, `join`. A binding naming another operator is refused with its name.

## Files

| File | Purpose |
|------|---------|
| `read-data/rule-operators.json` | Every comparison and group combinator as data |
| `do-work/compile-rules.mjs` | Rule tree to one binding by filling templates; reports unfinished rules |
| `do-work/evaluate-binding.mjs` | The binding evaluator: select from the row (or a literal), run the operator pipeline in three-state logic, filter rows |
| `do-work/classify-by-rules.mjs` | The classifier: project facts out of a record, run the rules in order, answer the first that holds; refuses an unfinished request |
| `do-work/requests.mjs` | One function per row: checks the request, refuses with a sentence, calls the above |
| `do-work/run-request.mjs` | `node do-work/run-request.mjs <function>`: the request on standard input, `{ result }` or `{ error }` out |
| `part.json` | The one public module |
| `tool-rows.json` | The four Workshop rows |
| `test/*.test.mjs` | Rule trees, the evaluator's three-state logic, errors and path safety, the classifier, and each row's sample run in the container |

## The rows

| Row | Does |
|-----|------|
| `tool:filter-rows-by-rules` | Records, fields and a rule tree in; the matching positions and records, the fields read, unfinished rules and error rows out |
| `tool:evaluate-a-formula` | A binding and rows in; one value per row and the rows that errored out |
| `tool:list-comparisons` | The comparisons and combinators on offer, for one field kind or all |
| `tool:classify-a-record` | A record, facts and rules in order in; the first rule that holds (key, label, tone, severity) out, or none |

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
