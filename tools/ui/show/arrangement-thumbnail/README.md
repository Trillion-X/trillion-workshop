# arrangement-thumbnail

A small picture of an arrangement of panes with its name under it, pressed to choose it; the chosen one is ringed in the look's accent. Domain-blind: the caller hands in boxes in a 0..1 frame.

## Files

| File | Purpose |
|------|---------|
| `ArrangementThumbnail.tsx` | The thumbnail: shared `Button` press target, the boxes drawn at their places with an icon or short label, the name line (or a caller's rename field), a hover/focus actions slot, and right-click reporting. |
| `index.ts` | Barrel export. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `ArrangementThumbnail` | `(props: ArrangementThumbnailProps) => ReactElement` | Renders one thumbnail. |
| `ArrangementThumbnailBox` | `{id, x, y, w, h, icon?, label?}` | One box in a 0..1 frame. |
| `ArrangementThumbnailProps` | `{name, boxes, selected?, disabled?, pressLabel, onPress, onMenuAt?, actions?, nameEditor?, onNameEditorLeave?}` | `selected` sets `aria-current`; `onMenuAt` gets the right-click point; `actions` shows on hover or focus; `nameEditor` replaces the name line and `onNameEditorLeave` fires when focus leaves it. |

## Design source

- Etsy Pattern theme chooser (https://mobbin.com/screens/53cf9f12-a7a1-4d89-8ac2-4ccc69f417bd): framed preview, name below, accent border on the chosen one.
- Manus template picker (https://mobbin.com/screens/c96eb46a-a492-4a8f-a4c0-ed2aede9b2bf): grid of framed previews, chosen one ringed with its name in the accent.
- 21st.dev searches "layout switcher thumbnails" and "layout picker grid of wireframe presets selectable card" had no fit; the code is original.
- Appearance: `parts/screen-look/show/layout-picker.css` (`.arrangement-thumbnail*`, `.layout-picker`).

## Dependencies

**Depends on:** `../button/Button`, `../icon` (`NamedIcon`).

**Depended on by:** `parts/screen-arrangement/show/LayoutPicker.tsx`.

## Invariants

1. Nothing here names a pane, layout or screen; boxes are DATA.
2. The chosen look is the screen-look accent through `aria-current`, never a colour in this file.
3. Secondary actions show on hover or focus only, never over the picture.
