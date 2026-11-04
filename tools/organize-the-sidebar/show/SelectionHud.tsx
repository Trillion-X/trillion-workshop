// packages/group/show/SelectionHud.tsx
//
// The selection dimension HUD — a blind read-only overlay (L090). Given the
// selection's world bounds + a label, it draws a small pill below the bounds
// (Figma/FigJam canon: the `W × H` readout while you size things, `N selected`
// while you grab a group). It knows nothing about items or selection state — the
// board computes the label from live data and hands it over.
//
// Rendered INSIDE the world transform so it tracks the selection in world space;
// font/padding are scaled by `1/zoom` so the pill stays a constant size on screen
// at any zoom (same counter-scale trick as the resize handles / SnapGuideLayer).
// Raw SVG is the irreducible canvas-geometry primitive (ConnectorLayer precedent).

import React from 'react';

export interface HudBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SelectionHudProps {
  bounds: HudBounds | null;
  label: string;
  zoom: number;
}

export function SelectionHud({ bounds, label, zoom }: SelectionHudProps) {
  if (!bounds || !label) return null;
  const k = 1 / Math.max(zoom, 0.0001); // world units per screen pixel
  const fontSize = 12 * k;
  const padX = 8 * k;
  const padY = 4 * k;
  const gap = 10 * k; // distance below the bounds
  // Estimate the pill width from the label length (same heuristic as the connector
  // label chip) — monospace-ish 0.62em per char + horizontal padding.
  const textW = label.length * fontSize * 0.62;
  const pillW = textW + padX * 2;
  const pillH = fontSize + padY * 2;
  const cx = bounds.x + bounds.w / 2;
  const top = bounds.y + bounds.h + gap;
  const midY = top + pillH / 2;
  return (
    <svg
      aria-hidden
      style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}
    >
      <rect
        x={cx - pillW / 2}
        y={top}
        width={pillW}
        height={pillH}
        rx={6 * k}
        fill="var(--surface-inverse, #1f2937)"
      />
      <text
        x={cx}
        y={midY}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={fontSize}
        fill="var(--text-on-inverse, #f9fafb)"
      >
        {label}
      </text>
    </svg>
  );
}
