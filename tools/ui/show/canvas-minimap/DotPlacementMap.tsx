// packages/ui/show/canvas-minimap/DotPlacementMap.tsx
//
// Purpose: a small map of a 2D space that draws each item as a dot and lets the
// person click ANYWHERE (between, above, below, left or right of any dot) to
// choose a point. It is domain-blind: frames in, a world point out.
// Invariants: no camera or layout state is owned here; the chosen point is
// caller-owned (`value`). Keyboard activation chooses the centre of the space.

import * as React from 'react'
import { Button } from '../button'

export interface DotPlacementFrame { id: string; x: number; y: number; width: number; height: number }

export interface DotPlacementMapProps {
  frames: readonly DotPlacementFrame[]
  /** World-space size the frames live in. */
  worldWidth: number
  worldHeight: number
  /** Map size in pixels. */
  width?: number
  height?: number
  /** The currently chosen point, drawn as the placement marker. */
  value?: { x: number; y: number } | null
  /** Highlighted item id (e.g. the item being placed). */
  highlightId?: string | null
  onPlace: (point: { x: number; y: number }) => void
  ariaLabel: string
}

export function DotPlacementMap({ frames, worldWidth, worldHeight, width = 208, height = 128, value, highlightId, onPlace, ariaLabel }: DotPlacementMapProps) {
  const [hover, setHover] = React.useState<{ x: number; y: number } | null>(null)
  const scale = Math.min(width / Math.max(1, worldWidth), height / Math.max(1, worldHeight))
  const offsetX = (width - worldWidth * scale) / 2
  const offsetY = (height - worldHeight * scale) / 2
  const toWorld = (event: React.PointerEvent | React.MouseEvent) => {
    if (event.clientX === 0 && event.clientY === 0) return { x: worldWidth / 2, y: worldHeight / 2 }
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.min(worldWidth, Math.max(0, (event.clientX - rect.left - offsetX) / scale)),
      y: Math.min(worldHeight, Math.max(0, (event.clientY - rect.top - offsetY) / scale)),
    }
  }
  const marker = (point: { x: number; y: number }, strong: boolean) => (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--accent-primary,var(--text-primary))]"
      style={{ left: offsetX + point.x * scale, top: offsetY + point.y * scale, opacity: strong ? 1 : 0.45 }}
    />
  )
  return (
    <Button
      type="button"
      variant="plain"
      aria-label={ariaLabel}
      data-dot-placement-map
      className="relative block cursor-crosshair overflow-hidden rounded-md bg-[var(--glass-bg-subtle)] p-0 hover:bg-[var(--glass-bg-hover)]"
      style={{ width, height }}
      onPointerMove={(event) => setHover(toWorld(event))}
      onPointerLeave={() => setHover(null)}
      onClick={(event) => onPlace(toWorld(event))}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute rounded-sm border border-[var(--border-primary)]"
        style={{ left: offsetX, top: offsetY, width: worldWidth * scale, height: worldHeight * scale }}
      />
      {frames.map((frame) => (
        <span
          key={frame.id}
          aria-hidden="true"
          className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: offsetX + (frame.x + frame.width / 2) * scale,
            top: offsetY + (frame.y + frame.height / 2) * scale,
            backgroundColor: frame.id === highlightId ? 'var(--accent-primary, var(--text-primary))' : 'var(--text-muted, #8b8b8b)',
          }}
        />
      ))}
      {hover ? marker(hover, false) : null}
      {value ? marker(value, true) : null}
    </Button>
  )
}
