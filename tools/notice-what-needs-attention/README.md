# tools/notice-what-needs-attention/

Whether a record is history brought in (an earlier chat imported, a transcript read back, a backfill) or something happening now.

Moved byte for byte from Trillion-X/trillion at tag `old-trillion-before-worker-retire` (b6ae0ebf81) by `tools/move-code-between-trees` (move row `move-rows/trillion-tools-a-l-round-3.json`). `moved-from.json` names each file's source path and commit and the identity of its bytes there and here; only import paths differ. The folder keeps the source tree's own paths under it, so the files import each other as they did. It is not a tool yet (no `tool-rows.json`): its files are imported by path.

## Files

| File | From |
|------|------|
| `src/brought-in.mjs` | `src/brought-in.mjs` |

The job's other moved files are kept once in a shared place, because more than one group imports them:

- `src/brought-in.json` is at `tools/shared-code/src/brought-in.json`

## Not yet here

- `src/attention.mjs`: it imports opinion content that is read_as_rows (src/attention.json): the file loads only once it takes those rows from its caller, which is an adaptation, not a byte-for-byte move

## Dependencies

**Depends on:** the files its moved files import, at the paths those imports name.

**Depended on by:** nothing in this repository yet.
