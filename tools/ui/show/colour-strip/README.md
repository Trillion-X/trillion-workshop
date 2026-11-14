# colour-strip

A bar of colours along a line, blended between stops, with an optional mark (such as now) and labels under it.

## Files

| File | Purpose |
|------|---------|
| `ColourStrip.tsx` | The bar, composed from Container and Text: stops at places 0..1 drawn as one blended gradient, a mark at one place, labels at places under it. |
| `index.ts` | Exports the component and its types. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `ColourStrip` | `({ stops, mark?, labels?, label? }) => JSX` | Draws the bar. |
| `ColourStop` | `{ at: number; colour: string }` | One colour at one place, 0 (start) to 1 (end). |
| `ColourStripProps` | props above | What the bar takes. |

## Invariants

- Blind: it never knows what the colours mean.
- A style only for the data colours and places (the ColorDot exception to L065).

## Dependencies

**Depends on:** `../container`, `../text/Text`.

**Depended on by:** `parts/screen-look/show/look-over-time-screen.tsx` (a day of screen colours), through the `parts/ui` barrel.
