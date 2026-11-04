# tools/decide-when-things-show/

A person's show rules, the presets they keep, which of those are on, and who they share a preset with, as Workshop rows a person, their AI and a wake all run. The rules are the person's own `show-rules` record (show-rules.json `record`), the same record the open page follows, so a change kept from any of them reaches the page through its one change notice.

- **Moved, not rewritten.** Every change is `changedRecord` from trillion `src/workspace/show-rules.mjs`, already moved byte for byte as `tools/set-up-my-account/read-data/show-rules.mjs`; the refusals are its words, or `src/show-rules-store.mjs`'s. `do-work/show-rules.mjs` only reads the record through the door, hands it over, and answers what to keep (`ports/show-rules-door.json`). `show-rules-store.mjs` here is the store's raw copy; no row runs it, since its edit-authority layer imports `src/work-for-ais.mjs`, which no Workshop folder holds yet.
- **Read through the door, kept by the person's write.** Each row reads `show-rules` with `workspace:read` (one exact label). A run's key may not write a workspace record, so a change answers `keep`: `[{ label, value, expected }]`, with the record as it was read as `expected`. The page keeps it through its generic records write (`keepChange`), or a grant the person gives does; a record changed meanwhile is not written over. Nothing here keeps a second store.
- **Defaults are an overlay.** A shipped preset is read under the person's record and never written into it.
- **Nothing names a person, subject, control or type.** show-rules.json and the request say them.

## The rows

| Row | Function | Old trillion | What it answers |
|-----|----------|--------------|-----------------|
| `tool:see-when-things-show` | `seeWhenThingsShow` | `GET /show-rules` | rules in force, subjects, moment facts, effects, quick, operators, types, `in_use` |
| `tool:keep-a-show-rule` | `keepAShowRule` | `POST /show-rules/set { rule } \| { starting }` | the rule kept, rules, `keep` |
| `tool:take-a-show-rule-away` | `takeAShowRuleAway` | `POST /show-rules/remove { id }` | rules, `keep` |
| `tool:keep-a-show-type` | `keepAShowType` | `POST /show-rules/set { type }` | types, `keep` |
| `tool:take-a-show-type-away` | `takeAShowTypeAway` | `POST /show-rules/set { remove_type }` | types, `keep` |
| `tool:switch-a-kept-show-type` | `switchAKeptShowType` | `POST /show-rules/set { use }` | `in_use`, `keep` |
| `tool:share-a-kept-show-type` | `shareAKeptShowType` | a2e1365f33's two records | `keep`: `show-types-shared:<id>` and `sharing:<that label>` |
| `tool:stop-sharing-a-show-type` | `stopSharingAShowType` | a2e1365f33 | `keep`: both records removed |

The old `/show-rules/accounts` and `/show-rules/set { give }` are not carried: no engine answers them (a2e1365f33).

## The wake

`tool:switch-a-kept-show-type` carries a wake, off until the person switches it on: when a `show-type-use` record is written (`{ type, on }`, one per type), the run makes every switch those records ask for. So "when this happens, switch preset X on" is a recipe or wake that writes `show-type-use:X = { type: "X", on: true }`. The wake's shape is the engine's (`tools/workflows/recipe-wake-causes.json`).

## Files

| File | Purpose |
|------|---------|
| `do-work/show-rules.mjs` | The eight functions, run by `tools/records-door/do-work/run-an-export.mjs` |
| `show-rules-store.mjs` | trillion `src/show-rules-store.mjs`, raw; no row runs it |
| `tool-rows.json` | The eight Workshop rows |
| `ports/show-rules-door.json` | The port contract, naming the old paths and lines |
| `part.json` | The public module |
| `test/show-rules.test.mjs` | Each row over a made-up record against the records door stand-in |

## Dependencies

**Depends on:** `tools/set-up-my-account` (`read-data/show-rules.mjs` and `show-rules.json`), `tools/wall-time`, `tools/formula-engine` (`rules/rule-operators.json`), `tools/records-door`, `tools/content-identity`.
