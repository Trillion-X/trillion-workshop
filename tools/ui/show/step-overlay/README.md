# Step Overlay

One step the person takes in front of the app (choosing a plan, connecting their AI): a panel over the whole window, with the app still visible through a quiet blur behind it.

## Files

| File | Purpose |
|------|---------|
| `StepOverlay.tsx` | The step: portal to the page, blurred backdrop, a panel with the caller's heading, words, optional waiting line and body; focus kept inside while open; closing only when the caller gives `onClose`. |
| `README.md` | This file. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `StepOverlay` | `(props: StepOverlayProps) => JSX.Element` | Draws the step above everything a step can cover (`LAYER_ORDER.stepInFront`). |
| `StepOverlayProps` | `{ title, description?, onClose?, closeLabel?, width?: 'wide' \| 'reading', waiting?, marker?, mount?(host) => unmount, children? }` | Every word and the body are the caller's; `mount` draws a screen the caller owns into a host; `waiting` says what the step waits for beside the loading mark; `marker` is `data-step-overlay` for proofs and tours. |

## Invariants

- No product words or roads: the heading, words and body come from the caller.
- Without `onClose` there is no close button and Escape does nothing, so a step that must be done first stays until its caller takes it away.
- Focus moves into the panel when it opens, Tab wraps inside it, and focus returns to where it was when it closes; the page behind does not scroll.
- Styles are `step-overlay*` in `parts/screen-look/show/surfaces.css`.

## Dependencies

**Depends on:** `react-dom` `createPortal`, `layer-order` (`stepInFront`), `loading-mark`.

**Depended on by:** `pricing-overlay` (the plans dialog).
