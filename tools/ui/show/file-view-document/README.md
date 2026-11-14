# file-view-document/

The HTML document an AI app loads to show one of a person's files inside the chat (the MCP Apps standard, `text/html;profile=mcp-app`), and how that view hears which file to show.

| File | Purpose |
|------|---------|
| `file-view-document.mjs` | Builds the view: an empty host, the copy as JSON, and the app's script and stylesheet (served from the service's own origin). Holds no markup or behaviour of its own |
| `file-view-bridge.mjs` | Listens for the tool result (MCP Apps `ui/notifications/tool-result` after `ui/initialize`, or ChatGPT's `window.openai.toolOutput`), hands on a file once, only with an `https` address, together with what the tool left for the view alone (the result's `_meta`, ChatGPT's `toolResponseMetadata`); says why at once when a result holds no file and stops waiting after 20 s; tells the app the height the view needs |

## Key Functions

| Function | Signature | Role |
|----------|-----------|------|
| `fileViewDocument` | `({ words: { title }, scriptUrl, stylesheetUrl }) => string` | The whole view document; the caller supplies the copy and the addresses |
| `FILE_VIEW_HOST_ID`, `FILE_VIEW_WORDS_ID` | `'file-view'`, `'file-view-words'` | The element the script fills and the JSON holding the copy |
| `listenForShownFile` | `(win, show, { protocolVersion?, appName?, noFile?, waitMs?, content? }) => { reportSize, stop }` | Calls `show({ url, media_type, name, first_text?, ... })` once per file; `noFile(reason)` when a result holds no file (the tool's own words) or nothing came within `waitMs` (20 000, `reason` null), a file arriving later still shown; `reportSize()` tells the app where `content` (the element the view fills) ends, by `ui/notifications/size-changed` and ChatGPT's `notifyIntrinsicHeight`, never the document's own height (a page stretched to its frame would keep the frame's first height as empty space) |
| `FILE_VIEW_DATA_KEY` | `'trillion/file-view'` | The key under a tool result's `_meta` for the view alone: `{ first_text: { text, shown_bytes, byte_length } }`, a text file's first part (`src/file-tools.mjs` `showFile` fills it) |

## Invariants

- The file is shown by the one file preview, FilePreview (a video or sound in the shared player, `media-playback`; a picture, PDF, text or code file, Office document, else its card), mounted by the app's script (Trillion: `src/workspace/file-view.tsx`), never by elements chosen here.
- Only an `https` address is ever handed on. The app's frame enforces the view's CSP, declared by the resource that serves it (`src/file-tools.mjs` `fileResources`): the script, stylesheet, file, the reads a text or document file needs (`connect`) and a PDF's page viewer (`frame`) come only from the service's own origin, and a read link answers any page (`access-control-allow-origin: *`), since it carries its own permission and no cookie, and answers a browser's `OPTIONS` question before a `Range` read the same way (the read itself still needs the lease).
- An app's frame may refuse the view's own reads anyway: ChatGPT does not always apply `connectDomains` (a CSP `connect-src` refusal shows the text viewer's "could not be read here" card). So nothing the view shows in the chat needs a read of its own: a picture, video, sound or PDF loads through elements the frame admits (`resourceDomains`, `frameDomains`), and a text file's first 64 KiB travels with the result in `_meta` (`FILE_VIEW_DATA_KEY`), never seen by the AI.
- The view never waits forever: a result without a file says so at once (the shared screen-state, status `empty`), and no result within 20 s stops the loading rows.

## Dependencies

**Depends on:** `../server-rendered-page/page-sections-html.mjs` (`escapeHtml`).

**Depended on by:** `src/file-tools.mjs` (the `show_file` tool's view, served as `ui://files/show-file.html`), `src/workspace/file-view.tsx` (the view's script), `test/file-view-bridge.test.mjs`.
