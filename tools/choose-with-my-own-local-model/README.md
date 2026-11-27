# tools/choose-with-my-own-local-model/

Choosing among supplied options with the person's own local model: one account's bounded, input-free observations of local choice requests.

Moved byte for byte from Trillion-X/trillion at tag `old-trillion-before-worker-retire` (b6ae0ebf81) by `tools/move-code-between-trees` (move row `move-rows/older-repository-tools-a-l-round-3.json`). `moved-from.json` names each file's source path and commit and the identity of its bytes there and here; only import paths differ. The folder keeps the source tree's own paths under it, so the files import each other as they did. It is not a tool yet (no `what-this-tool-does-and-how-to-run-it.json`): its files are imported by path.

## Files

| File | From |
|------|------|
| `src/local-choice-observations.mjs` | `src/local-choice-observations.mjs` |
| `test/local-choice-observations.test.mjs` | `test/local-choice-observations.test.mjs` |

## Not yet here

- `read-data/file-local-choice.mjs` preserves the source algorithm: grounded file descriptions rank recorded active pursuits, allow no supported pursuit and validate the supplied choice.
- `read-data/local-choice-route.mjs` now imports the current task, settings and scorer owners. It retains private choose/coverage gates and observes scoring under the task deadline; a caller may supply the current account's cache instead of the legacy SQL cache.
- `read-data/local-choice.mjs` preserves explicit-choice validation and prompts. It uses the current local-model owner when no admitted device queue is supplied. A supplied queue receives only the existing device route; there is no hosted fallback.

These are library entry points. A production descriptor, public dependency admission and installed execution have not been verified by the port's unit tests. The old retired Worker routes are not installed in the engine.

## Dependencies

**Depends on:** the files its moved files import, at the paths those imports name.

**Depended on by:** nothing in this repository yet.
