# parts/ui/show/layer-diagram

A picture of who connects to what, drawn from DATA: nodes in ordered layers (for example people, then their AIs, then the spaces those AIs may enter) joined by edges, the same in a React page and in a page a server sends.

## Files

| File | Purpose |
|------|---------|
| `layer-diagram.mjs` | The layout (pure geometry, both orientations), the server markup and the look (`LAYER_DIAGRAM_CSS`). |
| `graph-contract.json` | DATA: graph limits, allowed fields, change states, node and edge kinds, unknown-kind policy and refusal messages. |
| `graph-contract.mjs` | Validates typed graph documents, reports path-based findings, and returns the shared drawing, geometry atlas and `1f:` BLAKE3 identities. |
| `graph-patch.json`, `graph-patch.mjs` | DATA and engine: typed operations that evolve a stored graph document (`applyGraphPatch`, `applyGraphOps`), bound to the identity of the document they were written against and the one they give, and the overlay of human corrections (`applyGraphCorrections`) kept beside an inferred document. Operations, scopes and refusal words are rows. |
| `graph-authoring.json`, `graph-authoring.mjs` | DATA and engine for asking a model for a graph document: the message and JSON Schema derived from the contract (`graphAuthoringBrief`), host facts written over the reply, model words made safe, one repair round with the validator's findings (`authorGraphDocument`). |
| `graph-svg.json`, `graph-svg.mjs` | DATA and engine for a graph document as one standalone SVG (`graphDocumentSvg`, `graphSvgAssets`): palettes baked as literals, declarative moving dots, the geometry atlas, files named by the BLAKE3 identity of their bytes with a manifest. |
| `graph-live.json`, `graph-live.mjs` | The few commands (`answer`, `show`, `sketch`) a reader's own AI may send to steer an open picture; every id is checked against the document, the parts named come back with their atlas boxes, a sketch applies to a copy. |
| `author-input.json`, `author-input.mjs` | What leaves the machine when a model is asked for a graph from a large input: excluded paths, ranked classes, one budget, the exact list of what leaves and what stays. |
| `change-graph.json`, `change-graph.mjs` | A list of changed files as a valid graph document: a lane per folder, a node per file with its change state, the overflow gathered into one rest node. No model, nothing leaves the machine; `src/change-picture.mjs` draws it. |
| `select-glob.mjs` | The one `*`-wildcard selector test shared by corrections and input rules. |
| `layer-diagram.d.mts` | Types for `layer-diagram.mjs`, for TypeScript callers. |
| `LayerDiagram.tsx` | The React drawing, from the same layout and look. |

## Key Types / Functions

| Export | Shape | Role |
|--------|-------|------|
| `layerDiagramLayout(diagram, orientation)` | `diagram: { id, label, caption?, layers: [{ id, label?, nodes: [{ id, label, detail?, mark?: { image? , letters? }, tone? }] }], edges: [{ from, to, tone?, label? }] }`, `orientation: 'across' \| 'down'` -> `{ id, label, caption, orientation, width, height, heads[], nodes[{ ..., x, y, w, h }], edges[{ ..., d, label_x, label_y }] }` | Places every node and draws every edge. Both orientations size boxes to their wrapped words; `across` spreads columns vertically and `down` stacks layers in rows, using fewer phone columns when a label needs room. An edge naming a missing node is dropped; a repeated node id keeps its first place. |
| `layerDiagramAtlas(layout)` | -> `{ id, orientation, width, height, boxes[], edges[] }` | Geometry sidecar: heading and node boxes plus edge paths in drawing order. |
| `layerDiagramNodeParts(node, orientation)` | -> `{ mark: {size, x, y} \| null, label: {x, y, anchor, lines, line_height}, detail \| null }` | Where a node's mark and complete wrapped words sit inside its box, shared by both renderers. |
| `layerDiagramHtml(diagram)` | -> string | A `<figure role="img">` holding both drawings and the caption, every value escaped; `''` for an empty diagram. Used by `../document-page` for a block's `diagram`. |
| `LayerDiagram` | `{ diagram: LayerDiagramData }` | The React drawing. |
| `LAYER_DIAGRAM_CSS` | string | The look: theme role tokens only (landing names `--text-primary`, `--thread-line`, `--ink-line`, `--paper-tint`, `--on-accent`, falling back to document names `--ink`, `--thread`, `--grey-strong`, `--surface-base`, `--button-text`). Tones: `strong` (a moving accent line), `refused` (a dotted line with an accent label), `highlighted` (a filled accent box). Below 760px the `down` drawing shows; with reduced motion nothing moves. |
| `layerDiagramClass(base, tone)` | -> string | The class names a node or edge wears. |
| `diagramImageSrc(value)` | -> string \| null | A mark's picture address, same-site or `https://` only. |

