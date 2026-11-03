# tools/build-a-screen-as-an-ai-writes-it/

Lets an AI build a screen of shared parts as it writes it: the spec is a flat map of elements by id whose children are ids, so a parent can be drawn before its children arrive, and each completed line of the AI's output is one patch applied to it. Every element is checked against its part's declared props (`parts/ui/declared-props.json`): a fixable element is repaired, an unusable one is left out with words, and the rest of the screen still draws. Bound values (`$state`, conditions) are looked up, never run. `src/view-patch.mjs` applies a patch without changing the model it was given, and works out the patch between two answers.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees` rules; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Files

| File | Purpose |
|------|---------|
| `src/screen-spec.mjs` | `specStream`, `specFromText`, `checkElement`, `checkSpec`, `resolveValue`, `boundPath`, `conditionHolds`, `declaredParts`, `partsGuide`: the spec format, its checks and repairs. |
| `src/screen-spec.json` | The spec's limits and words. |
| `src/view-patch.mjs`, `src/view-patch.json` | `applyPatch` and the patch between two answers. |
| `parts/ui/declared-props.json` | Each shared part's props: the catalogue an AI's elements are checked against. |
| `part.json` | The tree that imports these files. |
| `test/screen-spec.test.mjs` | Old trillion's spec tests with their assertions unchanged. |

## Not here yet

The React renderer (`src/workspace/parts-screen.tsx`: one memoised element renderer per id, an error boundary per element) and the parts it binds (`parts/ui`, `src/workspace/declared-parts.ts`) stay in old trillion with the tests that read them; old trillion's callers keep their own copy of these files until they move.

## Dependencies

**Depends on:** `@noble/hashes` (view-patch identities); Node 24.
