// packages/ui/show/anchor-resolver/AnchoredCoachmark.tsx
//
// The React mount for the anchored card (M2). A controlled, always-open card
// pinned next to a target RECT (not a React child) — measures itself, runs the
// pure `computePlacement` to choose a side (prefer → opposite → perpendicular →
// the corner covering the least of the target), and draws a tail back at the target (`coachmarkPointer`). Portaled to <body> at the `walkthrough` layer.
//
// NON-NEGOTIABLE INVARIANTS
//   - Returns null when closed, or when target-less and not `centered` — zero DOM footprint. A `centered` card with
//     no target sits in the middle of the visible frame: the one card shell for every step, pointed or not.
//   - `surface: 'content'` hands the card's surface to what it holds (a look that draws its own paper): the shell
//     keeps placement, focus and the tail, and the tail takes the content's `tailFill`.
//   - Placement/pointer geometry is PURE (computePlacement/coachmarkPointer) and
//     unit-tested; this component only measures + paints.
//   - Reuses the shared `Card` (popover variant) — no bespoke surface CSS.
//   - All visuals are DATA/tokens (surface color), never hardcoded hex.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Card } from '../card/Card';
import { LAYER_ORDER } from '../layer-order/layer-order';
import { insetFrame, readSafeAreaInsets, safeEdgePadding } from '../visible-viewport/safe-area-insets';
import {
  computePlacement,
  coachmarkPointer,
  moveCardWithin,
  type PlacementInput,
  type Rect,
  type Size,
} from './anchor-resolver';

export interface AnchoredCoachmarkProps {
  readonly open: boolean;
  /** The screen-space rect to anchor to (from `resolveAnchorRect`). Null → not shown. */
  readonly targetRect: Rect | null;
  /** Visible viewport frame; offsets locate it inside the layout viewport. */
  readonly viewport: Size & {
    readonly offsetLeft?: number;
    readonly offsetTop?: number;
  };
  /** Placement DATA (prefer side, auto_flip, gap). */
  readonly placement?: PlacementInput;
  /** Show the tail pointing back at the target. */
  readonly showPointer?: boolean;
  /** With no target: sit in the middle of the visible frame instead of drawing nothing. */
  readonly centered?: boolean;
  /** The card's width in pixels (it still never runs past the visible frame). */
  readonly width?: number;
  /** 'card' (default): the shared popover card surface. 'content': what the card holds draws its own surface. */
  readonly surface?: 'card' | 'content';
  /** The tail's colour when the content draws the surface (its fill). */
  readonly tailFill?: string;
  /** Accessible name announced when the coachmark opens as a modal dialog. */
  readonly ariaLabel?: string;
  /** Element ids that name and describe the current step. */
  readonly ariaLabelledBy?: string;
  readonly ariaDescribedBy?: string;
  /** Changes whenever the caller wants focus moved into the current coachmark. */
  readonly focusKey?: string;
  /** The card body (e.g. `<StepContent …/>` + nav + progress). */
  readonly children: ReactNode;
}

const HIDDEN_MEASURE: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  visibility: 'hidden',
  pointerEvents: 'none',
};

