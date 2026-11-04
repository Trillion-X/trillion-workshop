# parts/graph-canvas/

The zoomable canvas the screen arrangement's pane map (`parts/screen-arrangement/show/ArrangementNavigator.tsx`) draws the panes on, and the graph view (`show/CanvasView.tsx`: the canvas, its dot grid and the caller's panels) workflow graphs and funnels draw on.

## Files

| File | Purpose |
|------|---------|
| `part.json` | The files other parts may import. |
| `show/` | The canvas component and its helpers. |

## Key Types / Functions

The public files are listed in `part.json`.

## Dependencies

**Depends on:** React.

**Depended on by:** `parts/screen-arrangement`, `parts/workflow-canvas`, `parts/funnel-offer-graph`.
