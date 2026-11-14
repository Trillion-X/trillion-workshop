// bitfield/packages/ui/canvas-world-transform/CanvasWorldTransform.tsx

import React, { forwardRef } from 'react';

export interface CanvasWorldTransformProps {
  panX: number;
  panY: number;
  zoom: number;
  children: React.ReactNode;
}

/**
 * Physics-layer world transform container. Applies pan/zoom CSS transform
 * for 2D canvas rendering. This is a low-level primitive.
 */
export const CanvasWorldTransform = forwardRef<HTMLDivElement, CanvasWorldTransformProps>(
  ({ panX, panY, zoom, children }, ref) => (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        inset: 0,
        transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
        transformOrigin: '0 0',
      }}
    >
      {children}
    </div>
  )
);

CanvasWorldTransform.displayName = 'CanvasWorldTransform';
