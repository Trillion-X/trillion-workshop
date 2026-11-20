# tools/decide-when-things-show/

A person's show rules, the presets (types) they keep, which presets are on, and who they share a preset with, as Workshop rows that a person and their AI run. The rules are the person's own `show-rules` record (show-rules.json `record`). The open page follows that same record, so a change kept from any of them reaches the page through its one change notice.

- **Moved, not rewritten.** The rows run trillion `src/show-rules-store.mjs` (190f72754e) `makeShowRules`: `read`, `set` and `remove`, with its edit rules and its refusals in its own words. Its change function is `changedRecord` (`tools/set-up-my-account/read-data/show-rules.mjs`). The store and the account facts it imports (`src/work-for-ais.mjs` lines 74-122) are moved byte for byte, and only their imports change. The same goes for the controls list (`tools/ui/show/show-rules/declared-controls.mjs`) and the old AI tools (`src/show-rules-tools.mjs`). See `ports/show-rules-store.json`. Sharing follows a2e1365f33 (Account visibility), in its words (`show-rules.json` `sharing.words`).
- **The caller reads; the person's write keeps.** Each row takes the rows it reads as its `records` input, handed in by the caller from where the person keeps them: `show-rules` (and, to share, the grant it names), one exact label each. No row reaches a door. A run's key may not write a workspace record, so a change answers `keep`: `[{ label, value, expected }]`, in order, with the value as read as `expected`. The page keeps it through its generic records write (`keepChange`), or a grant the person gives does. A record changed in the meantime is not written over. Nothing here keeps a second store.
- **Defaults are an overlay.** A shipped preset is read under the person's record and never written into it. The shipped presets are `tools/starting-set/shipped-defaults.json` (the Simple workspace, in use for every account). The rows lay that default under the record the way trillion-rust `src/records/shipped_defaults.rs` does (`laidUnder`), so `see-when-things-show` lists the Simple workspace (`shipped: true`) and in use, and `switch-a-kept-show-type` switches it like a kept type. Before answering `keep` they take it back off (`takenOff`): a shipped type the person did not change is not written, and its switch is kept as the person's `starting.<id>.on` (false when off; left out when back on), where the engine reads it. A shipped type cannot be taken away, only switched off; changing one keeps the person's own copy, and taking that copy away gives the shipped one back, switched as the copy was. Shipped types can be shared like kept ones.
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

## No wake

`tool:switch-a-kept-show-type` takes the switch as its request (`use: { type, on }`) and reads no record but the person's show-rules setting. It keeps nothing: the answer holds `keep`, the record for the person's own write. "When this happens, switch preset X on" is a recipe step that calls the tool with `use`.

## Files

| File | Purpose |
|------|---------|
| `do-work/show-rules.mjs` | The eight functions, run by `tools/workflows/do-work/run-a-function.mjs` (the shared runner): take `records`, run the store, answer `keep` |
| `read-data/show-rules-store.mjs` | trillion `src/show-rules-store.mjs`, moved |
| `read-data/account-facts.mjs` | trillion `src/work-for-ais.mjs` lines 74-122, moved |
| `read-data/declared-controls.mjs`, `read-data/open-choices.json` | Every declared control, moved |
| `read-data/show-rules-tools.mjs` | The old AI tools' words, moved; the old edit-authority test reads them |
| `read-data/work-for-ais.json`, `read-data/record-sharing.json` | The account facts and the grant's prefixes, moved |
| `read-data/controls.json`, `read-data/service-records.json` | Moved byte for byte from trillion-rust `product/controls.json` and `product/service-records.json` when the engine's product/ folder was deleted: the controls each part draws (by part, the rows trillion-rust `src/local_account/show_rules.rs` `controls` reads with `open-choices.json`) and the operator records every account reads (labels, prefixes, `read_seconds`). The engine reads these, and `open-choices.json`, `work-for-ais.json`, `set-up-my-account/read-data/show-rules.json`, `set-up-my-account/read-data/setup-steps.json` and `formula-engine/rules/rule-operators.json`, from the account's installed Workshop (trillion-rust `src/local_account/show_rules/data.json`); it carries no copy |
| `tool-rows.json` | The eight Workshop rows |
| `ports/show-rules-store.json`, `ports/show-rules-door.json` | The port contracts |
| `test/show-rules-*.test.mjs`, `test/show-type*.test.mjs` | The five old trillion tests; only their paths changed |
| `test/show-rules.test.mjs` | Each row over made-up records handed in as `records` |
| `show/show-rules-admin-mount.tsx` | The module entry of `tool:screen-show-rules-admin`: its `mount` is `mountShowRulesAdminScreen`. |
| `web/src/workspace/show-rules-admin-screen.tsx` | The admin's screen for sharing a preset with people: the preset's copy and its grant, written through the generic records write. Moved byte for byte from the web client (`moved-from.json`). |

## Dependencies

**Depends on:** `tools/set-up-my-account` (`read-data`), `tools/starting-set` (`shipped-defaults.json`), `tools/run-work-later-or-on-a-repeat` (the timed-action engine's zone check), `tools/formula-engine`, `tools/run-experiments` (`score-candidates.ts`), the part manifests of `tools/arrange-screens-in-panes`, `tools/find-anything-from-one-box`, `tools/organize-the-sidebar/sidebar` and `tools/ui`, `tools/workflows` (`do-work/run-a-function.mjs`), `tools/content-identity`.
