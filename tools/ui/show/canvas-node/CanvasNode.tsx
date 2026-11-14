// frontends/web/src/packages/ui/canvas-node/CanvasNode.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Physics-layer canvas node wrapper. Provides absolute world-space positioning
// for nodes rendered on any 2D canvas (workflow graphs, entity relationship
// diagrams, org charts, dependency trees). Zero domain vocabulary.
//
// The world-space coordinate system: nodes are positioned via CSS transform
// translate(x, y). The canvas world layer applies its own pan/zoom transform;
// node (x, y) are in world-space coordinates, not screen-space.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO domain vocabulary — no "workflow", "step", or Society concepts
// 2. Position is set via transform, not top/left (avoids layout reflow)
// 3. willChange is managed via the `isDragging` prop (compositor promotion)
// 4. Pointer events for drag + click delegated entirely to children via callbacks
// 5. This is a Physics primitive — it only knows coordinates and pointer events
// 6. The entrance animation (appearDelayMs) is captured ONCE at mount and never
//    restarts on re-render — a node animates in exactly when it first appears.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { forwardRef, useEffect, useRef } from 'react';
import { RESIZE_EDGES, RESIZE_CURSOR, type ResizeEdge } from './resize-geometry';
import { NODE_REF_ATTR, serializeNodeRef, type NodeRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/node-ref.ts';

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

/** Hit-area thickness (px) of the invisible edge/corner resize strips. */
const RESIZE_HIT = 9;

/** Absolute position for one invisible resize strip (no visible chrome — the
 *  cursor on hover is the only affordance; modern infer-to-grab). */
function resizeStripStyle(edge: ResizeEdge): React.CSSProperties {
  const T = RESIZE_HIT;
  const base: React.CSSProperties = {
    position: 'absolute',
    cursor: RESIZE_CURSOR[edge],
    touchAction: 'none',
    // corners sit above edges so a corner grab wins the overlap
    zIndex: edge.length === 2 ? 2 : 1,
  };
  const hasN = edge.includes('n'); const hasS = edge.includes('s');
  const hasE = edge.includes('e'); const hasW = edge.includes('w');
  const corner = edge.length === 2;
  if (hasN) base.top = 0; if (hasS) base.bottom = 0;
  if (hasE) base.right = 0; if (hasW) base.left = 0;
  if (edge === 'n' || edge === 's') { base.left = T; base.right = T; base.height = T; }
  else if (edge === 'e' || edge === 'w') { base.top = T; base.bottom = T; base.width = T; }
  else if (corner) { base.width = T; base.height = T; }
  return base;
}

export interface CanvasNodeProps {
  /** World-space X position (top-left of bounding box) */
  x: number;
  /** World-space Y position (top-left of bounding box) */
  y: number;
  /** Node bounding box width in pixels */
  width: number;
  /** Node bounding box height in pixels */
  height: number;
  /** Rotation in degrees about the node's CENTER (transform-origin defaults to
   *  center). Absent/0 → no rotation (the transform stays a pure translate, so every
   *  existing consumer is unchanged). */
  rotation?: number;
  /** Mirror the node about its vertical axis (horizontal flip) — a `scale(-1,1)` in
   *  the node's own frame, applied AFTER rotation. Pure Physics geometry, same class
   *  as `rotation`. Absent/false → no x-mirror (every existing consumer unchanged). */
  flipX?: boolean;
  /** Mirror the node about its horizontal axis (vertical flip) — a `scale(1,-1)` in
   *  the node's own frame, applied AFTER rotation. Absent/false → no y-mirror. */
  flipY?: boolean;
  /** Content opacity in [0,1] — fades ONLY the node's content (children), never the
   *  selection ring / resize handles / corner adornment, so a faded node is still
   *  clearly selectable. Absent or ≥1 → fully opaque (no style emitted). */
  opacity?: number;
  /** CSS `clip-path` applied to the node's CONTENT (not the ring/handles) — clips a
   *  rectangular item into a geometric shape (ellipse/diamond/…). Opaque string from
   *  a feature-owned catalog; CanvasNode never enumerates shapes. Absent/'' → no clip
   *  (rectangle), so every existing consumer is unchanged. */
  clipPath?: string;
  /** When true, promotes to compositor layer via willChange: transform */
  isDragging?: boolean;
  /** Cursor style — 'grab' at rest, 'grabbing' during drag */
  cursor?: 'grab' | 'grabbing' | 'default' | 'pointer';
  children: React.ReactNode;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** Optional keyboard activation owned by the caller. Pair with `tabIndex` and
   *  an interactive `ariaRole`; CanvasNode never invents widget semantics. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /** Double-click / -tap — a generic node activation (e.g. open/drill into a node). */
  onDoubleClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** Context-menu (right-click / long-press) — a generic node secondary action
   *  (e.g. open the node's settings/editor). The caller owns the intent. */
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** When provided, 8 INVISIBLE edge/corner resize strips are rendered; pointer-down
   *  on one fires this with the grabbed `edge` (the caller owns the resize-drag math
   *  via `applyResizeGeom`, which needs the canvas zoom). Each strip stops propagation
   *  so it never starts a node drag, and shows only a cursor on hover — no visible
   *  handle chrome (modern infer-to-grab). Absent → not resizable. */
  onResizeStart?: (e: React.PointerEvent<HTMLDivElement>, edge: ResizeEdge) => void;
  /** When set (>= 0), the node plays a one-time entrance (fade + rise) on mount
   *  after this delay in ms. A batch of nodes that mount together pass increasing
   *  delays so they CASCADE in piece-by-piece instead of popping all at once.
   *  Captured at mount — later prop changes never restart it. Absent → instant.
   *  Honors `prefers-reduced-motion`. Pure Physics: "a node appears". */
  appearDelayMs?: number;
  /** The universal addressed handle for this node. When set, the node stamps
   *  `data-node-ref` (NODE_REF_ATTR) on its root element so the generic layers —
   *  marquee selection (refsInRect), the node context menu, the drop-intent
   *  router — can find and address it WITHOUT the surface wiring per-node hit
   *  tests. This is the one contract from node-actions/node-ref.ts. Absent → the
   *  node is invisible to those generic layers. */
  nodeRef?: NodeRef;
  /** Data-only host annotations for generic layers such as selection responses. Only `data-*` names are emitted. */
  dataAttributes?: Readonly<Record<`data-${string}`, string>>;
  /** Selection chrome lives HERE — on the generic node wrapper — so every node
   *  type (note, image, section, future) shows the SAME crisp accent ring when
   *  selected (Figma/Miro/FigJam canon), and a renderer NEVER expresses selection
   *  by changing its own background (which reads as "the card vanished"). The ring
   *  is an overlay: it never shifts layout and never eats pointer events. */
  selected?: boolean;
  /** A small node supplied by the caller and pinned just above the top-right corner (never over the node's own
   *  content) — a lock badge or a record's state, for example. The wrapper renders it as a non-interactive overlay
   *  that never shifts layout and owns no meaning of its own. Absent → nothing. */
  cornerAdornment?: React.ReactNode;
  /** Like `cornerAdornment`, but INTERACTIVE and pinned to the bottom-left corner —
   *  a clickable control such as an "open source link" chip. Unlike `cornerAdornment`
   *  this overlay receives pointer events and is NOT aria-hidden (it holds real
   *  controls). The caller's control must stop propagation if it should not also
   *  start a node drag/select. Absent → nothing. */
  cornerActions?: React.ReactNode;
  /** Connection points on the node's edges (typed ports, as a node editor draws them): each a dot at a fraction
   *  (`at`, 0..1) along one side, in its port's colour, so a line that ends there visibly lands on it. A side is
   *  one of a box's four edges (Physics: a rectangle has exactly four). */
  ports?: ReadonlyArray<{ side: 'left' | 'right' | 'top' | 'bottom'; at: number; color?: string; title?: string }>;
  /** The accessible NAME a screen reader announces for this node (e.g. "Note: buy milk"). Absent →
   *  the node has no accessible name (an anonymous positioned box). Paired with {@link ariaRole}. */
  ariaLabel?: string;
  /** The ARIA role for the node root (e.g. "group" for a composite board item). Absent → the div's
   *  implicit generic role. Kept caller-driven so the wrapper never assumes a widget semantic it
   *  can't fulfil via keyboard (the board's keys are taken); "group" just names a labelled region. */
  ariaRole?: string;
  /** Caller-owned keyboard focus participation. Absent keeps existing canvases unchanged. */
  tabIndex?: number;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Absolute-positioned canvas node wrapper.
 *
 * Renders as a `div` with `position: absolute` and `transform: translate(x, y)`.
 * All visual chrome lives in children — this component is pure Physics layout.
 *
 * @example
 * ```tsx
 * <CanvasNode x={node.x} y={node.y} width={180} height={72} isDragging={!!offset}>
 *   <Card variant="nested">...</Card>
 * </CanvasNode>
 * ```
 */
export const CanvasNode = forwardRef<HTMLDivElement, CanvasNodeProps>(
  (
    {
      x,
      y,
      width,
      height,
      isDragging = false,
      cursor = 'grab',
      children,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onClick,
      onKeyDown,
      onDoubleClick,
      onContextMenu,
      onResizeStart,
      appearDelayMs,
      nodeRef,
      dataAttributes,
      selected = false,
      cornerAdornment,
      cornerActions,
      ports,
      ariaLabel,
      ariaRole,
      tabIndex,
      rotation,
      flipX,
      flipY,
      opacity,
      clipPath,
    },
    ref,
  ) => {
    // Entrance is captured ONCE at mount (invariant 6) — a node animates in exactly
    // when it first appears, and re-renders never restart or cancel it.
    const enterRef = useRef<HTMLDivElement>(null);
    const initialDelayRef = useRef(appearDelayMs);
    useEffect(() => {
      const delay = initialDelayRef.current;
      if (delay === undefined) return;
      const el = enterRef.current;
      if (!el || typeof el.animate !== 'function') return; // jsdom / unsupported → instant
      if (typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
      const anim = el.animate(
        [
          { transform: 'translateY(8px) scale(0.985)' },
          { transform: 'translateY(0) scale(1)' },
        ],
        // Keep content visible even when a background webview pauses its timeline
        // at time zero. Entrance motion must never gate access to the card.
        { duration: 260, delay: Math.max(0, delay), easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'backwards' },
      );
      return () => anim.cancel();
    }, []);
    return (
    <div
      ref={ref}
      data-graph-node
      {...Object.fromEntries(Object.entries(dataAttributes ?? {}).filter(([name, value]) => name.startsWith('data-') && typeof value === 'string'))}
      {...(nodeRef ? { [NODE_REF_ATTR]: serializeNodeRef(nodeRef) } : {})}
      {...(ariaRole ? { role: ariaRole } : {})}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      {...(tabIndex !== undefined ? { tabIndex } : {})}
      style={{
        position: 'absolute',
        // translate → rotate → scale. The flip `scale(±1)` is applied in the node's
        // local frame (after rotation in CSS right-to-left order); the caller negates
        // the stored rotation when it toggles a flip so the result is the true axis
        // mirror M·R(θ) = R(−θ)·M (see batch-actions `flipItems`).
        transform: `translate(${x}px, ${y}px)${rotation ? ` rotate(${rotation}deg)` : ''}${
          flipX || flipY ? ` scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})` : ''
        }`,
        width,
        height,
        willChange: isDragging ? 'transform' : 'auto',
        cursor,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <div
        ref={enterRef}
        style={{
          width: '100%',
          height: '100%',
          ...(typeof opacity === 'number' && opacity < 1 ? { opacity } : {}),
          // clipPath clips ONLY the content (fill + text), turning a rectangular
          // item into a geometric shape; the selection ring / handles live on the
          // OUTER node, so a shaped item stays crisply selectable. Opaque string —
          // CanvasNode never enumerates shapes (the catalog is feature DATA).
          ...(clipPath ? { clipPath } : {}),
        }}
      >
        {children}
      </div>
      {selected ? (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: -3,
            border: '2px solid var(--accent-primary)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: '0 0 0 4px color-mix(in srgb, var(--accent-primary) 22%, transparent)',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        />
      ) : null}
      {cornerAdornment ? (
        <div
          aria-hidden
          // Above the node's top-right corner, never over its words: a long state ("Doing · 3 of 8 done") on a
          // card with a long title would otherwise sit on top of the title.
          style={{
            position: 'absolute',
            bottom: '100%',
            right: 0,
            marginBottom: 4,
            pointerEvents: 'none',
            zIndex: 3,
          }}
        >
          {cornerAdornment}
        </div>
      ) : null}
      {ports?.map((port, index) => {
        const along = `${Math.min(1, Math.max(0, port.at)) * 100}%`;
        const place = port.side === 'left' ? { left: -5, top: along } : port.side === 'right' ? { right: -5, top: along } : port.side === 'top' ? { top: -5, left: along } : { bottom: -5, left: along };
        return (
          <div
            key={`port-${index}`}
            aria-hidden
            title={port.title}
            data-node-port={port.side}
            style={{
              position: 'absolute',
              ...place,
              width: 10,
              height: 10,
              marginTop: port.side === 'left' || port.side === 'right' ? -5 : 0,
              marginLeft: port.side === 'top' || port.side === 'bottom' ? -5 : 0,
              borderRadius: '50%',
              background: port.color ?? 'var(--t-font-color-tertiary, currentColor)',
              border: '2px solid var(--t-background-primary, white)',
              boxShadow: '0 0 0 1px color-mix(in srgb, currentColor 18%, transparent)',
              pointerEvents: 'none',
              zIndex: 3,
            }}
          />
        );
      })}
      {cornerActions ? (
        <div
          style={{
            position: 'absolute',
            bottom: 4,
            left: 4,
            pointerEvents: 'auto',
            zIndex: 3,
          }}
        >
          {cornerActions}
        </div>
      ) : null}
      {onResizeStart
        ? RESIZE_EDGES.map((edge) => (
            <div
              key={edge}
              data-graph-node-resize={edge}
              // Do NOT stop propagation here. The handler (onResizeStart) decides
              // whether to claim the gesture: if it starts a resize it stops the
              // event itself, preventing the node-root drag. If it declines (e.g.
              // a non-Move canvas tool, where the press should become a marquee or
              // pan), the event bubbles on through the node root to the stage. A
              // pre-emptive stop here would break that fall-through (dense-board
              // marquee starting over a resize strip).
              onPointerDown={(e) => onResizeStart(e, edge)}
              style={resizeStripStyle(edge)}
            />
          ))
        : null}
    </div>
    );
  },
);

CanvasNode.displayName = 'CanvasNode';
