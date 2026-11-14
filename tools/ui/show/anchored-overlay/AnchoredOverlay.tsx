// packages/ui/show/anchored-overlay/AnchoredOverlay.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A floating panel that escapes its parent's clip: it portals to <body>, anchors
// itself to a reference element (above or below it), clamps its height to the
// viewport with internal scroll so its footer is always reachable, and can be
// dragged anywhere by a header. This is the primitive a toolbar/popover needs
// when its host is a clipped, overflow-hidden surface (a canvas card, a small
// tab) — render it in-flow and it gets cut off; render it here and it floats free.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. ZERO domain vocabulary — pure positioning Physics, reusable by any host.
// 2. Portaled to <body> so NO ancestor `overflow:hidden` can clip it (the bug
//    this exists to kill). zIndex = LAYER_ORDER.menu (above stage + windows).
// 3. Height is clamped to the available viewport band with `overflow-y:auto` —
//    a panel taller than the screen scrolls; its footer is never unreachable.
// 4. Once the user drags it, it stops tracking the anchor (free-floating) until
//    re-opened — the user's chosen position wins.
// 5. Pointer events inside are stopped from propagating to the surface beneath
//    (so interacting with the panel never starts a canvas drag / loses a
//    contentEditable selection). The optional dismiss backdrop preserves the
//    text selection (preventDefault) for paint-on-selection callers.
// 6. An overlay shows only while its anchor element is shown: when the anchor
//    leaves the page or stops being drawn (its screen is left, a tab is hidden,
//    any ancestor goes display:none), the overlay hides with it instead of flying
//    to the window's top-left corner, and comes back where the anchor is when the
//    anchor is drawn again. A dragged overlay hides with its anchor too.
// =============================================================================

import React from 'react';
import { createPortal } from 'react-dom';
import { LAYER_ORDER } from '../layer-order/layer-order';

export interface AnchoredOverlayProps {
  /** The element this overlay anchors to (a toolbar trigger, the editor card…). */
  readonly anchorRef?: React.RefObject<HTMLElement | null>;
  /** A retained editable selection. Uses current DOM pixels, including scroll
   * and transformed ancestors, instead of a layout engine's world frame. */
  readonly anchorRange?: Range | null;
  /** Self-surfaced content with its own bounded scroll region keeps elevation
   * outside this positioning host instead of having its shadow clipped. */
  readonly contentOwnsScroll?: boolean;
  /** A fixed viewport point to anchor to instead of an element (e.g. a cursor
   *  right-click location). Used when there is no anchor element. */
  readonly anchorPoint?: { readonly x: number; readonly y: number };
  readonly open: boolean;
  /** Place the overlay above, below, or OVER the anchor. Above/below are
   *  collision-aware (flip when they do not fit). 'over' aligns the panel's
   *  top-left to the anchor's top-left — an inline replace-in-place surface
   *  (e.g. a composer that visually takes the anchored block's spot), not a
   *  dropdown, so it never flips. */
  readonly placement?: 'above' | 'below' | 'over';
  /** Gap in px between the anchor and the overlay. */
  readonly gap?: number;
  /** Render a drag header (the overlay becomes repositionable). */
  readonly draggable?: boolean;
  /** Header label shown when draggable. */
  readonly title?: string;
  /** When set, a transparent full-screen backdrop dismisses on pointer-down. */
  readonly onDismiss?: () => void;
  /** Backdrop pointer-down calls preventDefault (keeps a contentEditable selection). */
  readonly dismissPreservesSelection?: boolean;
  /** Overlay min-width tracks the anchor's width (good for a toolbar bar). */
  readonly matchAnchorWidth?: boolean;
  /** A data-attribute flag set on the panel (e.g. for a host blur-guard). */
  readonly flagAttr?: string;
  /** Re-measure trigger for anchor moves that fire NO scroll/resize/ResizeObserver —
   *  e.g. the anchor sits inside a CSS-transformed plane (a canvas camera pan/zoom).
   *  Pass any value that changes with those moves (the camera object, a snapshot);
   *  the overlay re-measures whenever it changes. */
  readonly measureKey?: unknown;
  /** Opaque menu surface (bg + radius + shadow) on the panel body. Default TRUE —
   *  a popover is structurally never transparent (L063: dissolves the whole class of
   *  "forgot to wrap children in an opaque surface" bugs, e.g. the shape/note popovers).
   *  The panel paints NO border: callers that already own a full surface (FlyoutSurface,
   *  Card variant="panel") layer their own border/shadow harmlessly on top of the same
   *  `--black-rich` fill, so there is no double-border artifact. Pass false only for a
   *  genuinely chrome-less overlay. */
  readonly surface?: boolean;
  readonly children: React.ReactNode;
}

