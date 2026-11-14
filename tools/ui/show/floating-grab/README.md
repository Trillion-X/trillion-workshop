# floating-grab

The strip a floating window is moved by when it shows no tab bar: a grip in the middle, the window's own actions and a close button on the right.

## Files

| File | Purpose |
|------|---------|
| `FloatingGrab.tsx` | The strip. A press on it (not on one of its buttons) hands the pointer to the window owner to move the window. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `FloatingGrab` | `({label, onGrab(event), onClose(), actions?, grabRef?, scoped?}) => ReactElement` | Renders `.coss-floating-panel-grab` with "Drag to move {label}" and "Close {label}". `actions` are drawn as shared icon buttons before the close button; `scoped` adds the `coss-ui` control scope when the strip sits outside one. |
| `FloatingGrabAction` | `{id, label, title?, icon (Lucide name), onAction()}` | One window action, passed as data so no caller authors markup. |
| `FloatingGrabProps` | interface of the props above | |

## Dependencies

**Depends on:** `react`, `lucide-react` (GripHorizontal, X), `../coss/ui/button`, `../icon/NamedIcon`. Appearance: `packages/screen-look/show/coss-workspace.css` (`.coss-floating-panel-grab`, `.coss-floating-panel-grab-actions`).

**Depended on by:** `../coss/workspace-controls.tsx` (`FloatingPanelFrame`, used by `screen-arrangement` `mountFloatingPanel`), `packages/screen-arrangement/show/ContainerHost.tsx` (an overlay container whose chrome DATA hides its header shows this strip, with a "Show as a tab" action; close and dock compose the next arrangement with `read-data/place-tab-in-overlay.ts` `removeOverlayWindow`).

## Invariants

- A press that starts on a button inside the strip never starts a move.
- The strip holds no position; OverlayArranger moves the window without re-rendering.
