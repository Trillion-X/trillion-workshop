# tools/read-a-page-in-arc/

Reads pages in the person's Arc browser through its AppleScript interface, for browser work when no browser extension is connected. Arc is the browser the person is signed in to, so pages behind sign-in can be read.

Two tools live here:

- `tool:read-a-page-in-arc` (`read-a-page-in-arc.mjs`): opens one public page, reads its title, address and visible text (at most 20000 characters), and closes its own tab through the shared id-addressed Arc calls.
- `tool:pull-a-page-in-arc` (`pull-a-page-in-arc.mjs`): pulls one page, signed in. It scrolls the page to its end, answers the whole text (cut at `text.most_chars`, with `truncated`), can answer every link (`links`), can read the linked pages one after another (`follow`), and can save one file the page exposes (`save`), named by the BLAKE3 of its bytes under the save root. Downloads are only written, never opened; nothing is filled, submitted or clicked.

## Files

| File | What it is |
| --- | --- |
| `read-a-page-in-arc.mjs` | The short read tool, using the shared id-addressed Arc calls. |
| `pull-a-page-in-arc.mjs` | The pull tool: input checks, the page read, links, follow, save. Its bounds are read from `pull-settings.json`. |
| `arc-tab.mjs` | The three Arc calls a pull makes (open a tab, run one piece of JavaScript in it, close it), each one osascript call. Arc answers a string as an AppleScript literal, so `evaluate` decodes it twice. |
| `page-scripts.mjs` | The JavaScript that runs in the page, one piece per call: readiness, scroll steps, the kept text and its pieces, links, the download and its pieces. Every value comes back as ASCII JSON. |
| `pull-settings.json` | Every bound of the pull as DATA: wait, scroll, text, links, follow, save (root, bytes, export formats). |
| `what-this-tool-does-and-how-to-run-it.json` | The Workshop rows for both tools. |
| `part.json` | The exports and the public entry programs. |
| `test/read-a-page-in-arc.test.mjs` | The read tool against Arc: example.com. |
| `test/arc-tab-retry.test.mjs` | Offline osascript error fixtures: bounded connection retries, terminal permission/syntax/missing-tab failures, and cleanup of only the run's tab. |
| `test/fixtures/engine-invocation.json` | Synthetic input with the engine's scoped app-target shape; no live content or authority. |
| `test/pull-a-page-in-arc.test.mjs` | Both programs accept the descriptor's stdin input against a fake Arc (no browser); the pull's refusals, bounds, chunks, scroll, links, follow and save. |
| `test/pull-a-page-in-arc.live.test.mjs` | The pull against the real Arc: example.com with its links, the signed-in Google Doc saved as text, and a Notion page before and after scrolling its pane. |

## Reading a page

- Every Arc call names its own tab by window id and tab id (`arc-tab.mjs`). Nothing works on "the active tab", so two reads at once each read their own page. Each answer checks that the tab is on the host that was asked for; a redirect to another host is refused and the tab is closed.
- A Notion page (`notion.site`, `notion.com`, `notion.so`) is read through the page's own API inside the tab (`loadPageChunk`, then `syncRecordValuesSpace` for children that were not loaded), with no clicks. Toggles and child pages are included in block order; child pages are answered as links. If the API refuses, the page is read by scrolling and `notion_error` says why.
- A `scroll_selector` that matches nothing falls back to scrolling the window; `scroll.pane_found` says whether the pane was found.

## Notion attachments

- `save_attachments: { folder }` on a Notion page saves each file the page attaches (file, pdf, image, video, audio blocks and `attachment:` links). The reader asks Notion for each file's signed address (`getSignedFileUrls`, inside the tab), then Arc downloads it as in the save route below. Each file is named by its BLAKE3 with its own extension, listed under `attachments` with its `original_name`. Nothing is opened or unpacked.

## Save

- A Google Doc is read from its own HTML page (`/mobilebasic`) with the person's sign-in, and saved as `txt` (the visible text, converted in node) or `html` (the bytes as fetched). Its export address (`/export?format=`) cannot be used from Arc: the fetch fails with "Failed to fetch" for every format, because the export redirects to another origin without CORS headers.
- A Google Sheet or Slides export, a Drive file (`drive.usercontent.google.com/download`), or `save.file_url` is fetched in the tab the same way. When Arc refuses that fetch (a cross-site file: "Failed to fetch"), the file is saved by Arc's own download instead: its address opens in a tab of its own, the finished file (no `.crdownload` partial beside it) is taken from `save.downloads_folder` and moved into the save folder named by its BLAKE3. It is never opened or run. The answer then says `via: browser-download`.
- A file is written under `save.folder`, which must be inside the root in `pull-settings.json` (`~/Library/Application Support/pulled-pages-in-arc`). The name is `<BLAKE3 hex of the bytes>.<extension>`.

## Engine invocation

Both rows use `invoke.kind: computer`, declare `automate-an-app`, and forward the input on standard input with `invoke.stdin.fill.from: input`. The engine validates the caller and the target before starting the program. The scoped app input is:

```json
{"url":"https://example.com/","computer":{"automate-an-app":{"app":"company.thebrowser.Browser"}}}
```

The app target is a bundle id, not an application path, a stored permission or an instruction to widen access. The Mac binding also checks the responsible app's AppleEvents usage declaration; the OS can refuse Apple events even after the engine admits the run. A direct Node script does not exercise either check and does not prove the pinned tool works.

The app capability grants no folder access. The current rows declare no folder capabilities, so writing or moving files under the engine's containment is not proven by these descriptors or by direct-script saves. Folder access must be declared and scoped by the engine's owner before the pinned save modes can be accepted; the tool must not bypass containment.

Error handling keeps osascript's final diagnostic and code. Permission refusal (`-1743`), script syntax failure and a missing owned tab stop the pull's readiness check immediately; only transient connection failures and unready pages may be retried. A permission error does not identify which responsible app or OS setting needs changing, so the answer does not prescribe a settings change.

## Run

- Unit tests (no browser): `node --test tools/read-a-page-in-arc/test/arc-tab-retry.test.mjs tools/read-a-page-in-arc/test/pull-a-page-in-arc.test.mjs`.
- Live tests (Arc running and signed in to Google; they open tabs in Arc's front window, so run them when no other read is using Arc): `node --test tools/read-a-page-in-arc/test/pull-a-page-in-arc.live.test.mjs`.
- The read tool's test: `node --test tools/read-a-page-in-arc/test/read-a-page-in-arc.test.mjs`.

## Not proven

- Google Sheet and Slides exports, Drive file downloads and `save.file_url` from other origins are not proven live. The Doc rendition is the only saved Google file proven end to end. The browser-download path is unit-tested against a fake folder; its live check runs only when `DRIVE_FILE_URL` names a Drive file.
- Execute and close use owned tab/window ids, but browser downloads still share the Downloads folder. Concurrent saves are not associated with a particular download, so the caller must serialize save runs.
- The rendition's text is not Google's export: formatting is lost in `txt`, and the page's own structure is what `html` keeps.
- A page that loads its text only after a click is not read by the scroll path: the tool clicks nothing. A Notion page is read through its API instead, which needs no click.
- The offline descriptor/input fixtures do not exercise engine admission, the Mac sandbox or signed-in content. End-to-end acceptance still needs the existing workflow to invoke the Mac-pinned tool with its authorized app and folder scopes, save the result and read it back.
- A first script call on a heavy page can wait up to `wait.call_timeout_ms` before Arc answers; the readiness check retries until `wait.most_seconds`.
