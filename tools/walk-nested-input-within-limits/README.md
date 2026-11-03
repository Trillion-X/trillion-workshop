# tools/walk-nested-input-within-limits/

The one guard for walking untrusted nested input: an imported document, pasted rich text, list row values from an AI, a board scene. It walks with a stack it owns instead of recursion, so a value nested 150,000 levels deep is refused with a typed reason instead of crashing a renderer or a store. Deeper than 100 levels, more than 100,000 values, or a value that refers back to itself is refused, and the refusal comes with the words the person reads.

## Files

| File | Purpose |
|------|---------|
| `read-data/bounded-walk.mjs` | `boundedWalk(root, { children, visit, limits })` and `refusalWords(result)`, plus `checkNested(input)`, the container's run of `tool:check-nested-input`. |
| `read-data/bounded-walk.json` | The limits (`max_depth` 100, `max_nodes` 100,000) and the words for each reason. |
| `tool-rows.json` | `tool:check-nested-input`, a `container` row with no internet. |
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

Moved from Trillion-X/trillion `parts/bounded-walk.mjs` and `parts/bounded-walk.json`, code unchanged except the header's paths. The two library tests of `test/bounded-walk.test.mjs` moved with it unchanged; its third test checks list rows in `src/lists.mjs`, which still imports the old copy, so that copy stays in Trillion until `src/lists.mjs` moves.

## Dependencies

**Depends on:** Node's standard library only.

**Depended on by:** `tool-rows.json`.
