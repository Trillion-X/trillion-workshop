// packages/ui/show/draggable-panel/DraggablePanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// An absolutely-positioned floating panel that OPENS at an anchor {x,y} and can be
// DRAGGED to a new spot by a grip handle. The shared primitive for "a popover you
// can move out of the way" — board metric/time/rollup popovers, any card-anchored
// editor. Feature packages compose it around their own Card content; they never
// re-implement pointer-drag math.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Drag is initiated ONLY from the grip handle (pointer-capture is on the grip,
//    NEVER the whole panel) — so buttons/inputs in the body keep their clicks. This
//    is the fix for the class of "a floating control stole my click" bugs.
// 2. The drag offset RESETS when the anchor {x,y} changes (a different card's panel
//    opened) — the panel snaps to the new anchor, then is draggable again.
// 3. Blind: arbitrary props (incl. data-* marker attributes like a stage-chrome
//    guard) spread onto the root via `...rest`; the primitive knows no domain.
// 4. `touch-action: none` on the grip so a touch-drag moves the panel, not scrolls.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { GripHorizontal } from 'lucide-react';
import { Icon } from '@/packages/ui/show/icon';

export interface DraggablePanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Anchor X (px, in the positioning context) the panel opens at. */
  readonly x: number;
  /** Anchor Y (px) the panel opens at. */
  readonly y: number;
  /** Stacking order. Default 60 (above board chrome). */
  readonly zIndex?: number;
  readonly children: React.ReactNode;
}

export function DraggablePanel({ x, y, zIndex = 60, children, style, ...rest }: DraggablePanelProps): JSX.Element {
  const [offset, setOffset] = React.useState({ x: 0, y: 0 });
  const drag = React.useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  // A different card's panel opened (anchor moved) → snap back to the new anchor.
  React.useEffect(() => { setOffset({ x: 0, y: 0 }); }, [x, y]);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation(); // don't let the canvas below start a marquee/pan
    drag.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setOffset({ x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) });
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  return (
    <div {...rest} style={{ position: 'absolute', left: x + offset.x, top: y + offset.y, zIndex, ...style }}>
      {/* Grip handle — the ONLY drag surface. Pointer-capture lives here so body
          buttons/inputs keep their own clicks (the anti-"stole my click" invariant). */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        role="button"
        aria-label="Drag to move"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 16,
          cursor: 'grab',
          touchAction: 'none',
          opacity: 0.5,
        }}
      >
        <Icon icon={GripHorizontal} size="xs" />
      </div>
      {children}
    </div>
  );
}