interface Pos { left: number; top: number; placement: 'above' | 'below' | 'over'; anchorW: number }

/** Whether an element is drawn now: in the page, with no display:none or content-visibility:hidden ancestor.
 *  A ResizeObserver on the anchor fires when this changes (its box goes to and from nothing), so it is re-read then. */
function isDrawn(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const check = (el as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility;
  return check ? check.call(el) : el.getClientRects().length > 0;
}

export function AnchoredOverlay({
  anchorRef,
  anchorRange,
  contentOwnsScroll = false,
  anchorPoint,
  open,
  placement = 'below',
  gap = 6,
  draggable = false,
  title,
  onDismiss,
  dismissPreservesSelection = false,
  matchAnchorWidth = false,
  flagAttr,
  measureKey,
  surface = true,
  children,
}: AnchoredOverlayProps) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = React.useState<Pos | null>(null);
  // Free position after a drag (null = still tracking the anchor).
  const [dragPos, setDragPos] = React.useState<{ left: number; top: number } | null>(null);
  const dragState = React.useRef<{ dx: number; dy: number } | null>(null);
  // False while the anchor element is not drawn (invariant 6).
  const [anchorShown, setAnchorShown] = React.useState(true);

  const measure = React.useCallback(() => {
    // Anchor to the element if given; otherwise to a fixed viewport point (cursor).
    const rangeNode = anchorRange?.commonAncestorContainer;
    const el = anchorRef?.current ?? (rangeNode instanceof HTMLElement ? rangeNode : rangeNode?.parentElement) ?? null;
    if (el && !isDrawn(el)) { setAnchorShown(false); setPos(null); return; }
    setAnchorShown(true);
    const r = anchorRange && el
      ? anchorRange.getBoundingClientRect()
      : el
      ? el.getBoundingClientRect()
      : anchorPoint
        ? ({ left: anchorPoint.x, top: anchorPoint.y, right: anchorPoint.x, bottom: anchorPoint.y, width: 0, height: 0 } as DOMRect)
        : null;
    if (!r) return;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    // The panel's natural height, not its painted one: the height clamp below
    // shrinks a tall panel to the band under the anchor, and measuring that
    // clamped height would always call 'below' a fit and never flip it.
    const panelH = panelRef.current?.scrollHeight ?? 0;
    // Collision: prefer requested placement, flip if it doesn't fit. 'over' never
    // flips — it IS the anchor's own position (replace-in-place), not a dropdown.
    let place = placement;
    if (place === 'below' && r.bottom + gap + panelH > vh && r.top - gap - panelH > 0) place = 'above';
    if (place === 'above' && r.top - gap - panelH < 0 && r.bottom + gap + panelH < vh) place = 'below';
    const top = place === 'over' ? r.top : place === 'above' ? Math.max(8, r.top - gap - panelH) : r.bottom + gap;
    // Horizontal collision: keep the whole panel on screen. An anchor near the
    // right edge shifts the panel left instead of clipping it ('over' excepted).
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const panelW = panelRef.current?.offsetWidth ?? 0;
    const left = place === 'over' ? r.left : Math.max(8, Math.min(r.left, vw - panelW - 8));
    setPos({ left, top, placement: place, anchorW: r.width });
  }, [anchorRef, anchorRange, anchorPoint, placement, gap]);

  React.useLayoutEffect(() => {
    if (!open) { setPos(null); setDragPos(null); return; }
    measure();
    // measureKey (camera/snapshot identity) is a dep below: a transform-only anchor
    // move (canvas pan/zoom) fires no scroll/resize/RO, so the key re-runs this effect.
    const onScroll = () => measure();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    // Observe BOTH the anchor (size/position) AND the panel itself — the panel's
    // height is 0 on the first measure, so a `placement: 'above'` overlay would
    // mis-place until its real height is known. Re-measuring when the panel
    // resolves its height fixes that without a flash.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure()) : null;
    if (ro && anchorRef?.current) ro.observe(anchorRef.current);
    if (ro && anchorRange) {
      const node = anchorRange.commonAncestorContainer;
      const el = node instanceof HTMLElement ? node : node.parentElement;
      if (el) ro.observe(el);
    }
    if (ro && panelRef.current) ro.observe(panelRef.current);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      ro?.disconnect();
    };
  }, [open, measure, anchorRef, anchorRange, measureKey]);

  if (!open || typeof document === 'undefined') return null;
  // Until the anchor is measured (or the user has dragged), the panel has NO real
  // position. Painting it at (0,0) is never correct for ANY consumer — an overlay
  // whose anchor element isn't in the DOM would fly to the window's top-left corner
  // (incident 2026-07-19: the composer landed over the traffic lights). Better hidden
  // until measured than shown at the wrong place: keep it in the DOM (so panelRef can
  // measure its own height) but visually hidden + inert until it has a real position.
  // A correctly-anchored overlay measures in the same layout pass (useLayoutEffect →
  // synchronous re-render before paint), so this never flashes for the happy path; it
  // only ever suppresses the pathological unanchored (0,0) render. (L063 category kill.)
  const anchored = anchorShown && (dragPos !== null || pos !== null);
  const left = dragPos?.left ?? pos?.left ?? 0;
  const top = dragPos?.top ?? pos?.top ?? 0;
  // Available vertical band for the panel (so a tall panel scrolls, never clips).
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const maxHeight = Math.max(120, vh - top - 8);

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragState.current = { dx: e.clientX - left, dy: e.clientY - top };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    if (!dragState.current) return;
    setDragPos({ left: e.clientX - dragState.current.dx, top: e.clientY - dragState.current.dy });
  };
  const endDrag = () => { dragState.current = null; };

  return createPortal(
    <>
      {onDismiss ? (
        <div
          aria-hidden
          style={{ position: 'fixed', inset: 0, zIndex: LAYER_ORDER.menu - 1 }}
          onPointerDown={(e) => {
            if (dismissPreservesSelection) e.preventDefault();
            onDismiss();
          }}
        />
      ) : null}
      <div
        ref={panelRef}
        {...(flagAttr ? { [flagAttr]: '' } : {})}
        // Every floating overlay carries a shared membership marker so a host that
        // owns a multi-layer session (e.g. a rich-text editor whose toolbar + paint
        // panel + their nested popovers all portal to <body>) can ask ONE question —
        // "did focus settle inside any floating layer?" — instead of enumerating each
        // panel's own flag. Dissolves the class of "a nested popover steals focus and
        // collapses the session" bugs (L063).
        data-floating-layer=""
        style={{
          position: 'fixed',
          left,
          top,
          // Unseen + inert until the anchor is measured — never paint at (0,0). Unseen by opacity, not visibility:
          // an input inside that focuses itself as it mounts (Ask AI) mounts before its first measure, and an
          // element under visibility:hidden refuses focus, so the words typed next would go nowhere.
          // Not drawn at all (visibility:hidden, focus let go) while the anchor itself is not drawn (invariant 6).
          visibility: anchorShown ? undefined : 'hidden',
          opacity: anchored ? undefined : 0,
          pointerEvents: anchored ? undefined : 'none',
          zIndex: LAYER_ORDER.menu,
          maxHeight,
          overflowY: contentOwnsScroll ? 'visible' : 'auto',
          ...({ '--anchored-overlay-max-height': `${maxHeight}px` } as React.CSSProperties),
          minWidth: matchAnchorWidth ? (pos?.anchorW ?? undefined) : undefined,
          // #2/#7 (L063): an opaque menu surface by default — a popover is never
          // transparent. NO border here (only bg + radius + float shadow) so a
          // self-surfaced child's own border never doubles.
          ...(surface
            ? {
                background: 'var(--black-rich)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: '0 12px 32px rgba(0,0,0,0.36)',
              }
            : {}),
        }}
        // Keep all interaction inside the panel — never start a canvas drag.
        onPointerDown={(e) => e.stopPropagation()}
      >
        {draggable ? (
          <div
            onPointerDown={startDrag}
            onPointerMove={onDragMove}
            onPointerUp={endDrag}
            style={{ cursor: 'grab', userSelect: 'none', touchAction: 'none', backgroundColor: 'var(--black-rich)', color: 'var(--text-primary)', borderTopLeftRadius: 'var(--radius-lg)', borderTopRightRadius: 'var(--radius-lg)' }}
            className="flex items-center gap-2 rounded-t-lg border-b border-[var(--border-primary)] px-3 py-1.5 text-xs"
          >
            <span className="opacity-50">⠿</span>
            {title ? <span className="font-medium">{title}</span> : null}
          </div>
        ) : null}
        {children}
      </div>
    </>,
    document.body,
  );
}
