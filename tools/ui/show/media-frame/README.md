# ui/show/media-frame — cinematic media preview frame

Renders the correct native element for a caller-owned media URL or live stream by MIME prefix (`video/` → `<video>`, `audio/` → `<audio>` card, `image/` and anything else → `<img>`) inside a shared dark-glass container, with optional caller-owned visual transforms.

## Files

| File | Purpose |
|------|---------|
| `MediaFrame.tsx` | `MediaFrame` component + `MediaFrameTransform` type. Dispatches on `mediaType` prefix; applies an optional `transform` (aspect/corners/shadow/padding/size/object-position/object-fit, `crop`, and `filter`); forwards a `videoRef` for external playback control; accepts a caller-owned live stream; `mirrored`, `muted`, `autoPlay`, `playsInline`, `loop`, `poster`, and `fill` stay render-only. |
| `index.ts` | Barrel: re-exports `MediaFrame`, `MediaFrameProps`, `MediaFrameTransform`. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `MediaFrame` | `(props: MediaFrameProps) => JSX.Element` | Native element by MIME; raw `<video>/<audio>/<img>` are legal ONLY here (ui-layer rule). |
| `MediaFrameProps` | `{ url?, stream?, mediaType, label, className?, transform?, videoRef?, mirrored?, muted?, autoPlay?, playsInline?, loop?, poster?, fill? }` | `url` = public/blob URL for saved playback; `stream` = caller-owned live preview; `mirrored` = render-only front-camera flip; `loop` = start again at the end; `poster` = the picture before the first frame; `transform` = caller visual adjustments; `fill` = full-bleed. |
| `MediaFrameTransform` | `{ aspectRatio?, framePreset?, position?, width?, height?, padding?, inset?, corners?, stroke?, shadow?, keepAspectRatio?, crop?, filter? }` | Caller-owned visuals. `crop = {x,y,w,h}` (0..1) shows only a sub-rectangle of an IMAGE: the `<img>` is scaled (`100/w × 100/h`) and offset so the crop fills the frame; `{0,0,1,1}` = uncropped. `filter` = a CSS `filter` string (e.g. `grayscale(1)`) applied verbatim to the `<img>` (a color preset); composes with `crop` on the same image. Image-only. |

## Dependencies

**Depends on:** `@/packages/ui/show/cn`, `@/packages/ui/show/card/Card`; React.
**Depended on by:** `group/show/item-renderers` (board images/video — passes `extra.crop` as `transform.crop` and `extra.imageFilter` as `transform.filter`), the immersive viewer, and the DreamCut editor preview.

## Why This Design

One renderer, MIME-dispatched (L090) with one video seam for both saved playback and live preview. All visual adjustments (including crop) ride the single `transform` data object, so a new visual capability is a new optional field that degrades to the plain render when absent and feature packages never need their own raw `<video>` wrapper.
