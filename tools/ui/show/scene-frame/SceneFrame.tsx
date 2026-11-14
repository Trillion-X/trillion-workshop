// packages/ui/show/scene-frame/SceneFrame.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The blind scene-frame primitive: positions a child at an engine-computed
// rect (absolute x/y/w plus min-height). Used by surfaces that render a
// layout-engine snapshot (composition scenes, canvas nodes) where the rect
// is AUTHORITY OUTPUT, not styling. Optionally acts as a hover-reveal group
// so per-frame chrome (handles, actions) can fade in on hover.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic and blind: knows nothing about what the frame contains.
// 2. The rect comes from a layout engine — this component NEVER computes
//    or adjusts layout; it only applies the given rect.
// 3. No visual styling beyond positioning: no background, border, shadow.
// 4. `data-node-id` passthrough for testing/diagnostics.
//
// =============================================================================
// AI ASSISTANT DIRECTIVE
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';

import { cn } from '../cn';

export type SceneFrameRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type SceneFrameProps = {
  /** Engine-computed rect. Absent = unpositioned (engine has not placed it). */
  rect?: SceneFrameRect;
  /**
   * How the engine rect's height is applied:
   * - 'hug' (default): rect.h becomes `minHeight` — the frame grows past the
   *   engine floor as its content needs (correct for auto-sizing Text nodes the
   *   engine gives a minimum to).
   * - 'fill': rect.h becomes a DEFINITE `height` and the frame clips to it — the
   *   frame is exactly the engine-decided box. This is REQUIRED when the child
   *   is a mounted live surface that fills with `height:100%`: a percentage
   *   height only resolves against an ancestor with a definite height, so under
   *   'hug' (`minHeight` only) the surface collapses to ~0 (invisible, can't be
   *   resized, receives no pointer events). Every SceneFrame is absolutely
   *   positioned, so this is local to the frame — no ancestor needs to change.
   */
  fit?: 'hug' | 'fill';
  /** Hover-reveal group: per-frame chrome inside fades in on hover/focus. */
  hoverReveal?: boolean;
  /** Subtle outlined surface (placeholder/component frames). Default: invisible. */
  outlined?: boolean;
  /** Children don't receive pointer events (pure visual group). */
  passthrough?: boolean;
  /** Selected chrome: translucent accent fill + hairline accent ring (block-selection
   *  idiom — a bare 1px outline on a dark surface reads as NOTHING, so escalating
   *  select-all looked like it "unselected" when the native text highlight cleared). */
  selected?: boolean;
  nodeId?: string;
  className?: string;
  /** Generic activation callback (pointer click on the frame). */
  onActivate?: () => void;
  children: React.ReactNode;
};

export function SceneFrame({ rect, fit = 'hug', hoverReveal, outlined, passthrough, selected, nodeId, className, onActivate, children }: SceneFrameProps) {
  const fill = fit === 'fill';
  return (
    <div
      data-node-id={nodeId}
      onClick={onActivate ? (event) => {
        event.stopPropagation();
        onActivate();
      } : undefined}
      className={cn(
        'absolute box-border',
        hoverReveal && 'group/hover-reveal',
        outlined && 'rounded-2xl border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)]',
        // 'hug' placeholders center their label.
        outlined && !fill && 'grid place-items-center',
        // A 'fill' frame must NOT clip: the mounted surface carries its own
        // inset-fill clipping layer (FloatingMaterialFrame `mode:'fill'`), and
        // clipping here would eat the authoring chrome that lives at the frame's
        // edges — the resize handles (half-outside the box) and the live
        // dimension badge (above it). Content plane and chrome plane stay
        // separate (convergence 2026-06-20, F3/F4).
        passthrough && 'pointer-events-none',
        className,
      )}
      style={{
        ...(rect ? {
          left: rect.x,
          top: rect.y,
          width: rect.w,
          // 'fill' = the engine rect is the exact box (definite height so a
          // height:100% mounted surface can fill it); 'hug' = floor only.
          ...(fill ? { height: rect.h } : { minHeight: rect.h }),
        } : {}),
        // Selection = a translucent accent WASH only (Notion block-select: selected
        // blocks read as HIGHLIGHTED CONTENT — a soft fill like a text highlight —
        // never as bordered input fields; a ring/outline made every block "look like
        // an input", user-rejected). color-mix from the theme accent so any
        // screen-look retints it. INLINE (not utility classes) because the product
        // stylesheet is a compiled record — a class this primitive newly references
        // may not exist in an older compiled stylesheet and silently paints nothing
        // (live-proven: outline-1 without an outline-style utility computed to
        // outline-style:none = zero paint). Inline style depends on nothing.
        ...(selected ? {
          borderRadius: 4,
          backgroundColor: 'color-mix(in srgb, var(--accent-blue, #4c8dff) 17%, transparent)',
        } : {}),
      }}
    >
      {children}
    </div>
  );
}
