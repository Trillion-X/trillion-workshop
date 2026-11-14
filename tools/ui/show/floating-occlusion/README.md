# floating-occlusion

Lets overlays stack instead of overlapping: a docked floating control publishes how much of the viewport bottom it covers and where it sits, a box pinned at a screen's bottom lifts above it, and the toast stack stays at the window edge beside it, rising above it only when there is no room beside it. The arranged stage never reads this and never shrinks for an overlay.

## Files

| File | Purpose |
|------|---------|
| `reserve-bottom-inset.ts` | Publishes `--floating-occlusion-bottom` on the document root while a floating control is visibly docked at the viewport bottom, keeps where each docked control sits (`dockedFloatingBoxes`) and announces `floating-occlusion-change` on the document; releases it when the control is moved, collapsed, hidden or unmounted. |
| `room-beside-floating.ts` | `roomBesideFloating`: pure geometry. For an overlay near the viewport bottom and the docked controls, the room each side that keeps it beside the controls it would cover while at least `minWidth` is left, else the lift above the highest of them. |
| `keep-beside-floating.ts` | `keepBesideFloating`: measures one overlay (the toast viewport) and sets `--floating-room-left`, `--floating-room-right` and `--floating-room-lift` from `roomBesideFloating`; screen-look turns them into its sides and bottom. Looks again on every `floating-occlusion-change` and resize. |
| `clear-scroll-beneath.ts` | Marks the scrolling area beneath a fixed control (a corner button) with `data-floating-clearance` and `--floating-clearance`, so screen-look ends that area with room for the control and its last card can be scrolled out from under it; looks again on resize, scroll and every second, and releases the area when the control hides or unmounts. |
| `window-corner.tsx` | `InWindowCorner`: every control that floats in a window corner (the Look button, the phone's Show sidebar button, the pane map on a page with no sidebar; the message box is a screen in an arrangement layer, never a corner control) joins that corner's one group, lined up side by side by its `order` (0 is the corner itself), never on another. The group publishes its band (`reserveBottomFloatingInset`) and clears what scrolls beneath it (`clearScrollBeneath`), so notifications and a bottom-pinned message box stack above every corner control through one rule; `parts/screen-look/show/floating-corner.css` places it. |
| `lift-above-floating.ts` | Lifts a box pinned at the bottom of its screen (the message box) out from under the band `--floating-occlusion-bottom` publishes: while its bottom reaches into the band it gets `data-floating-lift` and `--floating-lift`, and screen-look adds that much room under it; a box higher up is never moved. |
| `reserve-bottom-inset.test.ts` | Proves the largest docked overlap wins and is released, toasts sit above a docked prompt, and the arranged stage keeps its full height while a toast and a docked prompt are showing. |

## Key Types / Functions

| Function | Signature | Role |
|----------|-----------|------|
| `reserveBottomFloatingInset` | `(node: HTMLElement, gutter = 8) => () => void` | Tracks one floating control; the returned function releases it. Several controls share one property, the largest overlap wins. |
| `liftAboveFloating` | `(node: HTMLElement) => () => void` | Keeps one bottom-pinned box above the published band; the returned function releases it. |
| `dockedFloatingBoxes` | `(doc: Document) => DockedBox[]` | Where each docked control sits now: `{ left, right, top }` in viewport pixels. |
| `FLOATING_OCCLUSION_CHANGE` | `'floating-occlusion-change'` | The document event fired whenever a docked control is added, moves, resizes or leaves. |
| `roomBesideFloating` | `(overlay: {left,right,bottom}, boxes, {gap = 8, minWidth = 240}) => {left, right, lift}` | Room beside covered controls, else a lift above them. |
| `keepBesideFloating` | `(node: HTMLElement, options?) => () => void` | Keeps one bottom overlay beside the docked controls; the returned function releases it. |
| `clearScrollBeneath` | `(node: HTMLElement, gutter = 12) => () => void` | Gives the area that scrolls under a fixed control room at its end; the returned function releases it. |
| `InWindowCorner` | `({ corner: 'bottom-left' \| 'bottom-right', order?: number, children }) => ReactPortal \| null` | Floats its children in the corner's one group; the group exists while it has a control. |
| `WindowCorner` | `'bottom-left' \| 'bottom-right'` | The window corners a control can float in. |

## Dependencies

**Depends on:** DOM (`ResizeObserver`, `MutationObserver`, `requestAnimationFrame`); `window-corner.tsx` also React, `../container` and `../layer-order`.

**Depended on by:** `../coss/action-prompt.tsx` (publishes), `window-corner.tsx` (publishes and clears for every corner control: `parts/sidebar/show/DesktopSidebar.tsx`'s phone-width Show sidebar button, `parts/screen-arrangement/show/ArrangementNavigator.tsx`'s floating pane map on a page with no sidebar, `src/workspace/global-composer.tsx`'s message button and `parts/screen-look/show/ScreenLookSurface.tsx`'s Look button), `../composer/Composer.tsx` (a message box in a page lifts above the band; `parts/screen-look/show/composer.css` draws the room and the room at the end of what scrolls beneath), `../coss/ui/toast.tsx` (the toast viewport runs `keepBesideFloating`), `parts/screen-look/show/notifications.css` (the toast viewport's sides and bottom read `--floating-room-left`, `--floating-room-right` and `--floating-room-lift`).

## Invariants

- Nothing positions itself in a window corner: a corner control joins that corner's group, so two controls never share a spot and a new one needs no offset.
- Overlays stack; they never take layout space. `packages/screen-arrangement/show/mount-screen-arrangement.tsx` bounds the stage only by `--stage-inset-bottom`.
