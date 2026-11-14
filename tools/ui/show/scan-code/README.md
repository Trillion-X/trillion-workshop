# scan-code

A code another device scans to open an address, such as an app that goes on a phone offered on a computer: the code's picture and the words under it.

## Files

| File | Purpose |
|---|---|
| `ScanCode.tsx` | The scan code: a picture whose address its owner answers (an SVG route), with its label as the picture's words and under it. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|---|---|---|
| `ScanCode` | `({ src, label, size?, className? }) => JSX.Element` | Draws the code's picture and label. |
| `ScanCodeProps` | `{ src: string; label: string; size?: number; className?: string }` | `src` is the picture's address, `size` its width and height in pixels (112 when left out). |

## Dependencies

**Depends on:** React only. Appearance: `parts/screen-look/show/scan-code.css`.

**Depended on by:** `parts/ui/show/coss/guide.tsx` (a guide row's `scan`, which `src/devices.mjs` gives the phone app's row on a computer, its picture drawn by the Worker's `/devices/scan` route from `src/devices.json` links only).
