# workflow-canvas

One sentence: the living map of everything this product can do — every real workflow definition and trigger, rendered as a connected, searchable, editable, runnable canvas.

## Files

| File | Purpose |
|------|---------|
| `things-to-store-and-run.json` | The package boundary: placeable surface, projection-backed input descriptors, two engine-maintained projections (trigger facts, spatial+live facts), the save/layout owner actions (facts + published complete-definition records), and tombstones for the retired publish plumbing. |
| `read-data/read-workflow-canvas-layout.ts` | Decode the projection feeds → definitions/triggers/layout; derive edges from step references and trigger dispatch; deterministic layered auto-layout; flow list; plain-language step summaries. |
| `do-work/save-workflow-canvas-actions.ts` | Build the owner request that saves action edits/creations (facts + published definition record — saved actions are immediately executable). |
| `do-work/save-workflow-canvas-layout.ts` | Build the kind-safe placement-only save (spatial fact, never behavior). |
| `do-work/run-workflow-canvas-definition.ts` | Build the run-now request (`execute_definition` with steps included) and decode the real per-step run report. |
| `show/WorkflowCanvas.tsx` | The surface: feeds → projection → graph substrate; flow rail + search; drag/save; inspector + create bar + run pulses. Renders its canvas through `graph-canvas`'s shared `CanvasView` primitive. |
| `show/WorkflowCanvas.golden.test.tsx` | Byte-identical golden (L116) gating the `CanvasView` extraction — snapshots the full canvas chrome; WorkflowCanvas must render identically before/after adopting CanvasView (which now lives in `graph-canvas`). |
| `show/WorkflowNodeCard.tsx` | Node card (action/trigger), Studio-glass tokens, kind accent, paused/shipped/run states. |
| `show/NodeInspector.tsx` | Behavior-first inspector: real step vocabulary (ask/write/read/return/action/loop/wait), pause/run/save, shipped-with-fork honesty, run report. |
| `show/CanvasCommandOverlay.tsx` | Create bar: name + real first-step shape → a real, executable definition. |
| `show/WorkflowEdge.tsx` | Generic SVG Bezier edge + arrow marker (zero domain vocabulary). |
| `show/workflow-canvas-types.ts` | Shared show-layer node + run-state types. |
| `show/mount-workflow-canvas.tsx` | Material mount through the shared frame/error-boundary convention. |
| `.bitfield-entry-scope/` | Generated entry scope (build output). |

## Key Types

| Type | Shape | Role |
|------|-------|------|
| `WorkflowDefinitionRow` | `{id, slug, description, isActive, steps, layout}` | One decoded definition (from its published complete-definition record). |
| `WorkflowTriggerRow` | `{id, name, topic, outputTemplate, isActive, layout}` | One decoded trigger (from trigger facts). |
| `WorkflowCanvasNodeDisplay` | `{id, label, kind, enabled, description, steps, stepSummaries, topic, shippedBy, editable, workflowId}` | What a node renders. |
| `WorkflowCanvasProjection` | `{feedFrames, nodeDisplayById, edgeDisplayById, flows}` | Render-ready graph. |
| `WorkflowRunResult` | `{definitionId, status, durationMs, output, steps[], error}` | Decoded run reply for the run report + pulses. |
| `CanvasNode` | frame + `data: WorkflowCanvasNodeDisplay` | Positioned node. |

## How Truth Flows (no publish workflow — purely reactive)

```text
definition store (published workflow-definition records + facts)
        │ engine-maintained projections (recompute on every matched write)
        ▼
published-records / workflow-canvas-triggers / workflow-canvas-layout inputs
        ▼ read-data decode + projection (edges derived, layout deterministic)
canvas render ── select → inspector ── edit/create → do-work request
        ▲                                            │
        └── projections recompute ◄── owner action writes facts + the
                                       published definition record
```

A canvas-created action is executable the moment it saves: the save loop
writes the complete definition record at
`current-item/published-record/workflow-definition` — the exact path the
workflow owner hydrates. (The previous implementation used a wrong final path
segment and no canvas definition was ever executable.)

## Dependencies

