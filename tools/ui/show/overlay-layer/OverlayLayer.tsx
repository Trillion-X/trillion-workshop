// packages/ui/show/overlay-layer/OverlayLayer.tsx
//
// PURPOSE
// Absolutely-positioned transparent layer filling its nearest position:relative
// ancestor. Compositing surface for captions, text annotations, PIP frames, and
// any overlay content placed over a preview stage.
//
// NON-NEGOTIABLE INVARIANTS
// 1. FILLS PARENT: absolute inset-0. Consumer wraps in position:relative.
// 2. POINTER EVENTS PASS THROUGH: pointer-events-none on the layer; children
//    opt in to interactivity individually.
// 3. TOKENS ONLY: No hardcoded color values. Background is transparent.
// 4. NO LAYOUT OPINION: No padding, margin, or flex. Children position themselves.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.

import React from 'react';
import { cn } from '../cn';

export interface OverlayLayerProps {
  children?: React.ReactNode;
  /** Additional class names — use to override z-index or enable pointer-events. */
  className?: string;
}

/**
 * Absolutely-positioned layer that fills its relative-positioned parent.
 * Used to composite captions, text annotations, and PIP frames over a preview.
 *
 * The layer itself is pointer-events-none; children must opt in to interactivity.
 *
 * @example
 * ```tsx
 * <div style={{ position: 'relative', width: 640, height: 360 }}>
 *   <MediaPreview />
 *   <OverlayLayer>
 *     <CaptionOverlay text="Hello world" position="bottom" />
 *   </OverlayLayer>
 * </div>
 * ```
 */
export function OverlayLayer({ children, className }: OverlayLayerProps) {
  return (
    <div
      className={cn(
        'absolute inset-0 z-10 pointer-events-none overflow-hidden',
        className,
      )}
    >
      {children}
    </div>
  );
}
