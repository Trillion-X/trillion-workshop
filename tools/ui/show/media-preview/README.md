# media-preview

The picture that stands in for one record in a list, gallery or board: an image, a video's first frame, a document's first page, a recording's waveform, a passage of the record's text, or its type and name.

## Files

| File | Purpose |
|------|---------|
| `MediaPreview.tsx` | The component, its open renderer map and `mediaPreviewContent`. |
| `MediaPreview.test.tsx` | Width chosen from drawn size × density and re-chosen only after a resize settles, width addressing, shimmer until load, no shimmer on remount of a loaded picture, type-icon fallback on error, unknown renderer, waveform bars from peaks once on screen, text passage and its fallback. |
| `made-preview.tsx` | Previews made in the browser when no server made them: a still, a strip of small frames and a waveform, a camera raw photo's own preview JPEG (read by range from its TIFF structure, never its sensor data), a written file's opening lines, read from and kept in a caller's store by content identity, one file at a time. Makers are an open map by content type. |
| `document-page-maker.ts` | `documentPageMaker()`: a PDF's first page drawn with the page reader (pdf-reader.ts), only when a document tile is first made. |
| `pdf-reader.ts` | `servePdfReader({module, worker})` (the host says once where it serves pdf.js, Apache-2.0) and `pdfReader()` (the one loader, loaded the first time a PDF is drawn; rejects when the host serves none). Shared by tile covers and the file preview's pages viewer. |
| `heif-picture-maker.ts` | `heifPictureMaker({module, largest_bytes}, native?)`: a HEIC/HEIF photo's still, from the browser's own decoder when it has one (Safari), else decoded with libheif (LGPL-3.0, WebAssembly) loaded from the address the host serves it at, only when such a tile is first made. |
| `index.ts` | Public exports. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `MediaPreviewProps` | `{renderer: string; source?: string; peaksUrl?: string; peaks?: number[]; frames?: FrameStrip; text?: string; title: string; typeLabel?: string; icon?: string; sourceWidths?: PictureWidths}` | What a caller hands over: a renderer id, addresses, text and the record's name, and the widths its picture is kept at. |
| `FrameStrip` | `{source, count, width, height}` | `count` small frames side by side in one picture; the pointer across a video tile shows the frame under it. |
| `MadePreview` | `{poster?, video_poster_version?, frames?, peaks?, duration?, lines?}` | What made-preview makes for one file. A video poster waits for the browser to present the sought frame, with the wait armed before the seek (a browser presents the frame before `seeked` and calls back only for frames presented after the request), and a video of unknown length is played muted for one frame and paused on it; `test/media-preview-real-video.test.mjs` proves both in Chromium; the version marker refreshes older cached posters once. `lines` is a written file's opening lines with their line breaks kept; it replaced a `text` field that folded them, so a preview kept in that older shape is made again once. |
| `PREVIEW_MAKERS` | `Record<string, PreviewMaker>` | Open map of makers by content type: the full type is asked first, then the part before the slash (`video`, `image`, `audio`, `text`, `application/json` built in; a host adds more, e.g. `application/pdf`). |
| `PreviewMaker` | `(url, sizes) => Promise<MadePreview>` | Shape of one maker. |
| `documentPageMaker` | `() => PreviewMaker` | A document's first page as its still, drawn by `pdfReader()`. |
| `servePdfReader` | `(address: PdfReaderAddress) => void` | The host names, once, where it serves the page reader and its worker. |
| `pdfReader` | `() => Promise<PdfReader>` | The served page reader, loaded once; rejects when the host serves none. |
| `PdfReader`, `PdfDocument`, `PdfPage`, `PdfViewport`, `PdfLoading`, `PdfTextLayer` | the parts of pdf.js this code uses | Typed seam over the served reader. |
| `embeddedJpegIn` | `(head: Uint8Array) => {offset, length} \| null` | The largest drawable JPEG a TIFF-shaped picture carries (IFD chain and sub-pictures; sensor data, >8-bit or colour-grid, is never chosen). |
| `openingText` | `(bytes, length) => string` | A written file's opening lines: each line's spaces folded and its end trimmed, runs of empty lines folded to one, line breaks kept, cut at `length` with an ellipsis. |
| `MadePreviewStore` | `{read(identity), keep(identity, made)}` | Where made previews are kept (Trillion: a namespace result of kind `preview`). |
| `readOrMakePreview` | `(identity, url, contentType, store, sizes?) => Promise<MadePreview \| null>` | Reads a saved result first. A visible stored video asks its file owner for a current poster before browser decoding its original; an owner refusal stays a refusal, while a terminal result allows the browser fallback. A newly uploaded `blob:` video is made directly from the local file. Video posters wait for the decoded frame and old posters are regenerated once; up to four browser-made previews run together. One answer per identity per page. |
| `readOrMakeFrames` | `(identity, url, contentType, store, sizes?) => Promise<MadePreview \| null>` | Makes a video's scrub strip on pointer intent and updates the same kept preview. At most one strip is made at a time. |
| `settledPreview` | `(identity) => MadePreview \| null \| undefined` | What this page already read or made for a file, for a caller drawing synchronously (a hover card opened on a tile that already showed its pictures). |
| `MadeMediaPreview` / `madeMediaPreviewContent` | `MediaPreviewProps & {identity, url, contentType, store}` | A MediaPreview fed by the made previews. Only nearby tiles read or make one; video scrub strips wait for pointer intent. |
| `PictureWidths` | `{query_key: string; widths: number[]}` | The widths a picture address can be asked for, and the query key that asks. |
| `pictureWidthFor` | `(drawn: number, widths) => number` | Smallest declared width at least `drawn` device pixels, else the largest. |
| `sourceAtWidth` | `(source, key, width) => string` | The address with `key=width` appended, the rest left as written. |
| `MediaPreview` | `(props: MediaPreviewProps) => ReactElement` | Draws the renderer named by `props.renderer`, or type-icon when none is registered under that id. |
| `mediaPreviewContent` | `(spec: MediaPreviewProps) => ReactElement` | The element, for hosts that place React elements (record-views field `render`). |
| `MEDIA_PREVIEW_RENDERERS` | `Record<string, (props) => ReactElement>` | Open map of renderers: `image`, `video-poster`, `document-page`, `video-frame` (one frame of the video at `source`, at `at` seconds, read by range: a search result shows the moment it found), `waveform`, `text-snippet`, `markdown-snippet`, `type-icon`. |
| `MediaPreviewRenderer` | `(props: MediaPreviewProps) => ReactElement` | Shape of one renderer. |

