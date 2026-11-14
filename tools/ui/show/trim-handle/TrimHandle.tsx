// parts/ui/show/trim-handle/TrimHandle.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Draggable bracket edge affordance for a timeline clip — the Loom/Descript
// "trim by dragging the handles" primitive. A thin grabbable bar pinned to one
// edge (start or end) of a clip. On pointer drag it reports the CUMULATIVE
// horizontal delta in pixels; the consumer converts pixels → seconds using its
// own lane geometry and authors the trim. The handle owns ZERO domain meaning:
// it never knows what a clip, a second, or a trim is — it is pure pointer→delta.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. TOKENS ONLY: colors from --accent-primary / --border-focus / glass tokens.
//    No hardcoded hex, no invented token names.
// 2. BLIND: emits only `onDrag(deltaPx)` (cumulative from grab) + `onDragEnd`.
//    It converts nothing to seconds and names no domain concept.
// 3. POINTER CAPTURE: uses setPointerCapture so a drag that leaves the element
//    still tracks; releases on pointerup. Never leaks a global listener.
// 4. ABSOLUTE: pinned to its edge via inline `left`/`right` — the consumer wraps
//    the clip in a `relative` container. Numeric geometry is inline style only.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cn } from '../cn';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export type TrimHandleEdge = 'start' | 'end';

export interface TrimHandleProps {
  /** Which edge of the clip this handle grabs. */
  edge: TrimHandleEdge;
  /** Cumulative horizontal pointer delta (px) since grab. + = rightward. */
  onDrag: (deltaPx: number) => void;
  /** Fired once when the drag gesture commits (pointerup). */
  onDragEnd?: () => void;
  onDragCancel?: () => void;
  /** Keyboard nudge in timeline seconds. */
  onNudge?: (seconds: number) => void;
  /** Accessible label ("Trim start" / "Trim end") supplied by the consumer. */
  ariaLabel: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Bracket trim handle. Pin one to each edge of a selected clip (inside a
 * `relative` clip container). The consumer maps `deltaPx` to seconds.
 *
 * @example
 * ```tsx
 * <div style={{ position: 'relative' }}>
 *   <ClipBlock ... />
 *   <TrimHandle edge="start" ariaLabel="Trim start"
 *     onDrag={(dx) => previewTrim(dx / pxPerSecond)}
 *     onDragEnd={commitTrim} />
 *   <TrimHandle edge="end" ariaLabel="Trim end" onDrag={...} onDragEnd={...} />
 * </div>
 * ```
 */
export function TrimHandle({ edge, onDrag, onDragEnd, onDragCancel, onNudge, ariaLabel, className }: TrimHandleProps) {
  const originXRef = React.useRef<number | null>(null);

  const handlePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.preventDefault();
    originXRef.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (originXRef.current === null) return;
    onDrag(event.clientX - originXRef.current);
  }, [onDrag]);

  const endDrag = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (originXRef.current === null) return;
    originXRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (event.type === 'pointercancel') {
      onDrag(0);
      onDragCancel?.();
    } else onDragEnd?.();
  }, [onDragEnd, onDragCancel, onDrag]);

  return (
    <div
      className={cn('absolute top-0 bottom-0 z-20 group', className)}
      style={{
        [edge === 'start' ? 'left' : 'right']: -3,
        width: 10,
        cursor: 'ew-resize',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        touchAction: 'none',
      }}
      role="slider"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      tabIndex={0}
      onKeyDown={event => {
        if (!onNudge || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();event.stopPropagation();
        onNudge((event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 0.1));
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Grab bar — bracket in the focus accent, brightening on hover */}
      <div
        style={{
          width: 3,
          height: '70%',
          borderRadius: 2,
          backgroundColor: 'var(--accent-primary, var(--border-focus))',
          boxShadow: '0 0 4px 1px color-mix(in srgb, var(--accent-primary, var(--border-focus)) 45%, transparent)',
        }}
      />
    </div>
  );
}
