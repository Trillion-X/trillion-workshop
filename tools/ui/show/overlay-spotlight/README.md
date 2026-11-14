# ui/show/overlay-spotlight — walkthrough occluder geometry (M1)

A full-viewport scrim with N "cutout" holes punched at the step's targets, plus the click-through policy. This folder holds the **pure geometry core**; the React `OverlaySpotlight` component (portal scrim + SVG mask) composes it and `FocusOverlay`.

## Files

| File | Purpose |
|------|---------|
| `overlay-spotlight.ts` | Pure: cutout shape fns (`roundedRectCutout`/`circleCutout`), blind `createCutoutShapeRegistry`, `computeCutouts`, `pointerPolicy`, `scrimMaskPath`. |
| `index.ts` | Barrel. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `CutoutDescriptor` | `{ shape?: string, padding?: number, radius?: number }` | A cutout as DATA; `shape` is an open key. |
| `CutoutGeometry` | `{ x, y, width, height, rx, ry }` | SVG-ready rounded rect (a circle = rx=ry=half-min-side). |
| `CutoutShapeFn` | `(target, descriptor) → CutoutGeometry` | Pure shape geometry. |
| `createCutoutShapeRegistry()` | `→ BlindRegistry<CutoutShapeFn>` | `shape`→fn; `rounded-rect` (fallback) + `circle` built in; new shape = register. |
| `computeCutouts(targets, descriptors?, registry?)` | `→ CutoutGeometry[]` | Zip targets+descriptors, dispatch by shape (blind). |
| `pointerPolicy(policy?)` | `→ 'block-all'｜'cutouts-interactive'` | `interactive-gate` makes holes live; else block all clicks. |
| `PointerPolicy` | `'block-all'｜'cutouts-interactive'｜'pass-all'` | `pass-all`: the scrim catches nothing (the whole page stays usable). |
| `scrimIsInvisible(scrimColor, blurPx)` | `→ boolean` | A scrim with zero alpha and no blur is invisible, so a caller passes `pass-all` for it. |
| `scrimMaskPath(viewport, cutouts)` | `→ { outer, holes }` | The full-viewport mask path + holes for an SVG `<mask>`. |

## Status

Pure geometry core: ✅ (this folder). **Remaining (W2):** the React `OverlaySpotlight` component — portal a viewport scrim, render an SVG `<mask>` from `scrimMaskPath`, set `pointer-events` per `pointerPolicy`, at `LAYER_ORDER.walkthrough`. Its faithful proof is visual (Playwright over a live tour), landed with the engine wiring.

## Why This Design (L069 / Physics-vs-Society)

`cutout.shapes[].shape` is open DATA dispatched through `ui/show/blind-registry` (the 4th consumer) — a new cutout shape is a registration, not a code branch. The pointer behaviours are closed-by-Physics (a hole is live or not; a scrim nobody can see catches nothing). Padding/radius/shape are all DATA.

## Dependencies

**Depends on:** `ui/show/blind-registry`, `ui/show/anchor-resolver` (`Rect`).
**Depended on by (planned):** the React `OverlaySpotlight` + the `guided-overlay` engine (M1); composes `ui/show/focus-overlay` for the portal/scrim.