A saved version-1 video still with explicit `duration: 0` is provisional: a live WebM can present a black opening before its length is known. The shared preview reader and page primer ask the file owner again for a scored poster instead of keeping that still forever.

## Behaviour

- Pictures show a shimmer until `load`, then fade in; on `error` they draw the type icon with the name. A picture already loaded once in the page paints at once when its tile remounts (virtualized galleries remount tiles while scrolling).
- `waveform` reads `{peaks: number[] 0..1}` from `peaksUrl` once per address, only when the tile is on screen (one shared IntersectionObserver), and draws one SVG bar per peak.
- `waveform` with `peaks` draws them at once with no request.
- A picture renderer with `frames` scrubs: moving the pointer across the tile shows that moment's frame from the strip (cropped to the tile, never stretched) with a bar along the bottom saying how far in; leaving returns the still.
- `text-snippet` shows `text` in its own lines, clamped to whole lines, with the type mark; no text draws the type icon.
- `markdown-snippet` shows `text` read as markdown by the one markdown renderer (`document-page` `markdownHtml`, links as their words) in `MarkdownBlock`: a heading is a bold line and a quote an indented line, never their `#` or `>`; clamped and marked like `text-snippet`.
- A host that floats controls over a tile's top (a gallery card's select box and menu) sets `--media-preview-overlay-top` to their height, and a snippet's words start below it.
- With `sourceWidths`, a picture asks for the smallest kept width still sharp at its drawn width times the screen's pixel density (one shared ResizeObserver). After a resize (a zoom) settles for 180 ms it asks again; the new width loads beside the one showing and replaces it once decoded, so zooming never flashes the shimmer. A gallery zoomed far out therefore decodes 64 px thumbnails, not full pictures.
- The preview fills its host box (`width/height: 100%`); the host decides the size.

## Dependencies

**Depends on:** `../icon` (`NamedIcon`), React, `screen-look/show/media-preview.css` for appearance.

**Depended on by:** `../hover-preview` (its screens), Trillion Files, Media and search results (`src/workspace/file-picture.ts` `filePicture`, the kinds as DATA in `src/workspace/file-previews.json`; the PDF maker registered in `src/workspace/made-previews.ts`), the Expansion Library (`media-workspace` `shared-controls-entry.ts` exports `mediaPreviewContent`; `preview-renderers.json` chooses the renderer per record as DATA).
