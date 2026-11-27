# tools/show-any-file-as-itself

The screens that show a file in its own form: the file-content renderer (markdown, code, JSON, a picture, a diff or raw text, `show/`) and the file's media readers (`read-data/`) and frame; the shared player itself is `tools/media-playback`, drawn here through `show/lazy-playback-surface.ts`, moved from old trillion's `tools/file-content-renderer/` and `tools/media-playback/` (whose own READMEs are in `file-content-renderer/` and `media-playback/`). The screens need the workspace and a browser; the row runs the one part that needs neither, the classification that chooses how each file is shown.

## Files

| File | Purpose |
|------|---------|
| `do-work/classify-files.mjs` | `classifyFiles({ files: [{ path, mime_type? }] })` → `{ classified }`: each file's renderer, language, icon, label and media type, from the renderer's own deterministic fallback in `show/classify-file-content.ts` (what `what-this-tool-does-and-how-to-run-it.json` runs) |
| `what-this-tool-does-and-how-to-run-it.json` | The row `tool:choose-how-each-file-is-shown`, with a sample run that classifies a markdown file, a patch and a picture |
| `web/src/workspace/file-screen.tsx` | The File screen (`tool:screen-file`): one file in its own tab, shown by the one file preview, with its path above it, Share, the notes of a recording (transcript, summary, action items) and the use it reports to Recent. Moved byte for byte from the web client (`moved-from.json`); it imports the web shell's files as it was written, and the client build answers those imports with the shell's files. |
| `web/src/workspace/file-uses.ts` | The page's half of Recent: tells the person's store a file was used, and counts how long a recording really played so watched is said only after it played long enough. Only the File screen imports it. |
| `web/src/workspace/note-review.mjs` | The pure decisions behind a meeting note's Summary and Action Items tabs: items, their grouping by owner, the task each becomes and what a template and language ask the person's AI for. |
| `web/src/workspace/note-review-tools.tsx` | The tools on a meeting note's Summary and Action Items tabs: template and language, copy and PDF, a rating and the action items as tasks. |
| `web/src/workspace/note-transcript.tsx` | A recording's transcript on its note, over the shared transcript reader, with speaker names, links to a passage, another language, copy, PDF and splitting a passage. |
| `web/src/workspace/editable-text-document.tsx` | The editable text document the File screen shows for a text file the person may change. |
| `read-data/classify-ref.mjs` | `classifyRef(ref)` → `{ kind, src }`: `image`, `video`, `audio`, `page` (an https address or a relative file that is not a picture, video or sound; drawn in a frame) or `unsupported` (any other scheme). Decided from the text alone; opens and fetches nothing. |
| `show/ShowRef.tsx` | `ShowRef({ source, label })`: one ref drawn as itself (a picture, a video or a sound with its controls, or a page in a frame), with its label and an "Open in a new tab" link. Mounted only when its host draws it, so a closed row loads nothing. Used by the task page's opened rows. |
| `test/classify-ref.test.mjs` | Run with `node --test test/classify-ref.test.mjs`. |
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

The player itself, `MediaPlaybackSurface.tsx`, is the one copy in `tools/media-playback` (its picture-in-picture control follows the show rule; this folder's old copy hard-coded it), so this folder draws it through `show/lazy-playback-surface.ts`. `MediaFrame.tsx` and the readers here are kept as they were. What the package held and this folder did not is carried under its own paths in `from-bitfield-packages/media-playback/`, byte for byte, with `moved-from.json`: `read-data/read-media-queue.ts`, `read-media-transcript.ts`, `read-surface-media.ts` (the queue order, the transcript segments and the media a surface names), `do-work/reorder-queue.ts` and `record-playback-event.ts` (the two writes), `show/mount-media-playback.tsx` (the material the screen mounts), the package's records (`things-to-store-and-run.json`) and its twelve tests, which import vitest and are held (names end in `.held`). The two writes and the mount still call the old package runtime, so they do nothing until swapped for the records door.
## Files moved from bitfield-packages (packages/files)

Each file below is the package's own, byte for byte; `from-bitfield-packages/moved-from.json` names each source path and commit, the identity of its source bytes and of its bytes here, and the `calls` that made a real name or id made up. After the first commit only import paths changed. A file named `.held` is the same bytes with its test name taken off so the repository test does not run it; the reason is under `held` in the receipt. Most files import `@/packages/ui` and the retired package runtime (`@bitfield/runtime-kit`); the shared ui parts live in apps `tools/ui`, so the screens and targets here are prepared, not wired to a tool row.

| File | What it is |
|---|---|
| `show/FilesSurface.tsx` | A file of the package. |
| `show/FilesWorkspace.tsx` | A file of the package. |
| `show/mount-files.tsx` | A file of the package. |

### Not carried

- 3 files: generated build output of the retired package runtime (entry scope, built entry bytes); not carried
- 1 file: maps package entries to the retired package runtime's entry scope; not carried
- 1 file: the package boundary file: record contracts, actions and surfaces for the retired package runtime (slot workflows, owner targets); not carried

The receipt's `not_carried` names each path.
## The file-classification rule table (prepared restore)

`classify-file/src/classify_file.rs` is the original rule table of bitfield-packages `packages/file-classification`, byte for byte (65 rules: language, renderer hint, icon, label and MIME type from a path, no file read; three tests). `classify-file/Cargo.toml` and `src/lib.rs` are new and only make it a crate (`cargo test --offline --manifest-path classify-file/Cargo.toml`: 3 pass). `show/classify-file-content.ts` here is a smaller fallback of about two dozen extensions that asks the `file-classification` target first; the Rust table is what answered it. Nothing calls the crate yet.
