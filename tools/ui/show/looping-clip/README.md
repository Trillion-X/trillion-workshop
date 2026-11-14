# looping-clip

A short recording that plays by itself, muted and on a loop, while it is on screen: the way a product page or a directory card shows something working.

## Files

| File | Purpose |
|---|---|
| `LoopingClip.tsx` | `LoopingClip`: cover first, plays while at least a quarter of it is in view, pauses when it leaves, stays on the cover when the system asks for less motion |
| `index.ts` | Barrel: `LoopingClip`, `LoopingClipProps` |

## Key Types / Functions

| Name | Signature / Shape | Role |
|---|---|---|
| `LoopingClip` | `(props: LoopingClipProps) => JSX.Element` | The one `<video>` a page of demo clips draws; raw media tags stay in parts/ui |
| `LoopingClipProps` | `{ src, poster?, label, className? }` | Address, cover, spoken label, the caller's class |

## Dependencies

**Depends on:** `react` only, so a site without the workspace's packages (gettrillion.ai) can draw it. `media-frame/` is the editor's frame and carries the audio player and its packages; this part does not.

**Depended on by:** gettrillion.ai `/for-you` (trillion-site `ForYouPage.tsx`).
