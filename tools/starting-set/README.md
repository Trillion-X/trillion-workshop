# tools/starting-set/

Trillion's defaults: what every account starts with, published by the default publisher with the deploy and never written into a person's store. A reader lays each default under the person's own record; what the person changed wins. Restored one to one from Trillion-X/trillion (tag `old-trillion-before-worker-retire`), where commit 4ffa1dc4a2 deleted them with no new home.

## Files

| File | Purpose | Old home |
|------|---------|----------|
| `shipped-defaults.json` | One `shipped-default` payload per record a default is laid under. The `show-rules` default holds the Simple workspace type, in use for every account until the person switches it off in their own record (`starting.simple-workspace.on: false`). | new (the show-rules default) |
| `records.json` | Trillion's own tools, workflows, rules and event rules as configurations: `components`, `configurations`, `core`, `pinned`. | `records/starting-set-records.json` |
| `groups.json` | Which configuration holds each shipped row and the words people read for it. | `records/starting-set-groups.json` |
| `starting-rules.json` | The rules and schedules every account has by itself (`every_account`) and one rule per connected event (`each_connected_event`). | `records/starting-rules.json` |
| `part.json` | Read by trillion-rust `src/runtime/workshop/shipped_defaults.rs` (`imported_by`). |  |
| `moved-from.json` | Where each file came from in Trillion-X/trillion. |  |
| `test/starting-set.test.mjs` | The rows' own checks, run by `npm test` at the top of the repository. | `test/starting-catalog.test.mjs` (the checks over the rows themselves) |
| `test/shipped-defaults.test.mjs` | The defaults as the reader reads them: one payload per record, the Simple workspace type byte for byte and in use, accepted by the show-rules store (`tools/set-up-my-account/read-data/show-rules.mjs` `changedRecord`), hiding the workspace chrome when given, naming no person, and equal to trillion-rust's test copy when that checkout is beside this one. | `test/marketplace-starting-defaults.test.mjs` (the defaults ship as data and are read, never written) |

## Invariants

1. A shipped default is never written into a person's store. An untouched default costs no row, and a changed default here reaches every account that never touched it at the next deploy (old `src/shipped-defaults.mjs` invariant 1).
2. The person's own value wins: a `by_id` entry of theirs with the same id replaces the shipped one, and a `switched` id they turned off stays off after every deploy (invariant 2).
3. Nothing here names a person: a type applies to whoever holds it.

## Who reads it

- `tools/decide-when-things-show/do-work/show-rules.mjs` (`laidUnder`, `takenOff`) lays the show-rules default under the person's record for every row, the same way, and keeps a switch of a shipped type as `starting.<id>.on`.
- trillion-rust `src/records/shipped_defaults.rs` lays the defaults under a record; `src/runtime/workshop/shipped_defaults.rs` reads this file from the account's installed Workshop; the show-rules read (`src/local_account/show_rules.rs`) applies them at every read.

## Gaps

- trillion-rust's rule reader (`src/rule_bindings/rules_and_runs/shipped_rules.rs`) now runs the `every_account` rules (one with `rule_id`) and reads the workflows they start from `tools/workflows/recipes/*.json` (`shipped_recipes.rs`), both beside the account's own rows and never written. Still without a reader: schedules (rows with `schedule_id`), `each_connected_event` rules, rules about a space's items, and the Marketplace catalog over `records.json` (`src/starting-catalog.mjs`, `src/share-starting-action.mjs`); until they land, those do not run.
- `records.json` was written by the old `scripts/build-starting-set.mjs` over the old repository's rows; that generator is not restored (it read files that no longer exist). Its versions are as of the tag.
