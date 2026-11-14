# hover-preview

What a file or record looks like when the pointer rests on it: a card beside it whose screen is THE one file preview (`../file-preview/FilePreview`, glance size), and, for several items, a carousel over them.

## Files

| File | Purpose |
|------|---------|
| `HoverPreview.tsx` | `HoverPreview` (the card); its content is fetched the first time a card opens. |
| `PreviewCarousel.tsx` | `PreviewCarousel` (one screen or several, with details and the file card), fetched by `HoverPreview` when a card opens. |
| `PreviewScreen.tsx` | `PreviewScreen` (an item's file through FilePreview, or its small picture/text/icon when it has no file); drawn by the carousel and by record-views' media cells. |
| `HoverPreview.test.tsx` | Every kind drawn by FilePreview with its viewer from DATA, a text file read by range, sound with waveform, carousel start/keys/buttons/one-flick trackpad scroll, arrow keys left to a box being typed in, caller details; tile frame scrub, waveform in hand, made previews read from the store first. |
| `index.ts` | Public exports. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `PreviewItem` | `{id, title, url?, type?, poster?, frames?: FrameStrip, peaks?, peaksUrl?, text?, icon?, typeLabel?, open?: PlaceableSurfacePayload}` | One thing to show; with `open` its screen drags onto the screen arrangement to open there. `url` is read by range only while its screen is on show; `poster` is the small still used before the whole file. |
| `PreviewScreen` | `({item}) => ReactElement` | `.hover-preview-screen[data-preview-screen=<viewer>]` holding FilePreview (a sound's waveform above its player), or `card` for an item with no file. |
| `PreviewCarousel<T>` | `({items, start?, preview: (T) => PreviewItem \| null, details?: (T, index) => ReactNode, renderPreview?: (PreviewItem) => ReactNode, label?})` | One item: its screen and details. Several: one at a time, ←/→ keys (not while typing), sideways trackpad scroll (one screen per flick), touch swipe, Previous/Next, "2 of 5". `renderPreview` replaces the default `PreviewScreen`, which is already the one file preview. |
| `HoverPreview<T>` | `PreviewCarouselProps<T> & {trigger, side?, align?, delay?}` | Base UI PreviewCard opening after `delay` (500 ms) on `trigger`, with a safe path into the card. |
| file card | under every item that has a file | `PreviewCarousel` draws `FileCardFor` (../file-card) under the screen of an item with a `url`: its facts, the actions the page offers for that file, who is in it, what was said and files beside it; nothing when the page installed no file card source. |

## Behaviour

- Only the screen on show is mounted, so one video plays at a time and a carousel of fifty opens one file.
- Every file goes through `file-preview/FilePreview` (glance): video and sound in the shared player, a video showing its poster (or its own first frame) until play is pressed; pictures show `poster` first; text reads its first 4 KB with a `Range` request; PDFs, Office files and the rest as FilePreview draws them.
- The card's look is `record-preview` in `screen-look/show/navigation-preview.css`; the screens and carousel row are `screen-look/show/hover-preview.css`.

## Dependencies

**Depends on:** `@base-ui/react/preview-card`, `../coss/ui/button`, `../icon`, `../layer-order`, `../file-preview/FilePreview`, `../file-preview/choose-file-viewer`, `../media-preview/MediaPreview`.

**Depended on by:** `../record-views` (hover card in gallery, table and board; carousel over the selection), `../next-step-card` (its small pictures), Trillion Files (`trillion/parts/ui`, vendored).
