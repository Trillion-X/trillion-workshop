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

## Restored from bitfield-packages `file-content-renderer`

The renderers already here are the later, evolved copies of the package's (the JSON view, the safe-download rule and the lazy highlighter are newer) and were kept. What was missing is moved: `show/FileHeader.tsx` (imported by `FileContentRenderer.tsx` and not in this tree), `show/mount-file-content-surface.tsx` (the module a placeable surface mounts) and the package's two tests.

| File | Purpose |
|------|---------|
| `show/FileContentRenderer.test.tsx.held` | Held test: a React component test (jsdom, testing-library, vi.mock of `@bitfield/runtime-kit/protocol`) |
| `show/FileHeader.tsx` | PURPOSE |
| `show/mount-file-content-surface.tsx` | Surface adapter: mounts the generic FileContentRenderer viewer from a |
| `show/render-markdown-html.test.ts.held` | Held test: loads this tree's own show/render-markdown-html.ts |
| `from-bitfield-packages-file-content-renderer/moved-from.json` | Source path and commit of each file, identities, call rows, held tests, files that still call the retired runtime. |
## Carried from media-playback

`show/MediaPlaybackSurface.tsx`, `PlaybackControls.tsx`, `MediaFrame.tsx` and the readers here are the newer copies of the package `media-playback`. What the package held and this folder did not is carried under its own paths in `from-bitfield-packages/media-playback/`, byte for byte, with `moved-from.json`: `read-data/read-media-queue.ts`, `read-media-transcript.ts`, `read-surface-media.ts` (the queue order, the transcript segments and the media a surface names), `do-work/reorder-queue.ts` and `record-playback-event.ts` (the two writes), `show/mount-media-playback.tsx` (the material the screen mounts), the package's records (`things-to-store-and-run.json`) and its twelve tests, which import vitest and are held (names end in `.held`). The two writes and the mount still call the old package runtime, so they do nothing until swapped for the records door.
