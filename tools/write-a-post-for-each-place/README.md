# tools/write-a-post-for-each-place/

Writes one body (a change summary, a status, a picture with words) for each kind of place it is posted to: a pull request thread on one forge, a merge request note on another, a chat, a post. The body is written once as neutral blocks; each place is a capability record (whether it shows markup, folded sections, check boxes, its text dialect, its longest body and how it shows a picture with a light and a dark form). The composer reads only those fields, never the place's name, does without what the place cannot show, and says what it did without and which capabilities it relied on that nobody has confirmed. A body over the limit is cut at a block boundary and says so; a marker given first survives the cut. It is pure: nothing is posted, read or kept.

## Files

| File | Purpose |
|------|---------|
| `read-data/surface-compose.mjs` | `capabilityOf`, `capabilityOfPlace`, `composeFor`. Moved from Trillion-X/trillion `src/surface-compose.mjs`; only its import of the markup tree writer changed (`./markup-tree.mjs`). |
| `read-data/surface-compose.json` | One capability record per surface (`github_comment`, `gitlab_note`, `bitbucket_comment`, `plain_message`), the record a post place starts from, and every word written. Moved byte for byte. |
| `read-data/markup-tree.mjs` | The one tree writer the composer writes markup through (`element`, `serialise`, `textOf`). Copied byte for byte from Trillion-X/trillion `parts/ui/show/server-rendered-page/markup-tree.mjs`. |
| `read-data/escape-html.mjs` | The escaper the tree writer uses. Copied byte for byte from the same old folder. |
| `read-data/post-tools.mjs` | The row's function: picks the capability record the input names (a surface, a whole record, or a post place) and composes. |
| `tool-rows.json` | `tool:write-a-post-for-a-place`, a container row run by `tools/records-door`'s `run-an-export.mjs`; no records door. |
| `part.json` | Nothing here is imported by other code. |
| `test/surface-compose.test.mjs` | Trillion's `test/surface-compose.test.mjs` with its assertions unchanged. |
| `test/write-a-post-row.test.mjs` | The row run as the container runner runs it: a named surface, a whole record, a post place, and the refusals. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `capabilityOf` | `(surfaceId, settings?) => record \| null` | The named surface's record, or null when the data has none. |
| `capabilityOfPlace` | `(place, settings?) => record` | A record from a post place's own `format.caption_max_characters`; an unsourced limit is unproven. |
| `composeFor` | `(blocks, capability, { marker? }, settings?) => { body, degraded, unproven_used, truncated }` | Blocks: heading, paragraph, code, list, checklist, image (`dark_url` optional), collapsible. |
| `writeBodyForPlace` | `({ blocks, surface \| capability \| place, marker? }) => { body, degraded, unproven_used, truncated, capability }` | `tool:write-a-post-for-a-place`. |
| `capabilityAsked` | `({ surface, capability, place }) => record` | Exactly one is given; an unknown surface is refused naming the known ones. |

## Moved from Trillion

Trillion-X/trillion `src/surface-compose.mjs`, `src/surface-compose.json` and `test/surface-compose.test.mjs` (every test, assertions unchanged), with `markup-tree.mjs` and `escape-html.mjs` from `parts/ui/show/server-rendered-page/` copied beside them. The old caller `src/change-picture.mjs` (a picture of a pull request's change, kept as one comment of ours on it) stays in trillion: it needs `parts/ui/show/layer-diagram` (change graph, graph picture), the author input, the owned upsert of one comment and a connector runner. Every test in `test/change-picture.test.mjs` exercises change-picture itself, so none moved. Until it moves, it imports its own copy of `src/surface-compose.mjs`; the many old callers of `markup-tree.mjs` and `escape-html.mjs` keep theirs.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs` only), Node's standard library.

**Depended on by:** `tool-rows.json`. In Trillion-X/trillion, `src/change-picture.mjs` still imports its own copy.
