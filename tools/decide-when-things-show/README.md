# tools/decide-when-things-show/

A person's show rules, the presets (types) they keep, which presets are on, and who they share a preset with, as Workshop rows that a person, their AI and a wake all run. The rules are the person's own `show-rules` record (show-rules.json `record`). The open page follows that same record, so a change kept from any of them reaches the page through its one change notice.

- **Moved, not rewritten.** The rows run trillion `src/show-rules-store.mjs` (190f72754e) `makeShowRules`: `read`, `set` and `remove`, with its edit rules and its refusals in its own words. Its change function is `changedRecord` (`tools/set-up-my-account/read-data/show-rules.mjs`). The store and the account facts it imports (`src/work-for-ais.mjs` lines 74-122) are moved byte for byte, and only their imports change. The same goes for the controls list (`parts/ui/show/show-rules/declared-controls.mjs`) and the old AI tools (`src/show-rules-tools.mjs`). See `ports/show-rules-store.json`. Sharing follows a2e1365f33 (Account visibility), in its words (`show-rules.json` `sharing.words`).
- **The door reads; the person's write keeps.** Each row reads `show-rules` (and, to share, the grant it names) with `workspace:read`, one exact label each. A run's key may not write a workspace record, so a change answers `keep`: `[{ label, value, expected }]`, in order, with the value as read as `expected`. The page keeps it through its generic records write (`keepChange`), or a grant the person gives does. A record changed in the meantime is not written over. Nothing here keeps a second store.
- **Defaults are an overlay.** A shipped preset is read under the person's record and never written into it.
- **Nothing names a person, subject, control or type.** show-rules.json and the request say them.

## The rows

| Row | Function | Old trillion | What it answers |
|-----|----------|--------------|-----------------|
| `tool:see-when-things-show` | `seeWhenThingsShow` | `GET /show-rules` (`read`) | rules in force, subjects, edit authority, types (each with its `grant`), `in_use`, controls, moment facts, effects, quick, operators |
| `tool:keep-a-show-rule` | `keepAShowRule` | `POST /show-rules/set { rule } \| { starting }` | the rule kept, rules, `keep` |
| `tool:take-a-show-rule-away` | `takeAShowRuleAway` | `POST /show-rules/remove { id }` | rules, `keep` |
| `tool:keep-a-show-type` | `keepAShowType` | `POST /show-rules/set { type }` | types, `keep` |
| `tool:take-a-show-type-away` | `takeAShowTypeAway` | `POST /show-rules/set { remove_type }` | types, `keep` |
| `tool:switch-a-kept-show-type` | `switchAKeptShowType` | `POST /show-rules/set { use }` | `in_use`, `keep` |
| `tool:share-a-kept-show-type` | `shareAKeptShowType` | a2e1365f33 `share` | `key` (once), `keep`: the copy, then the grant |
| `tool:stop-sharing-a-show-type` | `stopSharingAShowType` | a2e1365f33 stop sharing | `keep`: the grant without that person |

The old `/show-rules/accounts` and `/show-rules/set { give }` have no rows, because no engine answers them (a2e1365f33). Their store code and tests come along unchanged.

## The wake

`tool:switch-a-kept-show-type` carries a wake, off until the person switches it on. When a `show-type-use` record (`{ type, on }`, one per type) is written, the run makes every switch those records ask for, in id order. So "when this happens, switch preset X on" is a recipe or wake that writes `show-type-use:X = { type: "X", on: true }`. The wake follows the engine's shape (`tools/workflows/recipe-wake-causes.json`). A wake's run can't write the workspace record either: its `keep` needs the person's write to be applied.

## Files

| File | Purpose |
|------|---------|
| `do-work/show-rules.mjs` | The eight functions, run by `tools/records-door/do-work/run-an-export.mjs`: reads through the door, runs the store, answers `keep` |
| `read-data/show-rules-store.mjs` | trillion `src/show-rules-store.mjs`, moved |
| `read-data/account-facts.mjs` | trillion `src/work-for-ais.mjs` lines 74-122, moved |
| `read-data/declared-controls.mjs`, `read-data/open-choices.json` | Every declared control, moved |
| `read-data/show-rules-tools.mjs` | The old AI tools' words, moved; the old edit-authority test reads them |
| `read-data/work-for-ais.json`, `read-data/record-sharing.json` | The account facts and the door grant's prefixes, moved |
| `tool-rows.json` | The eight Workshop rows |
| `ports/show-rules-store.json`, `ports/show-rules-door.json` | The port contracts |
| `test/show-rules-*.test.mjs`, `test/show-type*.test.mjs` | The five old trillion tests; only their paths changed |
| `test/show-rules.test.mjs` | Each row over made-up records against the records door stand-in |

## Dependencies

**Depends on:** `tools/set-up-my-account` (`read-data`), `tools/wall-time`, `tools/formula-engine`, `tools/run-experiments` (`score-candidates.ts`), the part manifests of `tools/arrange-screens-in-panes`, `tools/find-anything-from-one-box`, `tools/organize-the-sidebar/sidebar` and `tools/ui`, `tools/records-door`, `tools/content-identity`.
