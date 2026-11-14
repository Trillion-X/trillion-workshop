# Poker Table Show

Browser UI for the Poker package.

## Files

| File | Purpose |
| --- | --- |
| `mount-poker-table.tsx` | Package entry mount. `surfaceInput.poker_surface = "workspace"` renders the embedded poker workspace; `"table"` renders the existing room/table UI. |
| `PokerTablePanel.tsx` | Render components and style block for lobby/table UI. |

## Rules

- The join QR and copy action use the browser route invite URL.
- This folder does not point at retired package-root output folders.
- Native app-invite scene generation is not kept as a fallback while the native source mount path is absent.
- Workspace composition uses the generic `EmbeddedScreenArrangement` plus `placeable-surface-list::poker-workspace`; sidebar and screen arrangement do not contain poker-specific branches.
