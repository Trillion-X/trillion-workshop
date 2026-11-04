# tools/draw-lists-on-a-canvas

The screens that lay a list out on a zoomable canvas as cards joined by links and let a person draw on it: old trillion's `parts/graph-canvas/` (the canvas, `show/GraphCanvas.tsx`) and `parts/addressed-marks/` (ink over any space, `show/AddressedMarkLayer.tsx`, the mark toolbar and `read-data/`), whose own READMEs are in `graph-canvas/` and `addressed-marks/`. The screens need the workspace and a browser; the row runs one part that needs neither, the rule that fades live ink. Folding, shaping, erasing and exporting marks run as rows in `tools/draw-ink-marks`.

## Files

| File | Purpose |
|------|---------|
| `do-work/fade-ink.mjs` | `fadeInk({ now, fade: { hold_ms, fade_ms }, marks: [{ ref, created_at? }] })` → `{ marks: [{ ref, opacity, shown, gone_at }], shown, gone }`: `read-data/ink-fade.ts` run for a list of marks at one instant (what `tool-rows.json` runs) |
| `tool-rows.json` | The row `tool:fade-live-ink-marks`, with a sample run where one mark is fading and one is gone |
| `README.md` | This file |

## The row

`tool:fade-live-ink-marks` reads no clock, draws nothing and changes no mark: a faded mark is still the person's record, only no longer drawn. Laying the list out, the pen and keeping strokes stay with the screens.
