# tools/decide-who-may-change-a-cap/

Who may change a person's use or spend cap, its ceiling, the billing month and the paid ceiling, and how far.

Moved byte for byte from Trillion-X/trillion at tag `old-trillion-before-worker-retire` (b6ae0ebf81) by `tools/move-code-between-trees` (move row `move-rows/trillion-tools-a-l-round-3.json`). `moved-from.json` names each file's source path and commit and the identity of its bytes there and here; only import paths differ. The folder keeps the source tree's own paths under it, so the files import each other as they did. It is not a tool yet (no `tool-rows.json`): its files are imported by path.

## Files

| File | From |
|------|------|
| `src/cap-change.mjs` | `src/cap-change.mjs` |
| `src/passkey-authority.json` | `src/passkey-authority.json` |

The job's other moved files are kept once in a shared place, because more than one group imports them:

- `src/cap-change.json` is at `tools/shared-code/src/cap-change.json`

## Dependencies

**Depends on:** the files its moved files import, at the paths those imports name.

**Depended on by:** nothing in this repository yet.
