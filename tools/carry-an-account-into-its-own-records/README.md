# tools/carry-an-account-into-its-own-records/

Carrying a person's records from the old storage shapes into their own records, and the one place a filling store turns away work that only adds.

Moved byte for byte from Trillion-X/trillion at tag `old-trillion-before-worker-retire` (b6ae0ebf81) by `tools/move-code-between-trees` (move row `move-rows/trillion-tools-a-l-round-3.json`). `moved-from.json` names each file's source path and commit and the identity of its bytes there and here; only import paths differ. The folder keeps the source tree's own paths under it, so the files import each other as they did. It is not a tool yet (no `tool-rows.json`): its files are imported by path.

## Files

| File | From |
|------|------|
| `src/carry-forward.mjs` | `src/carry-forward.mjs` |
| `test/carry-forward.test.mjs` | `test/carry-forward.test.mjs` |

## Not yet here

- `src/growth-admission.mjs`: it imports src/store-size.mjs, engine files (class rust-engine, or ported into trillion-rust per their rows): this move carries no engine JavaScript, so it waits until it reads those through the records door or the engine
- `src/imported-history-receipt.mjs`: it imports src/record-history.json, src/record-history.mjs, src/store-size.mjs, engine files (class rust-engine, or ported into trillion-rust per their rows): this move carries no engine JavaScript, so it waits until it reads those through the records door or the engine

## Dependencies

**Depends on:** the files its moved files import, at the paths those imports name.

**Depended on by:** nothing in this repository yet.
