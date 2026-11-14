// packages/ui/show/edge-auto-hide/EdgeAutoHide.tsx
//
// Generic off-screen auto-hiding edge panel (U2). Wrap ANY content; when not
// pinned, it slides FULLY off the docked edge and a thin hotzone (+ the panel
// itself) reveals it on pointer-enter — position-aware for all four edges. The
// geometry lives in `edge-auto-hide-model` (pure); this component owns only the
// React state (hovering the edge / inside the panel) and the DOM wiring. Lifted
// + generalized from the customer sidebar-chrome mechanism (REVEAL_HOTZONE sensor +
// slide transform), decoupled from framer-motion and the Next.js tab context.
//
// All tunables are PROPS with sensible defaults (Society data the caller may
// override) — no magic numbers baked into behavior.

import React, { useState } from 'react';
import { cn } from '../cn';
import {
  edgeTransform,
  hotzoneStyle,
  panelAnchorStyle,
  isRevealed,
  type DockEdge,
} from './edge-auto-hide-model';

interface EdgeAutoHideProps {
  /** Which edge the panel docks to. */
  edge: DockEdge;
  /** Pinned = always docked + in normal layout flow (no auto-hide). */
  pinned?: boolean;
  /** Edge sensor thickness in px (how close to the edge reveals the panel). */
  hotzonePx?: number;
  /** Sliver of the panel left visible while hidden (px). 0 = fully off-screen. */
  peekPx?: number;
  /** Slide transition duration in ms. */
  transitionMs?: number;
  /** Stacking layer for the overlay panel + hotzone while unpinned. */
  zIndex?: number;
  /** The panel content (e.g. a sidebar). */
  children: React.ReactNode;
  /** className for the panel wrapper. */
  className?: string;
}

/**
 * @example
 * ```tsx
 * <EdgeAutoHide edge="left" pinned={pinned}>
 *   <DesktopSidebar ... />
 * </EdgeAutoHide>
 * ```
 */
function EdgeAutoHide({
  edge,
  pinned = false,
  hotzonePx = 28,
  peekPx = 0,
  transitionMs = 200,
  zIndex = 40,
  children,
  className,
}: EdgeAutoHideProps) {
  const [hoveringEdge, setHoveringEdge] = useState(false);
  const [insidePanel, setInsidePanel] = useState(false);
  const revealed = isRevealed({ pinned, hoveringEdge, insidePanel });

  // Pinned: the panel sits in normal flow (takes layout space, always shown).
  // Unpinned: it becomes a fixed overlay that slides off-screen — so the rest of
  // the app reclaims the full width when the sidebar is hidden.
  const panelStyle: React.CSSProperties = pinned
    ? { position: 'relative' }
    : {
        ...(panelAnchorStyle(edge) as React.CSSProperties),
        transform: edgeTransform(edge, revealed, peekPx),
        transition: `transform ${transitionMs}ms ease`,
        zIndex,
        willChange: 'transform',
      };

  return (
    <>
      {!pinned && (
        <div
          aria-hidden
          data-edge-auto-hide-hotzone={edge}
          className="pointer-events-auto"
          style={{ ...(hotzoneStyle(edge, hotzonePx) as React.CSSProperties), zIndex: zIndex - 1 }}
          onPointerEnter={() => setHoveringEdge(true)}
          onPointerLeave={() => {
            if (!insidePanel) setHoveringEdge(false);
          }}
        />
      )}
      <div
        data-edge-auto-hide-panel={edge}
        data-revealed={revealed ? 'true' : 'false'}
        className={cn('h-full', className)}
        style={panelStyle}
        onPointerEnter={() => {
          if (!pinned) {
            setInsidePanel(true);
            setHoveringEdge(true);
          }
        }}
        onPointerLeave={() => {
          if (!pinned) {
            setInsidePanel(false);
            setHoveringEdge(false);
          }
        }}
      >
        {children}
      </div>
    </>
  );
}

EdgeAutoHide.displayName = 'EdgeAutoHide';

export { EdgeAutoHide };
export type { EdgeAutoHideProps };
