// packages/graph-canvas/show/CanvasView.tsx
//
// =============================================================================
// PURPOSE — the reusable "observable graph VIEW" primitive (L069)
// =============================================================================
//
// A graph view is: a full-bleed relative container, the shared `graph-canvas`
// renderer (camera/drag/zoom owned by the caller's `useGraphCanvas`), a
// camera-tracking dot-grid world background, an empty state, and a stack of
// overlay children (toolbar / minimap / inspector / drawer). BOTH the workflow
// canvas AND the funnel tornado are configurations of this one view: same
// container, same graph-canvas substrate, same dot-grid world — they differ
// only in the FRAMES they compute (layered auto-layout vs `layoutTornado`), the
// `renderNode` they draw, and the overlay children they hang.
//
// `graph-canvas` stays the low-level renderer UNDERNEATH CanvasView (unchanged).
// CanvasView is the shared composition seam so a funnel "renders through the
// same canvas primitive as the workflow engine" literally — no bespoke second
// canvas, no duplicated dot-grid/container/camera wiring.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Behavior-preserving extraction: WorkflowCanvas's render is exactly this
//    composition (outer Container → GraphCanvas → CanvasDotGrid → children).
//    A golden test (`WorkflowCanvas.golden.test.tsx`) proves WorkflowCanvas
//    renders byte-identically before/after adopting CanvasView.
// 2. Caller owns graph interaction state (`useGraphCanvas`) and passes it
//    through — CanvasView holds NO interaction state of its own (SSOT).
// 3. ui primitives + tokens only; no domain vocabulary. CanvasView never names
//    "workflow" or "funnel" — it is a blind graph view.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { CanvasDotGrid, Container } from '../../ui';
import { GraphCanvas } from './GraphCanvas';
import type { GraphCanvasProps } from './GraphCanvas';
// NOTE: `graph-canvas` is CanvasView's own package; GraphCanvas is a sibling
// module. Kept as the `@/packages/graph-canvas/...` alias (not relative) to
// match the repo-wide import convention used everywhere else in this tree.

export interface CanvasViewProps extends Omit<GraphCanvasProps, 'children' | 'underlay'> {
  /** The outer container ref (viewport measurement is the caller's concern). */
  containerRef?: React.Ref<HTMLDivElement>;
  /** Render the camera-tracking dot-grid world background (default: true). */
  showDotGrid?: boolean;
  /**
   * A layout annotation carried onto the container as `data-canvas-layout`
   * (e.g. "tornado"). Positions live in the `nodes` frames the caller computes
   * (`computeFrames` for the workflow layered layout, `layoutTornado` for the
   * funnel silhouette); this is only a machine-readable hint for tests/tools.
   * Undefined → no attribute (so existing callers stay byte-identical).
   */
  layout?: string;
  /**
   * A generic `surface.reachability` perceivability tag carried onto the
   * container as `data-reach-role` (e.g. "funnel-canvas"). Any caller of this
   * shared view (funnel tornado, workflow canvas, or a future canvas surface)
   * can declare itself as a `must_see` target for the reachability prover this
   * way, without CanvasView ever naming a specific surface. Undefined → no
   * attribute (existing callers stay byte-identical).
   */
  reachRole?: string;
  /** Overlay children (flow rail, toolbar, minimap, popover, inspector, drawer). */
  children?: React.ReactNode;
  /**
   * A dedicated inspector/detail slot rendered after the overlay children. A
   * convenience for callers (e.g. the funnel's stage-detail drawer) that want a
   * named seam; workflow-canvas passes its NodeInspector via `children`, so this
   * is undefined there → no DOM change.
   */
  inspectorSlot?: React.ReactNode;
}

/**
 * The blind graph view. Forwards every graph-canvas prop the caller supplies,
 * renders the dot-grid world (unless disabled) as the FIRST child inside the
 * canvas, then the caller's overlay children and optional inspector slot.
 */
export function CanvasView({
  containerRef,
  showDotGrid = true,
  layout,
  reachRole,
  children,
  inspectorSlot,
  camera,
  ...graphProps
}: CanvasViewProps): React.ReactElement {
  return (
    <Container
      ref={containerRef}
      height="full"
      width="full"
      flex={1}
      minHeight="0"
      position="relative"
      overflow="hidden"
      {...(layout ? { 'data-canvas-layout': layout } : {})}
      {...(reachRole ? { 'data-reach-role': reachRole } : {})}
    >
      <GraphCanvas camera={camera} {...graphProps}>
        {showDotGrid && camera ? (
          <CanvasDotGrid panX={camera.pan_x} panY={camera.pan_y} zoom={camera.zoom} />
        ) : null}
        {children}
        {inspectorSlot}
      </GraphCanvas>
    </Container>
  );
}
