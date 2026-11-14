# ui/show/canvas-hud/

Blind on-canvas heads-up controls: a glassmorphic pill with zoom −/%/+ , fit-to-view, and a minimap toggle.

## Files

| File | Purpose |
|------|---------|
| `CanvasHud.tsx` | The `CanvasHud` component — a stateless pill of zoom/fit/minimap buttons fed a number + callbacks. |
| `README.md` | This file. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `CanvasHud` | `(props: CanvasHudProps) => JSX.Element` | Renders `[−] [zoom%] [+] | [fit] [map]`; each control calls a prop callback. |
| `CanvasHudProps` | `{ zoomPercent, onZoomIn, onZoomOut, onResetZoom, onFit, minimapOn, onToggleMinimap, canZoomIn?, canZoomOut?, className? }` | Blind contract — a whole-number zoom percent in, callbacks out; no node/Society vocabulary. |

## Dependencies

**Depends on:** `@/packages/ui/show/cn`, `@/packages/ui/show/icon` (`NamedIcon`), `react`, `lucide-react` (via NamedIcon: Minus, Plus, Maximize, Map).

**Depended on by:** `@/packages/documents` (the Pages & Screens surface mounts it in canvas mode; B-46). Pairs with the shared `@/packages/ui/show/canvas-minimap` (the `Map` toggle shows/hides it).

## Why This Design?

The HUD is pure chrome (L114/L118): a number + callbacks, zero knowledge of what it controls. Every camera computation lives in the consumer's pure `do-work` math (`zoomByFactor`/`zoomToActualSize`/`fitCamera`), so the HUD never names a node kind, a page, or a camera convention. Reference anatomy (Mobbin): GitBook/Slite/Craft bottom-left zoom pill + Fibery/Asana "Fit to view" + "Map" toggle.
