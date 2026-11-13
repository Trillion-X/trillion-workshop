# tools/pour-example-rows-into-my-list/

The pour part of every Workshop item's kit (`tools/workflows/kit-template.json`, L082). A kit ships its lists with example rows; a person who already keeps a list that does 80-100% of the same job (a saved-replies list, a content calendar, a spreadsheet brought in as a list) should get the examples in that list, not a second list. This tool matches the kit list's fields to theirs and answers the one `records:write` that adds the example rows. It writes nothing itself and knows no list.

## Files

| File | Purpose |
|------|---------|
| `do-work/pour.mjs` | The tool: one JSON object on standard input, one JSON answer as the last line (exit 2 with `{ error }` on a refusal). `pour(input)` is exported for tests. |
| `tool-rows.json` | `tool:pour-example-rows-into-my-list`, its sample run and its own kit. |
| `part.json` | The public file the engine may run. |
| `test/pour.test.mjs` | The sample pour, a list under 80%, the map, label and choice rules, a second pour that changes nothing, refusals, and the tool's own kit. |

## Input

`{ kit_list, into, field_map?, least_coverage?, already_there? }`

- `kit_list`: one entry of an item's `kit.lists`: `{ list, fields: [{ id, label, alike? }], example_rows: [{ id, values }] }`.
- `into`: the person's list, as `records:read` on it gives it: `{ list: "list:...", row_type: "record:...", fields: [{ id, label, options? }] }`.
- `field_map`: `{ kit field id: their field id }`, or `null` to leave a kit field out. It wins over every other match.
- `least_coverage`: the least share of kit fields that must match, 0.8 to 1 (0.8 when not given).
- `already_there`: row ids the person's list already holds; those rows are left out.

A kit field matches, in this order: the map, the same id, the same label (case, spacing and a plural `s` ignored), a name in its `alike`. Each of the person's fields takes at most one kit field. A choice value their field does not offer is dropped and named (`not_an_option`), never guessed.

## Answer

`{ poured, coverage, matched: [{ kit_field, your_field, by }], unmatched, left_out, rows, write, says }`. `write` is `{ address: "@own-records", method: "records:write", input: { records } }`, ready for `run_resource_operation`; row ids are `<row_type>:kit-<example id>`, so a second pour of the same rows is left out.

## Run the tests

From the root of the Workshop checkout: `node --test tools/pour-example-rows-into-my-list/test/pour.test.mjs`.
