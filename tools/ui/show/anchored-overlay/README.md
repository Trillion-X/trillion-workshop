# parts/ui/show/anchored-overlay

A floating panel that escapes its host's clip: portaled to `<body>`, placed above, below or over an anchor element (or a fixed viewport point), height clamped to the screen, optionally draggable, and shown only while its anchor is drawn.

## Files

| File | Purpose |
|------|---------|
| `AnchoredOverlay.tsx` | The overlay: measures the anchor on scroll, resize, the anchor's and its own ResizeObserver and `measureKey`; flips above/below when it does not fit; unseen and inert (opacity 0, so an input inside can still take focus as it mounts) until it has a real position, and not drawn at all (visibility hidden) whenever its anchor is not drawn (left screen, hidden tab, a `display:none` ancestor), back over the anchor when it is drawn again. |
| `index.ts` | Re-exports `AnchoredOverlay` and its props type. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `AnchoredOverlay` | `(props: AnchoredOverlayProps) => ReactPortal \| null` | The panel. |
| `AnchoredOverlayProps` | `{ anchorRef?, anchorPoint?, open, placement?: 'above' \| 'below' \| 'over', gap?, draggable?, title?, onDismiss?, dismissPreservesSelection?, matchAnchorWidth?, flagAttr?, measureKey?, surface?, children }` | Where it anchors, how it places, whether it can be dragged or dismissed, and its surface. |
| `isDrawn` (internal) | `(el: HTMLElement) => boolean` | Whether the anchor is in the page and drawn (`checkVisibility`, else client rects). |

## Dependencies

**Depends on:** `react`, `react-dom` (`createPortal`), `../layer-order` (`LAYER_ORDER.menu`).

**Depended on by:** `parts/documents` (Write's slash menu and its "Writing: ... Stop" and failure panels), `parts/ui/show/node-actions`, `parts/ui/show/color-tag-picker-overlay`, `parts/group` (the board's toolbars and popovers), `parts/screen-arrangement`.

## Invariants

Listed in the file header (1-6). Invariant 6 is checked in a real browser by `test/anchored-overlay-follows-anchor-browser.test.mjs`: shown over its anchor, hidden when the anchor's screen goes `display:none`, back over the anchor when it is shown again.
