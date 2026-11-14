# add-to-it

"Add to it": the ways a person adds something to what they are about to send (attach files, record audio, record video, record the screen, draw, a picture of this screen, the whole page), as a grid of small tiles, each its icon over its name. One part for every place Trillion takes something in: the Send to Trillion popup, Your tray, and the shared Composer when it shows its ways to add out in the open.

## Files

| File | Purpose |
|------|---------|
| `AddToIt.tsx` | `AddToIt`: two tiles to a row, each the shared Button (`secondary`, `option-row`) with the way's icon over its name, busy and disabled states, reporting the pressed way's id. |
| `index.ts` | The one import point (declared public in `../../part.json`, re-exported from the `parts/ui` barrel). |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `AddWay` | `{ id, label, icon, detail?, busy?, disabled? }` | One way to add, as DATA; `detail` shows when pointed at. |
| `AddToIt` | `({ ways, onPress(id), label }) => JSX \| null` | The grid; nothing is drawn when there are no ways. |

## Invariants

- Blind: no way to add is named here; ids, words, icons and states are the caller's.
- Every tile is the shared Button, so a busy one shows the one loading mark.
- Two tiles to a row in every host, so the popup and a narrow pane read the same.

## References (anatomy only)

- Moved from the popup's own capture buttons (`extension/src/add-to-it.tsx`).
- 21st.dev "Attachment Composer Tray" (component 28500).
- Mobbin, Microsoft Copilot composer: https://mobbin.com/screens/2ff3d94d-adb2-4937-818d-de633b9757c3

## Dependencies

**Depends on:** `../button`, `../container`, `../icon`, `../text`.

**Depended on by:** `extension/src/add-to-it.tsx` (the popup's Add to it), `../composer` (`waysShown`: its ways to add drawn as this grid; Your tray, `src/workspace/tray-screen.tsx`).
