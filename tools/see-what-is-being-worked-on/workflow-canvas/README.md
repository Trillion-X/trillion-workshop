# parts/workflow-canvas

What is left of the separate workflow canvas: a generic edge drawing and a layered layout, used by the funnel graph. A workflow, a run of it, a trigger or schedule, the AI on a job and the hover card's small picture are all drawn on the board (`parts/group`, through `src/workspace/board-of.tsx`), not here.

## Files

| File | Purpose |
|------|---------|
| `part.json` | The public files other code may import. |
| `show/WorkflowEdge.tsx` | A generic SVG Bezier edge and its arrow marker (no workflow words); drawn by `parts/funnel-offer-graph`. |
| `read-data/layered-layout.ts` | `layeredFrames`: a deterministic top-down layout of any directed graph. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `WorkflowEdge` / `CanvasArrowMarker` | `({ edgeId, sourceX, sourceY, targetX, targetY, label? })` | One drawn edge and its arrowhead. |
| `layeredFrames` | `(ids, edges, size?) => CanvasNodeFrame[]` | The layout. |

## In Trillion

`show/StepGraph.tsx` (the step graph on the shared NodeGraph canvas: section cards per step, flowing lines, a side panel) is deleted. Every graph it drew is now one board source (`src/graph-board-source.mjs` `graphAsBoardSource`, `parts/group/do-work/board-source.ts`) drawn on the board:

- A workflow's own tab and a trigger or schedule's own tab: `src/workspace/workflows-screen.tsx`, source read from `/work/api/workflows/board/<id>`; **Document** and **Table** are the shared record views of the same steps.
- The AI on a job (its tools, the other AIs it asked, its skills): `src/workspace/job-run.tsx`, one board per job, the records handed over directly.
- The automation hover card: `src/workspace/automation-preview-source.tsx`, a still picture of the board through the board's own picture export (`BoardStill`).

There the steps are cards with their live state and actions, the lines typed connectors in their kind's colour leaving and arriving at their kind's port, and the board's drawing, shapes, notes, pictures, frames, fold, collapse and tidy all apply.

The Automations Map that drew every workflow, trigger and tool at once (the bitfield-packages `packages/workflow-canvas` port: WorkflowCanvas, its node cards, NodeInspector side panel, create bar and records seam `src/workspace/workflow-canvas-records.ts`) is gone as well.

Reference anatomy: Sim Studio's workflow renderer (Apache-2.0, studied only, no code lifted), AirOps and Klaviyo run views.

## Dependencies

**Depends on:** `parts/graph-canvas` (`layered-layout.ts` frame type).

**Depended on by:** `parts/funnel-offer-graph` (`WorkflowEdge`), `test/workflow-funnel-page-screens.test.mjs` (`layeredFrames`).
