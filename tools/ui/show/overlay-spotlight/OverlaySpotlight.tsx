// packages/ui/show/overlay-spotlight/OverlaySpotlight.tsx
//
// The React mount for the occluder geometry (M1). Renders a full-viewport scrim
// with N holes punched at the step's target rects, via a single SVG `<path>` with
// `fill-rule: evenodd` (the holes are excluded from the fill, so hit-testing is
// deterministic — clicks inside a hole pass through to the real control beneath,
// no browser-dependent mask-hit behaviour). Portaled to <body> at the
// `walkthrough` layer so it sits above everything it can point at.
//
// NON-NEGOTIABLE INVARIANTS
//   - Returns null when closed — zero DOM footprint.
//   - ZERO Society vocabulary, ZERO closed enums: the shape registry + policy are
//     DATA-driven (this component only renders the geometry it is handed).
//   - All visuals are DATA: `scrimColor` is a token/DATA string, never hardcoded.
//   - block-all blocks every click (read-only spotlight); cutouts-interactive lets
//     ONLY the holes through (interactive gate) — the path catches the dark area,
//     the SVG container is pointer-transparent so holes fall through.

import { createPortal } from 'react-dom';
import { LAYER_ORDER } from '../layer-order/layer-order';
import { scrimPathD, type CutoutGeometry, type PointerPolicy } from './overlay-spotlight';

export interface OverlaySpotlightProps {
  /** Whether the scrim is shown. */
  readonly open: boolean;
  /** Visible viewport frame; offsets locate it inside the layout viewport. */
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly offsetLeft?: number;
    readonly offsetTop?: number;
  };
  /** Pre-computed cutout geometry (from `computeCutouts`). Empty = plain scrim. */
  readonly cutouts: readonly CutoutGeometry[];
  /** Click behaviour for the dark area + holes (from `pointerPolicy`). */
  readonly policy: PointerPolicy;
  /** Scrim fill — a DATA/token color string. Defaults to the glass-overlay token. */
  readonly scrimColor?: string;
  /** Blur behind the scrim, in px, clipped to the same path so the cutouts stay sharp. 0 (default) dims only. */
  readonly blurPx?: number;
  /** Called when the user clicks the dark (non-hole) area — typically skip/dismiss. */
  readonly onScrimClick?: () => void;
}

/** Full-viewport spotlight scrim with punched cutouts. */
export function OverlaySpotlight({
  open,
  viewport,
  cutouts,
  policy,
  scrimColor = 'var(--glass-overlay-background)',
  blurPx = 0,
  onScrimClick,
}: OverlaySpotlightProps) {
  if (!open) return null;

  const d = scrimPathD(viewport, cutouts);
  const viewportLeft = viewport.offsetLeft ?? 0;
  const viewportTop = viewport.offsetTop ?? 0;
  // cutouts-interactive: only the painted scrim path catches clicks → holes fall
  // through. block-all: an extra transparent full-rect catcher over the holes too.
  const blockAll = policy === 'block-all';

  return createPortal(
    <>
    {blurPx > 0 && (
      // The blur sits under the scrim and is clipped by its own path (even-odd), so the page outside the holes blurs
      // and what the step points at stays sharp.
      <div
        data-overlay-blur
        aria-hidden
        style={{
          position: 'fixed',
          left: viewportLeft,
          top: viewportTop,
          width: viewport.width,
          height: viewport.height,
          zIndex: LAYER_ORDER.walkthrough - 1,
          pointerEvents: 'none',
          backdropFilter: `blur(${blurPx}px)`,
          WebkitBackdropFilter: `blur(${blurPx}px)`,
          clipPath: `path(evenodd, '${d}')`,
        }}
      />
    )}
    <svg
      data-overlay-spotlight
      width={viewport.width}
      height={viewport.height}
      viewBox={`0 0 ${viewport.width} ${viewport.height}`}
      style={{
        position: 'fixed',
        left: viewportLeft,
        top: viewportTop,
        width: viewport.width,
        height: viewport.height,
        zIndex: LAYER_ORDER.walkthrough - 1,
        pointerEvents: 'none', // container transparent; only painted children catch
      }}
    >
      {blockAll && (
        // Catches clicks everywhere (including over holes) for a read-only spotlight.
        <rect
          x={0}
          y={0}
          width={viewport.width}
          height={viewport.height}
          fill="transparent"
          style={{ pointerEvents: 'auto' }}
          onClick={onScrimClick}
        />
      )}
      <path
        data-overlay-scrim
        d={d}
        fill={scrimColor}
        fillRule="evenodd"
        style={{ pointerEvents: policy === 'pass-all' ? 'none' : 'auto' }}
        onClick={onScrimClick}
      />
    </svg>
    </>,
    document.body,
  );
}
