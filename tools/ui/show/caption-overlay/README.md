# caption-overlay

Captions drawn over a picture: a plain legible line (`CaptionOverlay`), and a caption drawn in its caption style row (`StyledCaption`, `CaptionSample`), the same row the burned-in subtitle is built from.

## Files

| File | Purpose |
|------|---------|
| `CaptionOverlay.tsx` | A plain subtitle line at the bottom, top or centre of a picture, legible on light and dark frames (token colours, a fixed soft shadow). Used by `media-playback` MediaPlaybackSurface. |
| `StyledCaption.tsx` | A caption in a caption style row (`parts/media-composition/read-data/caption-styles.json`): font, size, bold, italic, outline, shadow (a halo with spread drawn as a ring of soft text shadows), place, and for a style that lights words up as said the said words in one colour and the rest in another. `CaptionSample` draws the band of a frame the caption sits in, its words half said, beside the style's inspector. |
| `README.md` | This file. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `CaptionOverlay` | `({ text, position?, visible?, className? }) => JSX` | Plain legible caption. |
| `CaptionLook` | `{ font, size, bold, italic, outline, shadow: CaptionShadowLook \| null, colours: { spoken, upcoming, outline }, position: { x, y }, reveal, preview?: { fonts? } }` | The fields of a caption style row this draws. |
| `CaptionShadowLook` | `{ x, y, blur, spread, colour, opacity }` | A caption's shadow in style pixels. |
| `StyledCaption` | `({ look, line: { text, x?, y?, words? }, time, frame: { width, height }, measuredAt }) => JSX` | One caption, bottom-centre at its place, sized in container units of its frame (its parent is an inline-size container). |
| `CaptionSample` | `({ look, text, frame, measuredAt, background }) => JSX` | A banded sample of the style for an inspector's preview. |
| `captionShadowCss` | `(shadow \| null, length: (px) => string) => string` | The CSS text shadows that draw a style's shadow. |

## Dependencies

**Depends on:** React only.
**Depended on by:** `ui` selection LiveCompositionPreview (captions over the player), `src/workspace/media-edit/captions-panel.tsx` (the style's sample), `media-playback` MediaPlaybackSurface (`CaptionOverlay`), the `ui` barrel.

## Invariants

1. Sizes scale with the frame exactly as the subtitle does (style pixels measured on a frame whose shorter side is `measuredAt`).
2. Nothing here names a style; every look comes from the style row.
