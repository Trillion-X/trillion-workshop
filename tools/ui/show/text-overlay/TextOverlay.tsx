// packages/ui/show/text-overlay/TextOverlay.tsx
//
// PURPOSE
// Absolutely-positioned text annotation for placement over a media frame.
// Used for lower-thirds, title cards, watermarks, and freeform text annotations.
// Position is controlled by x/y percentage offsets from the top-left corner.
//
// NON-NEGOTIABLE INVARIANTS
// 1. TOKENS ONLY: Default color is var(--text-primary). Caller may supply any
//    CSS color string for the `color` prop (e.g. a named token).
// 2. POSITION IS PERCENTAGE-BASED: x/y are 0..100 offsets within the overlay,
//    matching the coordinate space of a media frame.
// 3. VISIBILITY GATE: visible=false → opacity:0, element remains in DOM.
// 4. NO INTERACTION: pointer-events-none always.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.

import React from 'react';

export interface TextOverlayProps {
  text: string;
  /** Horizontal offset as a percentage (0–100) from the left edge. Default 50. */
  x?: number;
  /** Vertical offset as a percentage (0–100) from the top edge. Default 90. */
  y?: number;
  /** Font size in rem. Default 1. */
  fontSize?: number;
  /** CSS color value. Default var(--text-primary). */
  color?: string;
  visible?: boolean;
}

/**
 * Absolutely-positioned text annotation inside an OverlayLayer.
 * x/y are percentage offsets (0-100) within the overlay container.
 *
 * @example
 * ```tsx
 * <OverlayLayer>
 *   <TextOverlay text="Intro" x={10} y={10} fontSize={1.25} />
 * </OverlayLayer>
 * ```
 */
export function TextOverlay({
  text,
  x = 50,
  y = 90,
  fontSize = 1,
  color = 'var(--text-primary)',
  visible = true,
}: TextOverlayProps) {
  return (
    <div
      style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        transform: 'translate(-50%, -50%)',
        color,
        fontSize: `${fontSize}rem`,
        fontWeight: 600,
        lineHeight: 1.3,
        whiteSpace: 'pre-wrap',
        pointerEvents: 'none',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.15s ease',
        textShadow: '0 1px 4px rgba(0,0,0,0.85)',
      }}
    >
      {text}
    </div>
  );
}
