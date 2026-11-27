# tools/walk-nested-input-within-limits/

The one guard for walking untrusted nested input: an imported document, pasted rich text, list row values from an AI, a board scene. It walks with a stack it owns instead of recursion, so a value nested 150,000 levels deep is refused with a typed reason instead of crashing a renderer or a store. Deeper than 100 levels, more than 100,000 values, or a value that refers back to itself is refused, and the refusal comes with the words the person reads.

## Files

| File | Purpose |
|------|---------|
| `read-data/bounded-walk-core.mjs` | The canonical iterative walker, unchanged from the exact archived source. |
| `read-data/bounded-walk.mjs` | Forwards the library exports and keeps `checkNested(input)` plus the container JSON command. |
| `read-data/bounded-walk.json` | The limits (`max_depth` 100, `max_nodes` 100,000) and the words for each reason. |
| `what-this-tool-does-and-how-to-run-it.json` | `tool:check-nested-input`, a `container` row with no internet. |
| `part.json` | The code and its limits are public. |
| `test/bounded-walk.test.mjs` | The original tests (iterative depth refusal, node limit, cycle, visitor refusal, shared object, custom children) and the row's sample run. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `boundedWalk` | `(root, { children?, visit?, limits?, settings? }) => { ok: true, nodes } \| { ok: false, reason, limit }` | Walks with an explicit stack; stops at the first limit crossed. `visit` may refuse by returning a reason string. |
| `refusalWords` | `(result, settings?) => string` | The plain words of a refusal, with `{limit}` filled. |
| `jsonChildren` | `(value) => value[]` | An array's items or an object's values. |
| `checkNested` | `({ value, limits? }) => result & { said? }` | The tool run. |

## Moved from Trillion

The original package entry was already adapted in `2dcc68cf830719bc0387583fb9e370f67d0ca6a7`. This does not claim that migration was source-first. Exact original `tools/bounded-walk.mjs` bytes were later preserved alone in `source-baselines/bounded-walk.mjs.held`, committed as `1b6f146a` before the fresh canonical core existed. The archive is evidence only and is never imported at runtime.

Both this package's public entry and the historical root `tools/bounded-walk.mjs` now forward to the one core. The list engine consumes the package entry. Existing limits, refusal words, named exports and the descriptor's JSON command remain available. The original library tests and actual packaged descriptor checks exercise those public paths.

## Dependencies

**Depends on:** Node's standard library only.

**Depended on by:** `what-this-tool-does-and-how-to-run-it.json`.
