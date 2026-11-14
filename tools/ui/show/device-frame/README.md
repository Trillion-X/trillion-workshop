# parts/ui/show/device-frame

A phone drawn around a real screenshot, for marketing pages that show an app's screens.

## Files

| File | Purpose |
|------|---------|
| `DeviceFrame.tsx` | `DeviceFrame`: the phone body, side buttons and camera island as one SVG with the screenshot showing through a rounded screen cut-out. |
| `LICENSE.md` | Magic UI's MIT licence. The outline and screen geometry are adapted from Magic UI's `iphone.tsx` (commit `ec1cce6`). |

## Key Types / Functions

| Export | Shape | Role |
|--------|-------|------|
| `DeviceFrame` | `{ src, alt, priority?, className?, ...span attributes }` | Draws the phone at the width of its container (aspect 433:882). A screenshot at 1206x2622 (iPhone 17 Pro) fills the screen whole; other sizes are cropped from the bottom. `priority` loads the picture at once instead of lazily. |

Theme roles read: `--device-frame-body` (the phone's front), `--device-frame-edge` (its rim and buttons), `--device-frame-screen` (behind the picture while it loads). Fallbacks draw a dark titanium phone.

## Dependencies

**Depends on:** React.
**Depended on by:** the gettrillion.ai iPhone page and its landing section (`trillion-site/src/designs/2026-09-27-red-thread/IphonePage.tsx`, `RedThreadPage.tsx`).
