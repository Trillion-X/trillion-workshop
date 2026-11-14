# floating-panel-opener

One seam for unpinning any content into the shared floating (PiP) panel without importing the package that draws it.

## Files

| File | Purpose |
|------|---------|
| `floating-panel-opener.ts` | Holds the current opener; callers ask it for a panel and render into its body. |
| `index.ts` | Barrel export. |
| `no-blocking-modal.test.ts` | Fails when any package's `show/` source declares `aria-modal`, opens a native modal dialog, or imports a Base UI / Radix dialog primitive. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `provideFloatingPanelOpener` | `(opener) => withdraw` | The arrangement owner registers `mountFloatingPanel` when it mounts. |
| `openFloatingPanel` | `(anchor, { label, kind?, title?, description?, size?, exclusive?, liveRegions?, layer?, onClose? }) => FloatingPanelHandle \| null` | Opens the shared panel; null when no opener is provided. |
| `canOpenFloatingPanel` | `() => boolean` | Lets a caller hide an Unpin action that cannot work. |
| `FloatingPanelHandle` | `{ body: HTMLElement; close(): void }` | Where the caller renders, and how it closes the panel. |

## Dependencies

**Depends on:** nothing.
**Depended on by:** `screen-arrangement` (provides the opener; its pane map unpins through it), `sidebar` (unpinned lists), Expansion's `shared-controls-entry.ts` and `conversation.tsx` (each provides the opener).

## History

`FloatingView.tsx`, the React form of this seam, was deleted on 2026-10-01: its last caller was the message box's own floating mode, and the message box now floats as a screen in a screen-arrangement layer (src/workspace/surfaces.json `trillion.message-box`, `open_placement.layer: overlay`).
