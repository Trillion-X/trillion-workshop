// packages/ui/show/caption-overlay/CaptionOverlay.tsx
//
// PURPOSE
// Styled subtitle/caption text block for placement over a media preview.
// Renders legibility-optimized text with a shadow and stroke at bottom, top,
// or center of its container. Designed to be placed inside an OverlayLayer.
//
// NON-NEGOTIABLE INVARIANTS
// 1. TOKENS ONLY: Colors from the authorized CSS variable list only.
// 2. LEGIBILITY: text-shadow + drop-shadow applied unconditionally so captions
//    remain readable over both light and dark frames.
// 3. POSITION OPTIONS: 'bottom' (default), 'top', 'center'.
// 4. VISIBILITY GATE: When visible=false the element is present in the DOM
//    (preserving layout stability) but opacity:0.
// 5. FILLS OVERLAY WIDTH: width 100%, text centered.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.

import React from 'react';
import { cn } from '../cn';

export type CaptionPosition = 'bottom' | 'top' | 'center';

export interface CaptionOverlayProps {
  text: string;
  position?: CaptionPosition;
  visible?: boolean;
  className?: string;
}

const POSITION_CLASS: Record<CaptionPosition, string> = {
  bottom: 'bottom-4 left-0 right-0',
  top:    'top-4 left-0 right-0',
  center: 'top-1/2 left-0 right-0 -translate-y-1/2',
};

/**
 * Subtitle-style caption rendered over a media frame.
 * Place inside an OverlayLayer for correct compositing.
 *
 * @example
 * ```tsx
 * <OverlayLayer>
 *   <CaptionOverlay text="Chapter 1" position="bottom" visible={showCaption} />
 * </OverlayLayer>
 * ```
 */
export function CaptionOverlay({
  text,
  position = 'bottom',
  visible = true,
  className,
}: CaptionOverlayProps) {
  return (
    <div
      className={cn('absolute pointer-events-none', POSITION_CLASS[position], className)}
      style={{ opacity: visible ? 1 : 0, transition: 'opacity 0.15s ease' }}
    >
      <div
        style={{
          display: 'inline-block',
          width: '100%',
          textAlign: 'center',
          padding: '0.25rem 1rem',
          color: 'var(--text-primary)',
          fontSize: '1rem',
          fontWeight: 600,
          lineHeight: 1.4,
          letterSpacing: '0.01em',
          textShadow:
            '0 1px 4px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.7)',
          filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))',
        }}
      >
        {text}
      </div>
    </div>
  );
}