/** A controlled card anchored to a target rect, with a tail pointing at it. */
export function AnchoredCoachmark({
  open,
  targetRect,
  viewport,
  placement = {},
  showPointer = true,
  centered = false,
  width,
  surface = 'card',
  tailFill,
  ariaLabel = 'Walkthrough',
  ariaLabelledBy,
  ariaDescribedBy,
  focusKey,
  children,
}: AnchoredCoachmarkProps) {
  const cardRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  // The person can move the card out of the way by pressing anywhere on it that is not a control and dragging, with a
  // finger or a mouse. The move lasts for the step: the next step places its card fresh.
  const [moved, setMoved] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ id: number; startX: number; startY: number; from: { x: number; y: number }; active: boolean } | null>(null);
  useEffect(() => { setMoved(null); }, [focusKey, open]);
  // The card is placed inside the visible frame less the window's safe areas, so on a phone it never sits under the
  // status bar or the home indicator. Each inset counts only where it reaches into the visible frame.
  // The shared floating-card gap keeps the card clear of the page edge even without a device inset.
  const insets = readSafeAreaInsets();
  const offsetLeft = viewport.offsetLeft ?? 0;
  const offsetTop = viewport.offsetTop ?? 0;
  const windowWidth = typeof window === 'undefined' ? viewport.width : window.innerWidth;
  const windowHeight = typeof window === 'undefined' ? viewport.height : window.innerHeight;
  const safe = insetFrame(viewport, safeEdgePadding(12, {
    top: Math.max(0, insets.top - offsetTop),
    left: Math.max(0, insets.left - offsetLeft),
    bottom: Math.max(0, insets.bottom - (windowHeight - offsetTop - viewport.height)),
    right: Math.max(0, insets.right - (windowWidth - offsetLeft - viewport.width)),
  }));
  const viewportLeft = offsetLeft + safe.x;
  const viewportTop = offsetTop + safe.y;
  const frame = { width: safe.width, height: safe.height };
  const responsiveWidth = `min(${width ? `${width}px` : '20rem'}, calc(${frame.width}px - 1.5rem))`;
  const ownSurface = surface === 'content';
  // A surface drawn by the content keeps its own corners and turn: the shell is only a placed, unclipped box.
  const shell = ownSurface
    ? { variant: 'ghost' as const, padding: 'none' as const }
    : { variant: 'popover' as const, padding: 'md' as const };
  const responsiveMaxHeight = `calc(${frame.height}px - 2rem)`;
  const overflow: React.CSSProperties = ownSurface ? { overflow: 'visible' } : { maxHeight: responsiveMaxHeight, overflowY: 'auto' };

  // A walkthrough is a temporary modal layer. Preserve the founder's place in
  // the app, move focus into the visible coachmark, and restore it on exit.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    return () => {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [open]);

  // Non-modal: the coachmark points at part of the page and the page stays
  // usable, so focus is never trapped inside it, and never taken from someone
  // writing: a card that opens while the person types leaves their words where
  // they are going.
  useLayoutEffect(() => {
    if (!open || !size) return;
    const card = cardRef.current;
    const active = card?.ownerDocument.activeElement;
    if (active instanceof HTMLElement && !card?.contains(active) && (active.isContentEditable || active.matches('input, textarea, select'))) return;
    const firstControl = card?.querySelector<HTMLElement>('[data-autofocus]:not([disabled])') ?? card?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    firstControl?.focus();
  }, [open, size, focusKey]);

  // Measure the card once it has rendered (and whenever its content changes size).
  useLayoutEffect(() => {
    if (!open || (!targetRect && !centered)) return;
    const el = cardRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (!Number.isFinite(r.width) || !Number.isFinite(r.height) || r.width <= 0 || r.height <= 0) return;
      setSize(previous => previous?.width === r.width && previous?.height === r.height
        ? previous : { width: r.width, height: r.height });
    };
    measure();
    // A newly mounted surface can have no layout box yet. Keep measuring that
    // hidden host until layout supplies its actual dimensions.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    const frame = observer ? null : requestAnimationFrame(measure);
    return () => {
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [open, centered, targetRect, frame.width, frame.height]);

  if (!open || (!targetRect && !centered)) return null;

  // Pass 1: render hidden at the origin to obtain the card size.
  if (!size) {
    return createPortal(
      <Card
        ref={cardRef}
        {...shell}
        style={{
          ...HIDDEN_MEASURE,
          left: viewportLeft,
          top: viewportTop,
          width: responsiveWidth,
          ...overflow,
        }}
      >
        {children}
      </Card>,
      document.body,
    );
  }

  // Pass 2: place + paint, in the safe frame's own coordinates.
  const target = targetRect ? { ...targetRect, x: targetRect.x - safe.x, y: targetRect.y - safe.y } : null;
  const placed = target ? computePlacement(target, size, frame, placement) : null;
  const result = placed ?? { side: 'center', x: Math.max(0, (frame.width - size.width) / 2), y: Math.max(0, (frame.height - size.height) / 2) };
  // Once moved the card no longer sits beside its target, so its tail goes.
  const spot = moved ? moveCardWithin(result, moved, size, frame) : result;
  const pointer = !moved && showPointer && target && placed ? coachmarkPointer(placed, target, size) : null;
  // A card that scrolls inside keeps the finger's vertical scroll; one that fits is all drag.
  const scrolls = (cardRef.current?.scrollHeight ?? 0) > (cardRef.current?.clientHeight ?? 0) + 1;

  const onDragStart = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    if ((event.target as Element).closest('button, a, input, textarea, select, label, [role="button"], [contenteditable="true"], [data-no-drag]')) return;
    dragRef.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, from: moved ?? { x: 0, y: 0 }, active: false };
  };
  const onDragMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < 4) return;
      drag.active = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    // The move is kept against the placed spot, but never past the frame (the spot reads the clamp each time).
    setMoved({ x: drag.from.x + dx, y: drag.from.y + dy });
  };
  const onDragEnd = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    dragRef.current = null;
    // Keep what the person sees as the new base, so the next drag starts from the clamped spot.
    if (drag.active && moved) {
      const clamped = moveCardWithin(result, moved, size, frame);
      setMoved({ x: clamped.x - result.x, y: clamped.y - result.y });
    }
  };

  return createPortal(
    <>
      <Card
        ref={cardRef}
        {...shell}
        role="dialog"
        aria-label={ariaLabelledBy ? undefined : ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        tabIndex={-1}
        data-anchored-coachmark
        data-side={result.side}
        data-moved={moved ? '' : undefined}
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        style={{
          position: 'fixed',
          left: viewportLeft + spot.x,
          top: viewportTop + spot.y,
          zIndex: LAYER_ORDER.walkthrough,
          width: responsiveWidth,
          ...overflow,
          overscrollBehavior: 'contain',
          touchAction: scrolls ? 'pan-y' : 'none',
        }}
      >
        {children}
      </Card>
      {pointer && (
        <div
          data-coachmark-tail
          style={{
            position: 'fixed',
            left: viewportLeft + pointer.x - 6,
            top: viewportTop + pointer.y - 6,
            width: 12,
            height: 12,
            transform: 'rotate(45deg)',
            background: tailFill ?? 'var(--glass-popover-background, var(--surface-raised))',
            borderRight: '1px solid var(--border-subtle, transparent)',
            borderBottom: '1px solid var(--border-subtle, transparent)',
            zIndex: LAYER_ORDER.walkthrough,
            pointerEvents: 'none',
          }}
        />
      )}
    </>,
    document.body,
  );
}
