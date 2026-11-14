# visible-viewport

Keeps an app shell sized to the part of the window a person can actually see, so a phone keyboard shrinks the shell from below instead of sliding the page up under the status bar, and gives floating cards the window's safe areas as numbers so they keep clear of the status bar and home indicator.

## Files

| File | Purpose |
|---|---|
| `bind-visible-viewport.ts` | `bindVisibleViewport(document)`: holds the window's own scroll at 0 and writes the visible area onto the document as CSS values; when a keyboard opens, scrolls the field being typed in into view inside its own scrolling area. |
| `safe-area-insets.ts` | `readSafeAreaInsets()`, `safeEdgePadding(gap)`, `insetFrame(frame, insets)`: the window's env(safe-area-inset-*) as pixels for cards placed by script (tour cards, hover cards). |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|---|---|---|
| `bindVisibleViewport` | `(doc?: Document) => () => void` | Installs once per document; returns the teardown. Does nothing without `visualViewport`. |
| `readSafeAreaInsets` | `(doc?: Document) => SafeAreaInsets` | The window's safe areas `{ top, right, bottom, left }` in px, read through one hidden element once per window size (a resize forgets it); all 0 without a document. |
| `safeEdgePadding` | `(gap: number, insets?) => SafeAreaInsets` | Each edge's safe area plus `gap`: a Base UI positioner's `collisionPadding`, so a hover card never opens under the status bar. |
| `insetFrame` | `(frame: Size, insets) => { x, y, width, height }` | The part of a frame left once the insets are taken off; never negative. |
| `--visible-viewport-top` | CSS length on `<html>` | Pixels from the window's top to the visible area's top. |
| `--visible-viewport-height` | CSS length on `<html>` | Pixels of the visible area. |
| `--visible-viewport-keyboard` | `0` or `1` on `<html>` | 1 while a keyboard covers the bottom (the bottom safe-area inset is then under the keyboard). |
| `--visible-viewport-bottom` | CSS length on `<html>` | Pixels of the window covered below the visible area while a keyboard is up (the keyboard and its typing bar); 0 otherwise. A window-edge element adds it to its bottom gap so it ends above the keyboard. |

## Invariants

1. The window never scrolls: only scrolling areas inside the shell move.
2. Values are written only when they change.
3. Without the values (no `visualViewport`), a shell's CSS falls back to the full window.

## Dependencies

**Depends on:** `window.visualViewport`.

**Depended on by:** `screen-arrangement/show/mount-screen-arrangement.tsx` (binds it with the stage); `src/workspace/workspace.css` (`.trillion-workspace` reads the values); `anchor-resolver/AnchoredCoachmark.tsx` (places a tour card inside the safe frame); the hover cards' positioners in `surface-preview`, `hover-preview`, `automation-preview`, `record-views` and `card-layouts` (`safeEdgePadding`).
