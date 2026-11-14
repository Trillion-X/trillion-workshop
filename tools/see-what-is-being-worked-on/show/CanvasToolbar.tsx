// packages/workflow-canvas/show/CanvasToolbar.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The canvas's bottom-left control cluster, as two grouped pills (Lindy/n8n
// anatomy): a history pill (↶ undo / ↷ redo) and a camera pill (zoom out /
// zoom in / fit, with the zoom percent as its badge / minimap), both the
// shared ui ExpandableTabs toolbar. Purely presentational — every control is
// a prop callback, so the surface owns all state and this component is trivially
// render-testable in isolation (offline harness proof for the goal loop).
//
// Reference (Mobbin / Lindy "Flow editor", 2026-06-20): the bottom toolbar is
// `Ask · + · ↶ · ↷ · sync · fit`; redo renders DISABLED when there is nothing to
// redo. We ship only the controls this canvas truly has — undo/redo and the
// camera — never dead Ask/sync buttons (L114/L117: no decoy affordances).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Container, ExpandableTabs } from '../../ui';

export interface CanvasToolbarProps {
  /** History (undo/redo) — disabled state mirrors the Lindy reference exactly. */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Camera. */
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  showMinimap: boolean;
  onToggleMinimap: () => void;
}

export const CanvasToolbar: React.FC<CanvasToolbarProps> = ({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onFit,
  showMinimap,
  onToggleMinimap,
}) => (
  <Container layout="horizontal" gap="xs" alignItems="center">
    {/* History and camera: two shared icon toolbars, like Lindy's grouped
        segments; each item shows its name when pointed at. */}
    <ExpandableTabs
      mode="action"
      size="sm"
      ariaLabel="History"
      items={[
        { id: 'undo', label: 'Undo', icon: 'Undo2', disabled: !canUndo },
        { id: 'redo', label: 'Redo', icon: 'Redo2', disabled: !canRedo },
      ]}
      onSelect={(id) => (id === 'undo' ? onUndo() : onRedo())}
    />
    <ExpandableTabs
      mode="action"
      size="sm"
      ariaLabel="Canvas view"
      items={[
        { id: 'zoom-out', label: 'Zoom out', icon: 'Minus' },
        { id: 'zoom-in', label: 'Zoom in', icon: 'Plus' },
        { id: 'fit', label: 'Fit everything', icon: 'Maximize2', badge: `${zoomPercent}%` },
        { id: 'map', label: showMinimap ? 'Hide map' : 'Show map', icon: 'Map', pinned: showMinimap },
      ]}
      onSelect={(id) => ({ 'zoom-out': onZoomOut, 'zoom-in': onZoomIn, fit: onFit, map: onToggleMinimap } as Record<string, () => void>)[id]?.()}
    />
  </Container>
);
