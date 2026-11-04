# tools/choose-with-my-own-local-model/

Choosing among supplied options with the person's own local model: one account's bounded, input-free observations of local choice requests.

Moved byte for byte from Trillion-X/trillion at tag `old-trillion-before-worker-retire` (b6ae0ebf81) by `tools/move-code-between-trees` (move row `move-rows/trillion-tools-a-l-round-3.json`). `moved-from.json` names each file's source path and commit and the identity of its bytes there and here; only import paths differ. The folder keeps the source tree's own paths under it, so the files import each other as they did. It is not a tool yet (no `tool-rows.json`): its files are imported by path.

## Files

| File | From |
|------|------|
| `src/local-choice-observations.mjs` | `src/local-choice-observations.mjs` |
| `test/local-choice-observations.test.mjs` | `test/local-choice-observations.test.mjs` |

## Not yet here

- `src/file-local-choice.mjs`: it imports src/account-erasure-policy.mjs, src/admitted-commands.mjs, src/customer-database-records.mjs and 36 more, engine files (class rust-engine, or ported into trillion-rust per their rows): this move carries no engine JavaScript, so it waits until it reads those through the records door or the engine
- `src/local-choice-route.mjs`: it imports src/account-erasure-policy.mjs, src/admitted-commands.mjs, src/customer-database-records.mjs and 36 more, engine files (class rust-engine, or ported into trillion-rust per their rows): this move carries no engine JavaScript, so it waits until it reads those through the records door or the engine
- `src/local-choice.mjs`: it imports src/account-erasure-policy.mjs, src/admitted-commands.mjs, src/customer-database-records.mjs and 36 more, engine files (class rust-engine, or ported into trillion-rust per their rows): this move carries no engine JavaScript, so it waits until it reads those through the records door or the engine

## Dependencies

**Depends on:** the files its moved files import, at the paths those imports name.

**Depended on by:** nothing in this repository yet.
