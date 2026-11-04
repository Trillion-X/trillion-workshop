// parts/graph-canvas/show/CanvasView.tsx
//
// PURPOSE
//   The reusable graph VIEW, from bitfield-packages packages/graph-canvas/show/CanvasView.tsx: a full-bleed relative
//   container, the shared GraphCanvas renderer (camera, drag and zoom owned by the caller's useGraphCanvas), a
//   camera-tracking dot-grid world background, an empty state, and the caller's overlay children (inspector, drawer).
//   A workflow's step graph and a funnel's stages are both configurations of this one view: they differ only in the
//   frames they compute, the node they draw and the panels they hang beside it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The caller owns graph interaction state (useGraphCanvas) and passes it through; CanvasView holds none.
//   2. Shared ui primitives and look tokens only; CanvasView never names what its graph is about.

import React from 'react';
import { CanvasDotGrid, Container } from '../../ui';
import { GraphCanvas, type GraphCanvasProps } from './GraphCanvas';

export interface CanvasViewProps extends Omit<GraphCanvasProps, 'children' | 'underlay'> {
  /** The outer container ref (viewport measurement is the caller's concern). */
  containerRef?: React.Ref<HTMLDivElement>;
  /** Render the camera-tracking dot-grid world background (default: true). */
  showDotGrid?: boolean;
  /** A layout word carried onto the container as `data-canvas-layout`, for tests and tools. */
  layout?: string;
  /** Overlay children (inspector, drawer, legend). */
  children?: React.ReactNode;
}

/** The blind graph view: every GraphCanvas prop forwarded, the dot grid first, then the caller's overlays. */
export function CanvasView({ containerRef, showDotGrid = true, layout, children, camera, ...graphProps }: CanvasViewProps): React.ReactElement {
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
    >
      <GraphCanvas camera={camera} {...graphProps}>
        {showDotGrid && camera ? <CanvasDotGrid panX={camera.pan_x} panY={camera.pan_y} zoom={camera.zoom} /> : null}
        {children}
      </GraphCanvas>
    </Container>
  );
}
