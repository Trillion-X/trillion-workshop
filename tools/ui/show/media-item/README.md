# tools/ui/show/media-item/

A video's still and a list row that leads with one.

## Files

| File | Purpose |
|------|---------|
| `MediaItem.tsx` | `MediaStill` (the 16:9 media slot: the still, or the look's wash with a play disc when there is none or it fails to load, with an optional length pill) and `MediaItem` (one press: the still, a title, one line under it, a chevron). |
| `index.ts` | The exports. |

## Source

Anatomy from the 21st.dev "Media Item" family, component 29173 (`ai2/item-media`, its `VideoItem` row: 16:9 slot with a play
disc and a length pill, title and one muted line, trailing chevron), read on Nov 24 2026. No code was copied: the part is
composed from the shared Container, ImageBlock, Text, NamedIcon and Button, coloured only by the screen look's tokens.

## Used by

- `tools/lessons-and-learning-paths/web/learner-home-screen-mount.tsx` (the learner's home: the resume still and the up-next rows).
