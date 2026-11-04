# Graph Canvas Show

Browser-local graph canvas rendering and interaction primitives.

## Files

| File | Purpose |
|---|---|
| `GraphCanvas.tsx` | Generic graph renderer that applies caller-owned camera state to nodes and edges, with token-backed surface chrome and no hardcoded visual palette. |
| `CanvasView.tsx` | The reusable "observable graph VIEW" primitive (L069): outer Container + `<GraphCanvas>` + camera-tracking dot-grid + `children`/`inspectorSlot` + a `layout` annotation. Caller owns `useGraphCanvas` and threads graph state in. Consumed by `workflow-canvas` (the workflow surface) AND `funnel-offer-graph` (the tornado funnel) so both render through ONE canvas view. Domain-free. |
| `use-graph-canvas.ts` | Generic interaction hook for pan, zoom, selection, zoom-to-fit, and optional node drag. |
| `types.ts` | Domain-free camera, node frame, and edge route types. |
| `DefaultEdge.tsx` | Default edge renderer for callers that do not provide one. |

## Rules

- This folder owns graph Physics only: camera, pan, zoom, node frames, edge routes, and pointer math.
- Consumers own Society rendering through `renderNode` and `renderEdge`.
- Loading, empty, and error chrome must stay domain-free and draw from the active screen-look CSS variables; package surfaces supply domain content through props.
- Empty graphs still render overlay children so command bars and inspectors remain available before data exists.
- Wheel input must be normalized once before interaction math. Tiny pixel-mode trackpad/pinch deltas must not become fixed large zoom steps.
- Node pointer capture must not steal interactive descendants. Buttons, inputs, links, ARIA controls, and generic no-drag markers stay owned by the rendered node content.
- Canvas pointer movement stays generic even when node dragging is disabled, so callers can own panning, overlays, and tab-content canvas behavior without Graph Canvas knowing the caller's surface type.
