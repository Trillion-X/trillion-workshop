# ui/show/raster — rasterize a vector document to pixels

The universal "turn an SVG string into a PNG Blob" capability — the thin browser-API layer (Image → canvas.drawImage → toBlob) that sits on top of any deterministic `model→SVG` serializer, so the heavy logic stays a pure, unit-testable string and only the painting is DOM glue.

## Files

| File | Purpose |
|------|---------|
| `svg-to-png.ts` | `parseSvgSize` (PURE — reads the document's `width`/`height`) + `svgToPngBlob` (async — paints the SVG onto a scaled canvas and returns a PNG Blob). |
| `svg-to-png.test.ts` | Pure proof of `parseSvgSize` (emitted dims, fallback, decimals, zero/non-numeric guard). |

## Key Functions

| Function | Signature | Role |
|----------|-----------|------|
| `parseSvgSize(svg)` | `(string) → {width, height}` | Read the pixel size off the `width="…" height="…"` attributes a serialized SVG carries; fallback 800×600. Pure, unit-testable. |
| `svgToPngBlob(svg, opts?)` | `(string, {scale?, background?}) → Promise<Blob>` | Blob(svg)→objectURL→`new Image()`→draw onto a `<canvas>` (size × scale, default 2×)→`toBlob('image/png')`. Optional opaque background fill. Revokes the URL in `finally`; throws on load/context/toBlob failure. |

## Constraint

An SVG rendered through `new Image()` only resolves `<image>` children whose href is a `data:` URL or same-origin. The CALLER must inline cross-origin image srcs to data URLs BEFORE building the SVG — an un-inlined external image fails to load or taints the canvas (making `toBlob` throw). This layer assumes a self-contained SVG.

## Dependencies

**Depends on:** the browser DOM (`Image`, `document.createElement('canvas')`, `URL`, `Blob`) only — no React, no other package.
**Depended on by:** `ui` barrel (`@/packages/ui`); the `group` package board PNG export (`exportBoardPng`, which feeds it a `boardToSvg` string with inlined images). Any surface that produces an SVG and wants a raster.
