// packages/ui/show/canvas-minimap/CanvasMinimap.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Generic minimap for any 2D node canvas: a scaled-down overview of every
// node frame plus the visible viewport rectangle, with click/drag-to-jump.
// The wayfinding affordance large canvases need (FigJam, n8n, every serious
// spatial tool) — without it, hundreds of nodes are an unnavigable wall.
//
// Pure Physics: node frames + camera in, recentering camera intents out.
// Zero domain vocabulary; node identity is opaque.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO application vocabulary — frames are anonymous rectangles.
// 2. All color via design tokens. Inline style is computed geometry only.
// 3. The minimap never mutates camera state — it emits `onJump(worldX, worldY)`
//    (the world point that should land at the viewport center) and the caller
//    owns the camera.
// 4. Cheap at any scale: one absolutely-positioned div per node, no SVG paths.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useCallback, useMemo, useRef } from 'react';

export interface CanvasMinimapFrame {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasMinimapProps {
  /** All node frames in world-space. */
  frames: readonly CanvasMinimapFrame[];
  /** Camera pan X/Y in screen pixels and zoom multiplier. */
  panX: number;
  panY: number;
  zoom: number;
  /** Size of the visible canvas viewport in screen pixels. */
  viewportWidth: number;
  viewportHeight: number;
  /** Minimap box size in pixels (default 168x112). */
  width?: number;
  height?: number;
  /** Optional id of the highlighted (selected) frame. */
  selectedId?: string | null;
  /** Called with the world point that should become the viewport center. */
  onJump?: (worldX: number, worldY: number) => void;
  /** Float as a framed panel pinned to a corner of the relative parent. */
  corner?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

const CORNER_INSET: Record<NonNullable<CanvasMinimapProps['corner']>, React.CSSProperties> = {
  'top-left': { top: 12, left: 12 },
  'top-right': { top: 12, right: 12 },
  'bottom-left': { bottom: 12, left: 12 },
  'bottom-right': { bottom: 12, right: 12 },
};

const MINIMAP_PADDING = 8;

/**
 * Scaled overview of the world: every frame as a dot-rectangle plus the
 * camera viewport as an outlined window. Click anywhere to jump there.
 */
export const CanvasMinimap: React.FC<CanvasMinimapProps> = ({
  frames,
  panX,
  panY,
  zoom,
  viewportWidth,
  viewportHeight,
  width = 168,
  height = 112,
  selectedId = null,
  onJump,
  corner,
}) => {
  const boxRef = useRef<HTMLDivElement>(null);

  // World bounds covering every frame AND the visible viewport window so the
  // viewport rectangle never clips out of the minimap while panning empty space.
  const world = useMemo(() => {
    const viewLeft = -panX / zoom;
    const viewTop = -panY / zoom;
    const viewRight = viewLeft + viewportWidth / zoom;
    const viewBottom = viewTop + viewportHeight / zoom;
    let minX = viewLeft;
    let minY = viewTop;
    let maxX = viewRight;
    let maxY = viewBottom;
    for (const frame of frames) {
      minX = Math.min(minX, frame.x);
      minY = Math.min(minY, frame.y);
      maxX = Math.max(maxX, frame.x + frame.width);
      maxY = Math.max(maxY, frame.y + frame.height);
    }
    return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }, [frames, panX, panY, zoom, viewportWidth, viewportHeight]);

  const scale = Math.min(
    (width - MINIMAP_PADDING * 2) / world.width,
    (height - MINIMAP_PADDING * 2) / world.height,
  );

  const toMini = useCallback(
    (worldX: number, worldY: number) => ({
      x: MINIMAP_PADDING + (worldX - world.minX) * scale,
      y: MINIMAP_PADDING + (worldY - world.minY) * scale,
    }),
    [world, scale],
  );

  const viewport = useMemo(() => {
    const topLeft = toMini(-panX / zoom, -panY / zoom);
    return {
      ...topLeft,
      width: (viewportWidth / zoom) * scale,
      height: (viewportHeight / zoom) * scale,
    };
  }, [toMini, panX, panY, zoom, viewportWidth, viewportHeight, scale]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (!onJump || !boxRef.current) return;
    const rect = boxRef.current.getBoundingClientRect();
    const jumpTo = (clientX: number, clientY: number) => {
      const miniX = clientX - rect.left;
      const miniY = clientY - rect.top;
      onJump(
        world.minX + (miniX - MINIMAP_PADDING) / scale,
        world.minY + (miniY - MINIMAP_PADDING) / scale,
      );
    };
    jumpTo(event.clientX, event.clientY);
    const handleMove = (moveEvent: PointerEvent) => jumpTo(moveEvent.clientX, moveEvent.clientY);
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }, [onJump, world, scale]);

  const box = (
    <div
      ref={boxRef}
      data-canvas-minimap="true"
      role="img"
      aria-label="Overview map"
      onPointerDown={handlePointerDown}
      onClick={(event) => event.stopPropagation()}
      style={{
        position: 'relative',
        width: `${width}px`,
        height: `${height}px`,
        cursor: onJump ? 'pointer' : 'default',
        overflow: 'hidden',
        borderRadius: 'var(--radius-default, 8px)',
      }}
    >
      {frames.map((frame) => {
        const position = toMini(frame.x, frame.y);
        return (
          <div
            key={frame.id}
            style={{
              position: 'absolute',
              left: `${position.x}px`,
              top: `${position.y}px`,
              width: `${Math.max(2, frame.width * scale)}px`,
              height: `${Math.max(2, frame.height * scale)}px`,
              borderRadius: '2px',
              backgroundColor: frame.id === selectedId
                ? 'var(--accent-primary)'
                : 'var(--text-tertiary)',
              opacity: frame.id === selectedId ? 0.95 : 0.55,
            }}
          />
        );
      })}
      <div
        style={{
          position: 'absolute',
          left: `${viewport.x}px`,
          top: `${viewport.y}px`,
          width: `${viewport.width}px`,
          height: `${viewport.height}px`,
          border: '1px solid var(--accent-primary)',
          borderRadius: '3px',
          backgroundColor: 'transparent',
          pointerEvents: 'none',
        }}
      />
    </div>
  );

  if (!corner) return box;
  return (
    <div
      style={{
        position: 'absolute',
        ...CORNER_INSET[corner],
        zIndex: 40,
        padding: 6,
        borderRadius: 'var(--radius-lg, 12px)',
        backgroundColor: 'var(--surface-overlay, var(--surface-secondary, rgba(20,20,24,0.92)))',
        border: '1px solid var(--border-primary)',
        boxShadow: 'var(--shadow-md, 0 6px 20px rgba(0,0,0,0.22))',
      }}
    >
      {box}
    </div>
  );
};
