# ui/show/file-download — save bytes to a file

The universal "download these bytes the user produced" capability — one shared implementation of the create-anchor → click → revoke-object-URL dance, so every surface that produces an artifact (exported board SVG, generated image, report) reuses it instead of hand-rolling it (L088 — settles at the shared UI bedrock).

## Files

| File | Purpose |
|------|---------|
| `download-file.ts` | `downloadBlob` + `downloadTextFile` + `downloadAddress` — blind byte savers (know nothing about WHAT the bytes are; the producer owns meaning). |

## Key Functions

| Function | Signature | Role |
|----------|-----------|------|
| `downloadBlob(blob, filename)` | `(Blob, string) → void` | Trigger a browser download of an in-memory Blob; revokes the object URL after the click is dispatched. |
| `downloadTextFile(text, filename, mimeType)` | `(string, string, string) → void` | Download a text payload (svg/json/csv/txt) under `filename` with `mimeType`. Wraps `downloadBlob`. |
| `downloadAddress(url, filename)` | `(string, string) → Promise<void>` | Read a file at an address once and save it. A Button whose press returns this promise shows Downloading/Done/Try again in itself and ignores presses while it runs, so a slow file is never saved twice (the file preview's Download, a space's opened file). |

## Dependencies

**Depends on:** the browser DOM (`document`, `URL`, `Blob`) only — no React, no other package.
**Depended on by:** `ui` barrel (`@/packages/ui`); the `group` package board SVG export (`exportBoardSvg`); `../file-preview/FilePreview.tsx` (the file card's Download); `src/workspace/spaces-screen.tsx` (an opened file's Download). Any package that produces a downloadable artifact.
