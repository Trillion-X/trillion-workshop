# ui/show/live-frame — a live page shown inside another page

Shows the real thing instead of a picture of it: Trillion's workspace running with throwaway data (src/showcases.mjs serves it on live.gettrillion.ai), a customer's app built on Trillion, or any page that may be framed. Used by gettrillion.ai's landing and any page that embeds a live showcase.

## Files

| File | Purpose |
|------|---------|
| `LiveFrame.tsx` | The one owner of a framed live page: lazy loading, a title for assistive technology, heights from the caller. |
| `live-frame-ready.mjs` | `LIVE_FRAME_READY` and `tellFramingPageReady()`: the message a framed live page sends once its screens show real content. |
| `README.md` | This file. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `LiveFrame` | `({ src, title, height?, phoneHeight?, allow?, className?, poster? }) → iframe, picture-then-iframe, or null` | Frames an https address; sets `--live-frame-height` and `--live-frame-phone-height` for the caller's CSS. With `poster`, shows the picture at once and the live page only after its ready message. |
| `LiveFramePoster` | `{ src: string; alt: string; width: number; height: number }` | A real picture of the framed page. |
| `LIVE_FRAME_READY` / `tellFramingPageReady` | `string` / `(win?) → void` | The data-free ready message and its sender, used by the workspace (src/workspace/main.tsx). |
| `LiveFrameProps` | `{ src: string; title: string; height?: number; phoneHeight?: number; allow?: string; className?: string; poster?: LiveFramePoster }` | DATA the caller passes. |

## Dependencies

**Depends on:** `../cn` (class names), React.
**Depended on by:** `src/workspace/main.tsx` (sends the ready message), trillion-site landing (`src/designs/*/RedThreadPage.tsx`), any page showing a live showcase.

## Invariants

1. The raw `<iframe>` lives only here; callers pass DATA.
2. Only an https address is framed; anything else draws nothing.
3. The look comes from the caller's class and the screen look's variables.
4. With a poster, the live page is shown only after a ready message from that page's own window and origin; a slow or failed live page leaves the picture, never a blank window.