**Depends on:** `graph-canvas` (camera/drag/zoom substrate), `ui` (primitives + `readPublishedRecords`), `screen-look` (tokens), `@bitfield/runtime-kit` (data reads + owner requests), `slot::workflow` (execution owner — untouched).
**Depended on by:** screen-arrangement placement (placeable surface), future run-observability surfaces attaching to the same definition identities.

## Invariants

- Reusable source stays dumb/blind/generic: no product vocabulary, no provider clients, no SQL.
- read-data only decodes; do-work only builds requests; show only renders.
- Visible copy is plain language — engine vocabulary never renders.
- Shipped definitions (rank-1 records from other packages) are read-only with "Make my copy"; canvas-owned records stay editable.
- The invented parallel store (the ghost "action definition" property family) is dead; tests gate its return.

## In Trillion

Brought over from bitfield-packages `packages/workflow-canvas` at commit `e99ac5976`: every `show/`, `read-data/` and `do-work/` file, byte for byte but for the records seam (its runtime imports read `#workspace-records`, `src/workspace/records.ts`), with every other difference listed in `scripts/port-sources.json`. It is Automations' **Map** (`src/workspace/workflows-screen.tsx`), mounted by its own `show/mount-workflow-canvas.tsx`. What it reads and the work it asks for are answered from the Automations screen's own routes by `src/workspace/workflow-canvas-records.ts`:

| The canvas asks for | Answered from |
|---------------------|---------------|
| `workflow-canvas-definitions` | `GET /work/api/workflows/map`: each workflow (steps as the engine runs them); this person's own are editable, Trillion's own read "Shipped with Trillion"; each Workshop tool something starts. |
| `workflow-canvas-triggers` | the same answer: each trigger and schedule, whether it is on and what it starts. |
| `workflow-canvas-layout` | one of the person's own saved records (`/work/api/records`), so the map opens the same on every device. |
| `slot::workflow` save / delete / layout / run | `save-workflow` (`save_workflow`), `remove-workflow` (`remove_workflow`), the layout record, `run-now` or `start-workflow`. |
| `slot::find-current-items` run history | that workflow's runs from the same answer. |

Trillion's own files in this part:

| File | Purpose |
|------|---------|
| `read-data/layered-layout.ts` | `layeredFrames`: a deterministic top-down layout of any directed graph (pieces side by side, a node one layer below the deepest node leading to it, lone nodes in a grid below). |
| `show/StepGraph.tsx` | One workflow or one run as a graph (a workflow's own tab, the automation hover card): CanvasView, a card per step (status dot and words from the caller's `looks`), the package's `WorkflowEdge`, and the side panel for the chosen step. |
| `part.json` | The public files: `show/StepGraph.tsx`, `show/WorkflowEdge.tsx`, `show/mount-workflow-canvas.tsx`, `read-data/layered-layout.ts`. |

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `StepGraph` | `({ steps: GraphStep[], edges: GraphEdge[], looks: Record<state, StateLook>, evidenceLabel?, noEvidence?, readWhole?, still? })` | Draws the graph; `still` draws it small and read-only for a hover card. |
| `GraphStep` | `{ id, title, icon?, caption?, state, details?: {label,text}[], output?, output_schema?, evidence?: string \| null, evidence_partial? }` | One step; `state` is a raw key looked up in `looks`. |
| `StateLook` | `{ label, tone, pulse?, flow?: EdgeFlow }` | How a state reads and how edges out of it are drawn (`EdgeFlow` is the edge's `runStatus`). |
| `layeredFrames` | `(ids, edges, size?) => CanvasNodeFrame[]` | The layout. |

The package's vitest files (`*.test.ts(x)` and the golden snapshot) are kept as they are; Trillion's own runner checks the port in a real browser (`test/automation-map.test.mjs`) and the removal tool in `test/remove-workflow.test.mjs`.

**In Trillion, depends on:** `tools/graph-canvas`, `tools/ui`, `#workspace-records`. **Depended on by:** `src/workspace/workflows-screen.tsx` (Map, a workflow's tab), `src/workspace/automation-preview-source.tsx`, `tools/funnel-offer-graph` (`WorkflowEdge`).
