# tools/read-a-page-in-arc/

Reads pages in the person's Arc browser through its AppleScript interface, for browser work when no browser extension is connected. Arc is the browser the person is signed in to, so pages behind sign-in can be read.

Two tools live here:

- `tool:read-a-page-in-arc` (`read-a-page-in-arc.mjs`): opens one public page, reads its title, address and visible text (at most 20000 characters), and closes its tab. Unchanged.
- `tool:pull-a-page-in-arc` (`pull-a-page-in-arc.mjs`): pulls one page, signed in. It scrolls the page to its end, answers the whole text (cut at `text.most_chars`, with `truncated`), can answer every link (`links`), can read the linked pages one after another (`follow`), and can save one file the page exposes (`save`), named by the BLAKE3 of its bytes under the save root. Downloads are only written, never opened; nothing is filled, submitted or clicked.

## Files

| File | What it is |
| --- | --- |
| `read-a-page-in-arc.mjs` | The read tool: one AppleScript run per page. |
| `pull-a-page-in-arc.mjs` | The pull tool: input checks, the page read, links, follow, save. Its bounds are read from `pull-settings.json`. |
| `arc-tab.mjs` | The three Arc calls a pull makes (open a tab, run one piece of JavaScript in it, close it), each one osascript call. Arc answers a string as an AppleScript literal, so `evaluate` decodes it twice. |
| `page-scripts.mjs` | The JavaScript that runs in the page, one piece per call: readiness, scroll steps, the kept text and its pieces, links, the download and its pieces. Every value comes back as ASCII JSON. |
| `pull-settings.json` | Every bound of the pull as DATA: wait, scroll, text, links, follow, save (root, bytes, export formats). |
| `tool-rows.json` | The Workshop rows for both tools. |
| `part.json` | The exports and the public entry programs. |
| `test/read-a-page-in-arc.test.mjs` | The read tool against Arc: example.com. |
| `test/pull-a-page-in-arc.test.mjs` | The pull against a fake Arc (no browser): refusals, bounds, chunks, scroll, links, follow, save, the row. |
| `test/pull-a-page-in-arc.live.test.mjs` | The pull against the real Arc: example.com with its links, the signed-in Google Doc saved as text, and a Notion page before and after scrolling its pane. |

## Save

- A Google Doc is read from its own HTML page (`/mobilebasic`) with the person's sign-in, and saved as `txt` (the visible text, converted in node) or `html` (the bytes as fetched). Its export address (`/export?format=`) cannot be used from Arc: the fetch fails with "Failed to fetch" for every format, because the export redirects to another origin without CORS headers.
- A Google Sheet or Slides export, a Drive file (`drive.usercontent.google.com/download`), or `save.file_url` is fetched in the tab the same way. Those were not proven live (see below).
- A file is written under `save.folder`, which must be inside the root in `pull-settings.json` (`~/Library/Application Support/pulled-pages-in-arc`). The name is `<BLAKE3 hex of the bytes>.<extension>`.

## Run

- Unit tests (no browser): `node --test tools/read-a-page-in-arc/test/pull-a-page-in-arc.test.mjs`.
- Live tests (Arc running and signed in to Google; they open tabs in Arc's front window, so run one at a time): `node --test tools/read-a-page-in-arc/test/pull-a-page-in-arc.live.test.mjs`.
- The read tool's test: `node --test tools/read-a-page-in-arc/test/read-a-page-in-arc.test.mjs`.

## Not proven

- Google Sheet and Slides exports, Drive file downloads and `save.file_url` from other origins are not proven live. The Doc rendition is the only saved Google file proven end to end.
- Two runs at the same time are not guarded: they share Arc's front window. The row runs one at a time only by the caller's care.
- The rendition's text is not Google's export: formatting is lost in `txt`, and the page's own structure is what `html` keeps.
- A page that loads its text only after a click is not read: the tool clicks nothing.
- Notion pages were read through `scroll_selector` `.notion-scroller` (the pane). A page with another scroll container needs its own selector.
