# tools/keep-records-as-long-as-their-keep-rule-says/

A person's keep rule is a row of their own, and their own schedule fires it. This folder is the one tool that schedule names: `tool:keep-by-its-rule` takes `{rule}` (the id of a keep rule's row) and hands the engine its keep effect; the engine reads the row, decides each record with the formula engine and destroys the records the row says have expired through its restorable erasure.

- **The rule is a row (`record:keep-rule`).** Columns: `enabled`, `keeps_kind` (the kind of record kept), `expire_when` (the formula engine's `{tree, fields}`; the fact `age_ms` is how long ago a record's newest write was), `page` (records one firing destroys) and `walk` (records one firing looks at). Every name is in trillion-rust `src/storage/record_store/settings.json` `keep`; no number is in code.
- **The schedule is a wake declaration.** The person's declaration (trillion-rust `src/wake/wake.json` `declarations`) names this tool with `{rule}` and its own schedule; it stays off until the person switches it on.
- **This tool counts no time and removes nothing.** The engine does both: trillion-rust `src/wake.rs` `Effect::Keep`, `src/storage/record_store/keep.rs`, `src/rule_bindings/keep_condition.rs`.

## Files

| File | Purpose |
|------|---------|
| `read-data/keep-by-rule.mjs` | `keepByRule({rule, resource?})` answers `{said, wake_effects: [{keep: {resource, rule}}]}`; run by `tools/records-door/do-work/run-an-export.mjs`, which prints the effects beside the result |
| `read-data/keep-by-rule.json` | The tool's words and its one default, `resource` (the account's own records) |
| `tool-rows.json` | The row `tool:keep-by-its-rule` |
| `kits/keep-by-its-rule.json` | How a person sets a keep rule up |
| `test/keep-by-rule.test.mjs` | The function and the row, run the way the engine runs it |

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), and on the engine's keep effect.

**Depended on by:** the person's wake declarations.
