# surface-swatch

A selectable preview tile of a canvas surface look (color + tile) — the building block of a "background" picker.

## Files

| File | Purpose |
|------|---------|
| `SurfaceSwatch.tsx` | A click-to-choose tile: a framed `CanvasSurface` miniature (the actual look, at zoom 1) with a label beneath and a check when selected. Blind to what it previews. |
| `index.ts` | Barrel export. |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `SurfaceSwatch` | `({ label, color?, tile?, selected?, onSelect }) => JSX` | A surface preview tile. The preview reuses `CanvasSurface`, so the swatch and the live canvas render identically by construction. |
| `SurfaceSwatchProps` | `{ label: string; color?: string; tile?: CanvasSurfaceTile; selected?: boolean; onSelect: () => void }` | Props. |

## Why this exists

Surface pickers (Craft/Miro/Mural "Background") let you choose by SEEING the surface, not reading a name. This is the shared tile for that, so feature packages compose it from their own surface catalog DATA instead of hand-rolling a swatch (and it never leaks into a single package).

## Dependencies

**Depends on:** `canvas-surface` (the preview), `icon`, `text`, `lucide-react`.
**Depended on by:** the group/vision-board board-background picker; any future surface picker.
