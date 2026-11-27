# tools/notice-what-needs-attention/

Whether a record is history brought in (an earlier chat imported, a transcript read back, a backfill) or something happening now.

Moved byte for byte from Trillion-X/trillion at tag `old-trillion-before-worker-retire` (b6ae0ebf81) by `tools/move-code-between-trees` (move row `move-rows/older-repository-tools-a-l-round-3.json`). `moved-from.json` names each file's source path and commit and the identity of its bytes there and here; only import paths differ. The folder keeps the source tree's own paths under it, so the files import each other as they did. The attention port now also has an executable `what-this-tool-does-and-how-to-run-it.json` row.

## Files

| File | From |
|------|------|
| `src/brought-in.mjs` | `src/brought-in.mjs` |

The job's other moved files are kept once in a shared place, because more than one group imports them:

- `src/brought-in.json` is at `tools/shared-code/src/brought-in.json`

## Attention port

`read-data/attention.mjs` preserves the old attention facts, rules, voice ownership, classifier interpretation, route behavior and bounded retriage. `createAttention(settings, { broughtIn, wordsAgeMinutes })` receives policy rows and the current history owner per caller. It imports no old Worker engine or opinion content.

`do-work/notice-attention.mjs` runs the read-only Workshop row. It takes the attention policy (`settings`) and brought-in policy (`history`) only as input; it reads no records. Rules run through the current formulas tool. A classifier answer is supplied by the caller; this tool makes no model call. The owner-wired route and retriage helpers remain library operations, rather than granting a public tool account cleanup authority.

`ports/attention.json` records the source-first contract. `test/attention.test.mjs` keeps the old behavior tests and uses the current formula implementation.

## Dependencies

**Depends on:** the files its moved files import, at the paths those imports name.

**Depended on by:** nothing in this repository yet.

## Moved from old trillion main (5dc302be)

Byte for byte under their old paths, only import paths changed; `moved-from.json` names each.

| Old path | Here | Status |
|---|---|---|
| `src/attention-calibration.json` | `src/attention-calibration.json` | data, read by its module |
| `src/attention.json` | `src/attention.json` | data, read by its module |
