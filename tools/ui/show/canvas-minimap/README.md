# canvas-minimap

Generic minimap overview + viewport window + click-to-jump for any 2D node canvas.

## Files

| File | Purpose |
|------|---------|
| `CanvasMinimap.tsx` | Scaled world overview with frames, viewport rectangle, and jump intent. |
| `DotPlacementMap.tsx` | Items drawn as dots; click anywhere (between/around dots) to choose a world point. Keyboard press chooses the centre. |
| `index.ts` | Barrel export. |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `CanvasMinimap` | `({ frames, panX, panY, zoom, viewportWidth, viewportHeight, width?, height?, selectedId?, onJump?, corner? }) => JSX` | The overview map. Emits `onJump(worldX, worldY)`; never owns camera state. `corner` floats it as a framed panel pinned to a corner of the relative parent (unset → inline). |
| `DotPlacementMap` | `({ frames, worldWidth, worldHeight, width?, height?, value?, highlightId?, onPlace, ariaLabel }) => JSX` | Point picker over a dot map; emits `onPlace({x,y})`, owns only hover state. |
| `CanvasMinimapFrame` | `{ id, x, y, width, height }` | One anonymous world-space rectangle. |

## Dependencies

**Depends on:** React only. Colors via `--accent-primary` / `--text-tertiary` tokens.
**Depended on by:** `workflow-canvas`; the group/vision-board board (bottom-right overview); any graph/canvas package with large inventories.
