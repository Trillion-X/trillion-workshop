# tools/show-any-file-as-itself

The screens that show a file in its own form: the file-content renderer (markdown, code, JSON, a picture, a diff or raw text, `show/`) and the shared media player (`show/MediaPlaybackSurface.tsx`, `read-data/`), moved from old trillion's `parts/file-content-renderer/` and `parts/media-playback/` (whose own READMEs are in `file-content-renderer/` and `media-playback/`). The screens need the workspace and a browser; the row runs the one part that needs neither, the classification that chooses how each file is shown.

## Files

| File | Purpose |
|------|---------|
| `do-work/classify-files.mjs` | `classifyFiles({ files: [{ path, mime_type? }] })` → `{ classified }`: each file's renderer, language, icon, label and media type, from the renderer's own deterministic fallback in `show/classify-file-content.ts` (what `tool-rows.json` runs) |
| `tool-rows.json` | The row `tool:choose-how-each-file-is-shown`, with a sample run that classifies a markdown file, a patch and a picture |
| `README.md` | This file |

## The row

`tool:choose-how-each-file-is-shown` reads only the names and media types it is given: it opens no file, draws nothing, sends nothing and does not ask the signed-in classification owner the screen asks first. Drawing the file, playing sound and video and editing the facts kept about a file stay with the screens.
