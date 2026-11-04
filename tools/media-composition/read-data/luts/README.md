# parts/media-composition/read-data/luts

The colour grade files (3D LUTs in `.cube` form) that the looks in `../looks.json` apply.

## Files

| File | Purpose |
|------|---------|
| `00-slog3-to-709.cube` | Camera log (S-Log3) to normal colour. Look `log-to-normal`. |
| `01-basic.cube` | Clean base grade. Look `clean-base`. |
| `02-rgb-curves.cube` | Punchy RGB curves. Look `punchy-curves`. |
| `03-hue-v-sat-orange.cube` | Richer oranges (saturation by hue). Look `richer-oranges`. |
| `04-hue-v-hue-orange-red.cube` | Oranges shifted toward red. Look `oranges-toward-red`. |
| `05-luma-v-sat-increase.cube` | More colour in bright areas. Look `brighter-colour`. |
| `06-color-wheels-teal-orange.cube` | Teal shadows, orange skin. Look `teal-and-orange`. |
| `07-hsl-orange-warm.cube` | Warm oranges. Look `warm-oranges`. |

## Key Types / Functions

None: each file is data. `../stored-bytes.json` gives each an address (`package::media-composition::stored-bytes::grade-*`), and `../../do-work/video-compose.mjs` writes the file where ffmpeg's `lut3d` reads it at render time.

## Dependencies

**Depends on:** nothing.
**Depended on by:** `../looks.json` (by address), `../stored-bytes.json`, `../../do-work/video-compose.mjs`. Copied byte for byte from the Mac editor's grade files (bitfield-packages `packages/media-composition/assets/grades/`).
