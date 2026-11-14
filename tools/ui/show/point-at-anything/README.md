# point-at-anything

Point at any element of any page and pick it, for an owner to change, annotate or hand to an AI.

## Files

| File | Purpose |
|------|---------|
| `PointAtAnything.tsx` | The picker: while `active`, a ring follows the element under the pointer or finger in `host` (the page's document, an iframe's, a public app preview's); a clear sheet over the page takes the pointer so nothing is hovered and what is picked is read as it rests; a press picks it without pressing it, Escape cancels; elements marked `POINT_AT_ANYTHING_UI` (the owner's own card and hint, the ring) are never picked. Hands the owner the element and its `VisualSelectionRef`. |
| `pointing.ts` | The page's one pointing store: `startPointing()` (any control, such as a pane's ⋯), `keepPick(selection, element)`, `stopPointing()`, `usePointing()`. |
| `index.ts` | The part's public names. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `PointAtAnything` | `{ active, host?, pagePath, route?, revision, onSelect(selection, element), onCancel() }` | The picker. |
| `POINT_AT_ANYTHING_UI` | `'data-point-at-anything-ui'` | Marks the owner's controls so they are never picked. |
| `Pointing` | `{ active: boolean; picked: { selection: VisualSelectionRef; element: Element } \| null }` | The store's value. |
| `startPointing` / `keepPick` / `stopPointing` / `usePointing` | functions / hook | Start, keep a pick, end, read. |

## Dependencies

**Depends on:** `../public-app-editor/selection-ref.ts` (`captureVisualSelection`, the one selection shape), `../container`, `../layer-order` (the sheet and ring sit on the dialog layer: above the page, below menus and tours).
**Depended on by:** `src/workspace/point-at-anything.tsx` (Trillion's own screens: change every one like it in the look, or ask my AI), `parts/screen-arrangement/show/ContainerHeader.tsx` (the ⋯ row "Point at something to change it"). The Public apps editor (site-canvas lane) mounts the same picker over its frames.

## Invariants

- One selection shape: `captureVisualSelection`; this part never makes its own selector.
- While pointing, nothing under the sheet is hovered, so a pick never reads a hover look.
- Nothing names a screen, a product or a kind of element.
