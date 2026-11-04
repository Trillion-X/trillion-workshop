# tools/build-a-screen-from-patches/

A screen sees changes as JSON patches, not whole answers. Two kinds of patch are handled here. The first is a view patch: when a screen reads an answer again, it is sent only the RFC 6902 operations that turn the answer it already holds into the next one. Each answer is named by the BLAKE3 identity of its canonical JSON. The screen checks the identity of what it rebuilt and reads the whole answer again if it does not match. The second is a screen spec: an AI sends a screen made of shared parts as lines, one change per line (SpecStream). Each complete line is applied to the flat spec `{ root, elements, state, reads }` as it arrives, so the screen can be drawn while it is still being written. A bad line is left out and said, and the lines after it still apply. Every element is checked against the props its part declares. Nothing here reads or writes the person's records.

## Files

| File | Purpose |
|------|---------|
| `read-data/view-patch.mjs` | `identityOf`, `diff`, `applyPatch`, `makeAnswerCache`, `patchedAnswer`, `textAfter`. Moved byte for byte from Trillion-X/trillion `src/view-patch.mjs`. |
| `read-data/view-patch.json` | The cache size, the smallest and largest answer patched (2000 and 400000 characters), the share a patch must stay under (0.6), and the words. Moved byte for byte. |
| `read-data/screen-spec.mjs` | `specStream`, `specFromText`, `checkElement`, `checkSpec`, `pointerGet`, `pointerSet`, `resolveValue`, `conditionHolds`, `boundPath`, `readsState`, `partsGuide`, `screenOnly`. Moved from Trillion-X/trillion `src/screen-spec.mjs`. The only change is one import path: `../parts/ui/declared-props.json` is now `./declared-props.json`. |
| `read-data/screen-spec.json` | The limits on one screen, one line and one stream, every word said, and the words an AI reads about making a parts screen. Moved byte for byte. |
| `read-data/declared-props.json` | The props, events and children each shared part declares. Copied byte for byte from Trillion-X/trillion `parts/ui/declared-props.json`. |
| `read-data/screen-patch-tools.mjs` | The three rows' functions over the moved code. |
| `tool-rows.json` | `tool:make-a-view-patch`, `tool:apply-a-view-patch`, `tool:build-a-screen-spec-from-a-patch-stream`. These are container rows run by `tools/records-door`'s `run-an-export.mjs`, with no records door. `@noble/hashes` is packed for BLAKE3. |
| `part.json` | Nothing here is imported by other code. |
| `test/view-patch.test.mjs` | Trillion's `test/view-patch.test.mjs`, with its assertions unchanged. |
| `test/screen-spec.test.mjs` | Trillion's `test/screen-spec.test.mjs` tests of screen-spec itself, with their assertions unchanged. |
| `test/screen-patch-rows.test.mjs` | Runs the three rows the way the container runs them. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `patchedAnswer` | `({ answer, have, key, cache, config? }) => answer \| { ...answer, identity } \| { ...answer, identity, patch: { from, to, ops } }` | Answers with a patch only when `have` is the identity held under `key` and the patch is smaller than `patch_share` of the whole. Otherwise the answer is whole. |
| `textAfter` | `(answer, held?) => { text, held? } \| { stale: true }` | What the screen shows after one answer. It is stale when the patch does not fit what is held or does not rebuild its identity. |
| `applyPatch` / `diff` | `(model, ops) => model` / `(before, after) => ops` | RFC 6902 add, remove and replace. Each object on the changed path is copied, so a branch that did not change keeps its identity. |
| `specStream` | `() => { push(text), end(text), spec() }` | Takes the whole stream so far each time and applies every line it completes. Answers `{ spec, changed, said, restarted }`. |
| `checkSpec` | `(spec, { requests?, parts?, complete? }) => { spec, fixes, problems }` | Checks every element against its declared part. It also drops children that were never sent and reads that do not name a declared GET request, and requires the root. |
| `viewPatchBetween`, `textAfterViewPatch`, `screenSpecFromLines` | `(input) => result` | The rows: two answers become a patch or the whole answer; a held answer and a patch become the text; lines of changes become a checked spec. |

## Moved from Trillion

These came from Trillion-X/trillion `src/view-patch.mjs`, `src/view-patch.json`, `src/screen-spec.mjs`, `src/screen-spec.json` and `parts/ui/declared-props.json`, together with their tests. Some old tests stay in trillion because they run code that has not moved:

- `test/view-patch.test.mjs`: "screen_read carries the screen's identity to the Worker" runs `src/screen-view.mjs`.
- `test/screen-spec.test.mjs`, four tests:
  - "every declared part has its component" reads `src/workspace/declared-parts.ts`.
  - "every row names only props its part takes" reads the part sources under `parts/ui/`.
  - "make_screen keeps the finished lines" runs `src/screen-view.mjs`.
  - "the AI app bridge hands the growing arguments" runs `parts/ui/show/ai-app-bridge/ai-app-bridge.mjs`.

Two other files of the same job were not moved. `src/screen-view.mjs` imports workspace screens and page looks, and `src/worker.mjs` holds the per-isolate answer cache and `screenRead`. Both are tied to the Cloudflare Worker.

## Dependencies

**Depends on:**
- `@noble/hashes` (BLAKE3)
- `tools/records-door` (`run-an-export.mjs`)
- Node's standard library

**Depended on by:** `tool-rows.json`. In Trillion-X/trillion, these files still import their own copies:
- `src/screen-view.mjs`, `src/worker.mjs`, `src/workshop.mjs`
- `src/workspace/screen-view.tsx`, `src/workspace/parts-screen.tsx`, `src/workspace/declared-parts.ts`