Phone connectors use the outside gutter between node rows. They enter a target from the clear space above its box, leaving layer headings and unrelated boxes uncovered. Headings have a page-colour backing in both renderers, and image marks sit in a contrast-safe circular slot; wide phone nodes put that slot beside their words. The shared layout test samples connector curves against heading and non-endpoint box bounds.

## Typed graph documents

`{ schema_version, id, label, caption?, lanes: [{ id, label?, nodes: [{ id, label, detail?, kind?, delta, mark?, min_height? }] }], edges: [{ from, to, kind?, label?, delta }] }`. Nodes and edges name a change state; the states and their shared tone names are DATA. The shared drawing keeps each state as `data-delta` metadata. Validation returns path-based findings for broken references, duplicate ids, missing or extra fields, and positions or sizes. `min_height` is the only layout hint and acts as a floor. Unknown kinds draw plain with an `UNKNOWN_KIND` warning when DATA allows it. A valid document has at least one node and produces the shared drawing, geometry atlas and stable identities. `graphIdentity(document)` is the BLAKE3 identity of the document as data with sorted keys. A patch (`{ graph, from, to, ops }`) refuses a document that is not the one it was written against; corrections are rows `{ select, exclude?, label?, detail?, lane? }` selected by node id or glob that apply again after every regeneration and report selectors that matched nothing. A model is asked through `authorGraphDocument`, whose `ask` is handed in; the same document leaves as standalone SVG through `graphDocumentSvg`. The document page accepts a graph document in a block's `graph` field. See `test/graph-contract.test.mjs`.

## Dependencies

**Depends on:** `../server-rendered-page/escape-html.mjs` (`escapeHtml`); `../../../live-namespace/do-work/blake3.mjs` (declared BLAKE3 owner); `@noble/hashes/utils.js` (hex encoding).
**Depended on by:** `../document-page` (a block's `diagram` or `graph`); the gettrillion.ai feature pages and landing (`trillion-site/src/designs/2026-09-27-red-thread`). Tested by `test/layer-diagram.test.mjs`, `test/graph-contract.test.mjs`, `test/graph-patch.test.mjs`, `test/graph-authoring.test.mjs` and `test/graph-svg.test.mjs`, `test/graph-live.test.mjs` and `test/graph-author-input.test.mjs`.

## Why this design

The picture a browser draws and the readable copy a crawler reads come from one layout, so they cannot drift. Only the connectors are SVG paths; each head, card and edge label is HTML inside the picture (foreignObject), so a card is a real background with its words as real text, which a colour-adapting extension (Dark Reader) darkens as one and a forced-colours mode repaints with system colours, and the heads are real `h3` headings in the page's headline type. A deterministic width estimate splits words into lines and expands the cards before edges are routed. Grounds, words and marks are the paired names of `parts/screen-look/paired-surfaces.json`. Browser bounds were checked for every feature diagram at 390px and 1100px. References: Front and Monday integration hubs, Greptile and Daylight connection diagrams (Mobbin), 21st.dev animated beam (id 4681); saved in `<scratch>/2026-09-29/feature-pages/refs/`. 21st.dev Sankey (id 29403) was reviewed for this correction but its interactive chart code was not used. Original code.
