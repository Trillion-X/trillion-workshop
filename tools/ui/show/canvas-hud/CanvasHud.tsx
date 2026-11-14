// packages/ui/show/canvas-hud/CanvasHud.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The blind on-canvas heads-up controls: a glassmorphic pill with zoom-out,
// the live zoom %, zoom-in, a "fit to view" button, and a minimap toggle. It is
// pure chrome — it knows NOTHING about nodes, slots, pages, packages, or any
// Society vocabulary. It receives a number (the zoom %) and a handful of
// callbacks, and it renders buttons that call them. The consumer owns every
// camera computation (B-46 `do-work/build-float-transaction.ts`).
//
// Reference anatomy (Mobbin MCP 2026-06-23): GitBook / Slite / Craft bottom-left
// zoom pill `[−] [zoom%] [+]`; Fibery / Asana strategy-map HUD with a
// "Fit to view" button + a "Map" (minimap) toggle. The % readout is the badge
// on the "Reset to 100%" item — pressing it resets to actual size, matching
// Figma/Miro. Every control is one item of the shared ui ExpandableTabs
// toolbar, so each shows its name when pointed at, like every icon group.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic / blind: no node-type knowledge, no Society vocabulary, no enums of
//    domain concepts. Props are a number + callbacks. Adding a control = adding a
//    prop here + composing a pure camera fn in the consumer, never a backend type.
// 2. The HUD floats over the canvas on a chrome layer; the pill itself captures
//    the pointer (`pointer-events-auto`) while its wrapper is transparent, so the
//    canvas stays interactive everywhere the pill is not.
// 3. Stateless: the active/inactive look of the minimap toggle is driven purely by
//    the `minimapOn` prop. The HUD holds no state of its own.
//
// =============================================================================
// AI ASSISTANT DIRECTIVE
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

'use client';

import * as React from 'react';

import { cn } from '../cn';
import { GLASS_POPOVER_BG_CLASS } from '../glass-tokens';
import { ExpandableTabs } from '../expandable-tabs';

export interface CanvasHudProps {
  /** The current zoom as a whole-number percent (e.g. 100, 308). The consumer
   *  rounds `camera.zoom * 100`; the HUD only displays it. */
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Reset to 100% / actual size — fired by clicking the % readout. */
  onResetZoom: () => void;
  /** Fit all content into the viewport. */
  onFit: () => void;
  /** Whether the minimap is currently shown (drives the toggle's active look). */
  minimapOn: boolean;
  onToggleMinimap: () => void;
  /** Optional disabled state for the zoom-in/out ends when a limit is reached. */
  canZoomIn?: boolean;
  canZoomOut?: boolean;
  className?: string;
}

/**
 * The on-canvas zoom + minimap HUD. Blind chrome — a number in, callbacks out.
 */
export function CanvasHud({
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onFit,
  minimapOn,
  onToggleMinimap,
  canZoomIn = true,
  canZoomOut = true,
  className,
}: CanvasHudProps) {
  // The control surface is canvas chrome; it owns its own pointer region so a
  // press on a control never falls through to a pan/select on the plane below.
  return (
    <ExpandableTabs
      mode="action"
      size="sm"
      ariaLabel="Canvas view controls"
      className={cn('pointer-events-auto', GLASS_POPOVER_BG_CLASS, 'shadow-[0_8px_28px_rgba(0,0,0,0.32)] backdrop-blur-xl', className)}
      items={[
        { id: 'zoom-out', label: 'Zoom out', icon: 'Minus', disabled: !canZoomOut },
        { id: 'reset', label: 'Reset to 100%', icon: 'Scan', badge: `${Math.round(zoomPercent)}%` },
        { id: 'zoom-in', label: 'Zoom in', icon: 'Plus', disabled: !canZoomIn },
        { type: 'separator', id: 'view' },
        { id: 'fit', label: 'Fit to view', icon: 'Maximize' },
        { id: 'minimap', label: minimapOn ? 'Hide minimap' : 'Show minimap', icon: 'Map', pinned: minimapOn },
      ]}
      onSelect={(id) => ({ 'zoom-out': onZoomOut, reset: onResetZoom, 'zoom-in': onZoomIn, fit: onFit, minimap: onToggleMinimap } as Record<string, () => void>)[id]?.()}
    />
  );
}
