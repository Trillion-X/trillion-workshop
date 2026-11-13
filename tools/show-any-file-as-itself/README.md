# tools/show-any-file-as-itself

The screens that show a file in its own form: the file-content renderer (markdown, code, JSON, a picture, a diff or raw text, `show/`) and the shared media player (`show/MediaPlaybackSurface.tsx`, `read-data/`), moved from old trillion's `parts/file-content-renderer/` and `parts/media-playback/` (whose own READMEs are in `file-content-renderer/` and `media-playback/`). The screens need the workspace and a browser; the row runs the one part that needs neither, the classification that chooses how each file is shown.

## Files

| File | Purpose |
|------|---------|
| `do-work/classify-files.mjs` | `classifyFiles({ files: [{ path, mime_type? }] })` → `{ classified }`: each file's renderer, language, icon, label and media type, from the renderer's own deterministic fallback in `show/classify-file-content.ts` (what `tool-rows.json` runs) |
| `tool-rows.json` | The row `tool:choose-how-each-file-is-shown`, with a sample run that classifies a markdown file, a patch and a picture |
| `web/src/workspace/file-screen.tsx` | The File screen (`tool:screen-file`): one file in its own tab, shown by the one file preview, with its path above it, Share, the notes of a recording (transcript, summary, action items) and the use it reports to Recent. Moved byte for byte from the web client (`moved-from.json`); it imports the web shell's files as it was written, and the client build answers those imports with the shell's files. |
| `web/src/workspace/file-uses.ts` | The page's half of Recent: tells the person's store a file was used, and counts how long a recording really played so watched is said only after it played long enough. Only the File screen imports it. |
| `web/src/workspace/note-review.mjs` | The pure decisions behind a meeting note's Summary and Action Items tabs: items, their grouping by owner, the task each becomes and what a template and language ask the person's AI for. |
| `web/src/workspace/note-review-tools.tsx` | The tools on a meeting note's Summary and Action Items tabs: template and language, copy and PDF, a rating and the action items as tasks. |
| `web/src/workspace/note-transcript.tsx` | A recording's transcript on its note, over the shared transcript reader, with speaker names, links to a passage, another language, copy, PDF and splitting a passage. |
| `web/src/workspace/editable-text-document.tsx` | The editable text document the File screen shows for a text file the person may change. |
| `show/file-mount.tsx` | The screen's module entry, the file its row names: `mount` is the screen's own mount function. |
| `README.md` | This file |

## The row

`tool:choose-how-each-file-is-shown` reads only the names and media types it is given: it opens no file, draws nothing, sends nothing and does not ask the signed-in classification owner the screen asks first. Drawing the file, playing sound and video and editing the facts kept about a file stay with the screens.
