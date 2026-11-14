# file-preview

THE one preview of a file: a file opened in its own tab, the view an AI app draws for one file, and the file inside a hover card or carousel all draw through `FilePreview`. Which viewer draws a file is DATA.

## Files

| File | Purpose |
|------|---------|
| `FilePreview.tsx` | `FilePreview` and the open viewer map `FILE_VIEWERS`: video and sound in the shared player (`media-playback`), a zoomable picture, a PDF as its pages (page count, zoom, a strip of numbered pages when wide, selectable text; the browser's page viewer when the host serves no page reader), delimited text as a lettered grid, text and code read by range, an Office document / workbook / deck, else the file card with Download. |
| `file-viewers.json` | DATA: media-type prefix or extension → viewer id, first match wins; a named type decides alone, the extension speaks for a file whose type names nothing. A new kind of file is one row. |
| `choose-file-viewer.ts` | `chooseFileView` (viewer and its row's `settings`), `chooseFileViewer`, `namedType`, `extensionOf`: the one reading of `file-viewers.json`. |
| `read-delimited-text.ts` | `readDelimitedText(text, separator, partial?)`: delimited text (the separator a viewer row names) into rows of cells, quotes and line breaks in cells kept, bounded rows and cells. |
| `read-office-document.ts` | `readOfficeDocument`: a docx / xlsx / pptx read in the browser (zip directory, `DecompressionStream('deflate-raw')`, `DOMParser`) into paragraphs and tables, sheets of cell text, or slides. |
| `mount-file-preview.tsx` | `mountFilePreview(host, props)` for hosts that are not React; `update` swaps the file in place. |
| `KeptFiles.tsx` | `KeptFiles`: files a run made shown as the files themselves, each in `FilePreview` (a video or sound plays in place, a picture shows) with its name and an Open button; never its size or identity. `FilePreview` is fetched the first time a file is shown, so a screen that can show kept files (a chat, a tool's result) carries it only once one is there. |
| `FilePreview.test.tsx` | Viewer choice from DATA, Office reading (document, two-sheet workbook with relative and absolute links, refusal), text read by range with how much was shown, workbook grid and sheet tabs, document headings, PDF address, file card with Download, unreadable Office file shows its card. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `FilePreview` | `({url, contentType, label?, autoPlay?, poster?, glance?, firstText?, timedText?, onTimeChange?, seekRequest?, className?}) => ReactElement` | The file drawn by its viewer inside `.file-preview[data-file-viewer]`. `glance` is the small look (hover card): less is read, a picture shows `poster` first, no zoom controls. `firstText` (`{ text, shownBytes, byteLength }`) is a text file's first part the caller already holds: the text viewer shows it without reading the address (the view an AI app draws, whose frame may refuse reads). `timedText` (media-playback `TimedTextSegment[]`) is a sound's or video's words with their times: a sound shows them under its face, following the sound. `onTimeChange(seconds, duration)` tells a host following a sound or video where it is playing (and its measured length, from its metadata on); `seekRequest` (`{ requestId, seconds }`, a new id each time) moves it to a second. |
| `KeptFiles` | `({ files: { key, name, url, contentType }[], openLabel, onOpen(file) }) => ReactElement \| null` | A tool screen's "What it returned" draws each kept file through it; what Open does is the caller's. |
| `FILE_VIEWERS` | `Record<string, (props) => ReactElement>` | Open map: `video`, `sound`, `picture`, `pdf`, `text`, `markdown` (the same read as `text`, drawn as a formatted document by the one markdown renderer, `document-page` `markdownHtml`, in `markdown-block` MarkdownBlock: raw HTML shown as text, links open in a new tab), `office`, `table` (delimited text by the row's `settings.separator`, in the workbook grid), `file`. `pdf` draws pages through `media-preview/pdf-reader` when the host serves it. An unknown id draws `file`. |
| `chooseFileView` | `({contentType?, name?}) => {viewer, settings?}` | The viewer and its row's settings from `file-viewers.json`. |
| `chooseFileViewer` | `({contentType?, name?}) => string` | Viewer id from `file-viewers.json`. |
| `readDelimitedText` | `(text, separator, partial?, limits?) => {rows, cut}` | Rows of cells for the `table` viewer. |
| `namedType` | `(contentType) => string` | Lower-case type without parameters; `''` for a type that names nothing (`unnamed_types`). |
| `readOfficeDocument` | `(bytes: Uint8Array) => Promise<OfficeReading>` | `{kind:'document', blocks, cut}` \| `{kind:'workbook', sheets:[{name, rows, cut}]}` \| `{kind:'presentation', slides}`; throws for anything else. |
| `mountFilePreview` | `(host, props) => {update, destroy}` | Non-React hosts. |

## Invariants

- Video and sound play only in the shared player; no native media controls anywhere outside `media-playback`.
- No kind of file is named in code; `file-viewers.json` names them all.
- Reads are by range wherever the viewer can (player, page viewer, the first 1 MiB of text, the first 4 KiB in a glance). An Office file is read whole because its directory is at its end, up to 64 MiB; larger shows its card.
- Everything fits the box it is placed in; nothing unreadable is left blank.
- Appearance is `screen-look/show/file-preview.css`.

## Dependencies

**Depends on:** `media-playback/show/MediaPlaybackSurface`, `../media-preview/pdf-reader`, `../coss/ui/{button,spinner,table}`, `../icon`, `../cn`, browser `DecompressionStream` and `DOMParser`.

**Depended on by:** `../hover-preview` (every hover card and carousel screen), `files/show/FilesWorkspace` (a file dropped from the computer), Trillion (`trillion/parts/ui`, vendored: the file tab, the `show_file` view, Files hover cards).
