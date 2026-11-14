// bitfield/packages/ui/canvas-edge-overlay/CanvasEdgeOverlay.tsx

import React, { forwardRef } from 'react';

export interface CanvasEdgeOverlayProps {
  panX: number;
  panY: number;
  zoom: number;
  children: React.ReactNode;
}

/**
 * Physics-layer SVG overlay for rendering canvas edges.
 * Applies pan/zoom transform to align with world-space nodes.
 */
export const CanvasEdgeOverlay = forwardRef<SVGSVGElement, CanvasEdgeOverlayProps>(
  ({ panX, panY, zoom, children }, ref) => (
    <svg
      ref={ref}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        overflow: 'visible',
      }}
    >
      <defs>
        {/* Arrow marker for edge endpoints */}
        <marker
          id="arrowhead"
          markerWidth="10"
          markerHeight="10"
          refX="9"
          refY="3"
          orient="auto"
        >
          <polygon
            points="0 0, 10 3, 0 6"
            fill="var(--border-primary)"
          />
        </marker>
      </defs>
      <g transform={`translate(${panX}, ${panY}) scale(${zoom})`}>
        {children}
      </g>
    </svg>
  )
);

CanvasEdgeOverlay.displayName = 'CanvasEdgeOverlay';
