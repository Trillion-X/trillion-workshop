# page-backdrop

Whether something moves behind the whole page (behind the sidebar and every pane) and whether the page has finished opening, so surfaces let it show through only once the page is open.

## Files

| File | Purpose |
|------|---------|
| `page-backdrop.ts` | The store: `setPageBackdrop` (the page background's owner), `markPageOpen` (the page), `usePageBackdrop` / `readPageBackdrop` (true only while both hold), `whenPageOpen` (settles once the page is open). |
| `index.ts` | Exports. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `setPageBackdrop` | `(behind: boolean) => void` | screen-arrangement's root arrangement says whether its whole-page background has layers. |
| `markPageOpen` | `() => void` | `src/workspace/main.tsx` once the opening scene is gone. |
| `usePageBackdrop` / `readPageBackdrop` | `() => boolean` | screen-look lets the background show through its surfaces; the arrangement draws the background behind the page. |
| `whenPageOpen` | `() => Promise<void>` | `src/workspace/main.tsx` mounts the tour host only once the page is open, so a tour's dimmed backdrop never appears under the opening cover as it dissolves. |

## Invariants

- Blind: it never knows what is behind the page.
- Nothing shows through before the page is open.
- `markPageOpen` is called once the opening cover has finished dissolving (`src/workspace/main.tsx`).

## Dependencies

**Depends on:** React.

**Depended on by:** `parts/screen-arrangement/show/LayoutEngine.tsx`, `parts/screen-look/show/ScreenLookSurface.tsx`, `src/workspace/main.tsx`.
