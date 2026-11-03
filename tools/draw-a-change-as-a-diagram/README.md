# tools/draw-a-change-as-a-diagram/

A diagram of who connects to what, written as DATA: one graph document of lanes, nodes and edges, each marked added, modified, removed or unchanged, that the person's AI writes from words or from a code change. The document is checked by one contract (if it parses, it draws), changed by typed operations bound to the identity of the copy they were written against, kept corrected by a person's fixes that apply again after every regeneration, and drawn as standalone SVG files (no script, no outside reference, palettes baked in, moving dots as declarative SVG animation) named by the identity of their bytes, with a geometry atlas of every box it drew. Moved from old trillion `parts/ui/show/layer-diagram/` and `src/diagram-tools.mjs`, `src/change-picture.mjs`, `src/surface-compose.mjs`, `src/owned-upsert.mjs` (original code); only import paths changed.

No row calls a model or the network: the AI is the author, the rows give it the brief and check what it wrote.

## Files

| File | Purpose |
|------|---------|
| `do-work/graph-contract.mjs`, `read-data/graph-contract.json` | Validates a graph document (path-based findings for broken references, duplicate ids, missing or extra fields, positions or sizes, which the schema refuses), renders it through the layer layout, the atlas and the `1f:` BLAKE3 identity of the document as data with sorted keys. |
| `do-work/graph-patch.mjs`, `read-data/graph-patch.json` | `applyGraphPatch` (`{ graph, from, to, ops }`, refused when `from` is not the copy in hand or `to` is not what the ops give), `applyGraphOps`, and `applyGraphCorrections` (rows `{ select, exclude?, label?, detail?, lane? }` by id or `*` glob, with the selectors that matched nothing). Operations, scopes and words are rows. |
| `do-work/graph-svg.mjs`, `read-data/graph-svg.json` | `graphDocumentSvg`, `graphSvgAssets`: one standalone SVG per palette, the atlas, files named by the identity of their bytes, and a manifest. |
| `do-work/graph-authoring.mjs`, `read-data/graph-authoring.json` | The brief (system message and JSON Schema derived from the contract), host facts written over a reply, model words contained, one repair round with the validator's findings (`authorGraphDocument`, whose `ask` is handed in). |
| `do-work/author-input.mjs`, `read-data/author-input.json` | What of a large input (the files of a change) a model would be shown: excluded paths, ranked classes, one budget, the exact list of what leaves and what stays. |
| `do-work/change-graph.mjs`, `read-data/change-graph.json` | A list of changed files as a valid graph document: a lane per folder, a node per file with its change state, the overflow in one rest node. |
| `do-work/graph-live.mjs`, `read-data/graph-live.json` | The commands (`answer`, `show`, `sketch`) a reader's AI may send about an open picture, checked against the document's ids. |
| `do-work/layer-diagram.mjs`, `do-work/layer-diagram.d.mts` | The layer layout (pure geometry, both orientations) and its server markup, which the contract and the SVG draw through. |
| `do-work/select-glob.mjs` | The one `*`-wildcard selector test shared by corrections and input rules. |
| `do-work/diagram-tools.mjs` | `draw_diagram`: the brief and outbound list without a document; with one, checked, contained, drawn, and a live command checked. |
| `do-work/change-picture.mjs`, `read-data/change-picture.json` | `pictureChange`: reads a change through a connector runner handed in, draws it, writes one comment body for what the host's comment surface can show, and keeps one comment of ours up to date when `post` is set. Library only: the connector runner comes from the caller. |
| `do-work/surface-compose.mjs`, `read-data/surface-compose.json` | One body written for what a place can show, from its capability record. |
| `do-work/owned-upsert.mjs`, `read-data/owned-upsert.json` | Keeps one message of ours on a shared surface: found by marker and author, never written twice, never written for a change that moved on. |
| `do-work/escape-html.mjs`, `do-work/markup-tree.mjs`, `do-work/sanitize-error-text.ts` | The escape, the markup tree writer and the error-words gate the engine above uses. |
| `do-work/requests.mjs`, `do-work/run-request.mjs` | One function per row; `node do-work/run-request.mjs <function>` with the request on standard input prints `{ result }` or `{ error }`. |
| `tool-rows.json` | The four rows, run in the small container with no network. |
| `test/` | The original tests of every moved module, and each row's sample run as the container runs it. |

## The rows

| Row | Does |
|-----|------|
| `tool:draw-a-diagram` | Words or a change's files in: the brief and outbound list; then the document in: checked, drawn as SVG files, identity and identifiers |
| `tool:patch-a-diagram` | A stored document and a patch in: the new document and its identity, or the first refusal |
| `tool:correct-an-inferred-diagram` | An inferred document and a person's kept fixes in: the corrected document and the fixes that matched nothing |
| `tool:picture-changed-files` | A list of changed files in: a valid document and its SVG files, nothing sent anywhere |

## Dependencies

**Depends on:** `@noble/hashes` (BLAKE3, hex), `tools/screen-looks/read-data/resolve-screen-look-palette.js` (the look's default font stack); Node 22.18 or later (`sanitize-error-text.ts` is loaded with type stripping).

**Depended on by:** nothing in this repository imports from here yet. In old trillion, `parts/ui/show/document-page/document-page-html.mjs` still draws a block's `graph` and `diagram` with its own copy of the contract and the layout, and `src/source-project-tools.mjs` still runs `pictureChange` with its connector runner.
