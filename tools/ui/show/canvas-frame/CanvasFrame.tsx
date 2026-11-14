// packages/ui/show/canvas-frame/CanvasFrame.tsx
//
// A presentation FRAME region for the board canvas (#169) — a named rectangular area
// that turns infinite canvas into named chapters (attention routing). Reference-grounded
// (Mobbin: Fibery "Section" f4e8d90d — solid outline + title chip at the top-left above
// the border; Craft bb56b9af — the dashed variant; Figma-frame canon). Blind + purely
// presentational: the board owns geometry (CanvasNode sizes the box), selection, and the
// title text; this primitive only paints the chrome. The interior is TRANSPARENT so the
// board items inside show through; the frame member sits at low z so items on top receive
// their own clicks and the empty frame area selects the frame.

import * as React from 'react';
import { cn } from '../cn';

export interface CanvasFrameProps {
  /** The frame's name, shown in a chip at the top-left (Figma/Fibery frame-title canon).
   *  `undefined` → no chip (an untitled region); empty string → the "Frame" placeholder. */
  readonly title?: string;
  /** Accent chrome while the frame member is selected. */
  readonly selected?: boolean;
  /** Dashed outline (Craft style) vs the default solid (Fibery/Figma). */
  readonly dashed?: boolean;
}

/**
 * Paint a frame region: a thin rounded outline filling its node box with a transparent
 * interior + a title chip floating at the top-left, above the top border.
 */
export function CanvasFrame({ title, selected, dashed }: CanvasFrameProps) {
  return (
    <div className="absolute inset-0">
      <div
        className={cn(
          'absolute inset-0 rounded-lg border-2',
          dashed ? 'border-dashed' : 'border-solid',
          selected ? 'border-[var(--accent-primary)]' : 'border-[var(--border-primary)]',
        )}
      />
      {title !== undefined && (
        <div
          className={cn(
            'absolute left-0 top-0 max-w-full -translate-y-full truncate rounded-t-md px-2 py-0.5 text-xs font-medium',
            selected
              ? 'bg-[var(--accent-primary)] text-[var(--button-primary-text)]'
              : 'bg-[var(--surface-raised)] text-[var(--text-muted)]',
          )}
        >
          {title || 'Frame'}
        </div>
      )}
    </div>
  );
}
