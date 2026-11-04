# parts/

Libraries Trillion's Worker and scripts use, kept in this repository so the build reads nothing outside it. The workspace's parts (sidebar, screen-arrangement, screen-look, ui, group, formula-engine and the ones they reach) came from bitfield-packages with their runtime imports pointed at `src/workspace/records.ts` (`#workspace-records`); a README inside one of them describes its whole source package, some of whose files were not brought in. The open-source Workshop tools (unit economics, customer follow-up, the people tools, reading a web page and more) are not here: they live in the public repository github.com/Trillion-X/trillion-workshop, installed as the `trillion-workshop` module and read through `records/tool-folders.json`. Each folder is one part; `part.json` lists the files code outside the part may import, and `scripts/check-bundle-part-boundaries.mjs` stops the Worker build when the bundle reaches any other file.

## Files

| Folder | Purpose |
|--------|---------|
| `account-session/` | Which browser session is signed in (`read-data/read-browser-session.ts`), for the shared screens that ask. |
| `addressed-marks/` | Marks a person places on a screen (`show/AddressedMarkOverlay.tsx`) and the mark operations they send. |
| `ai-tool-catalog/` | Reads and admits tool rows, derives rows from a source list, talks to remote tool servers (MCP). |
| `calendar-booker/` | Open slots, busy times, calendar events and invitation files for bookings. |
| `capability-effect-lifecycle/` | Current state of a paid capability from its payment events (`data/effect-lifecycles.json`). |
| `choose-per-observer/` | Picks one candidate per visitor for price experiments. |
| `command-palette/` | Find anything: the command palette ported from the Bitfield package (`show/CommandPalette.tsx`, `show/CommandPaletteGate.tsx`), drawn by `src/workspace/command-palette.tsx` as an ordinary screen in a floating window. |
| `documents/` | bitfield-packages `packages/documents`, whole and verbatim but for the differences `scripts/port-sources.json` lists: the documents surface the Write screen mounts (`show/mount-documents.tsx`, `show/DocumentsSurface.tsx`: pages, blocks, insert menu, floats, splits, tables), and the message box's editor (`show/DocumentEditor.tsx`, `read-data/document-value.ts`) built on the package's own read-data. |
| `document-sections/` | bitfield-packages `packages/document-sections`, verbatim: place one named section into a markdown document, and build a section's bytes from a list of entries (Node; `do-work/append-section.mjs`, `do-work/build-entries-section.mjs`). |
| `page-critic/` | Judges public pages against the saved craft rules at every width they name (heading measure, body width, eyebrows, edge padding, broken anchors and links, cards that cannot open, stale dates, endless pages, controls with no hover look, test or placeholder data, tiny or stretched pictures, duplicate cards, stale or broken live demos and clips) and keeps a picture of each width with every finding boxed; the Workshop tool `tool:critique-a-public-page` (`records/workshop-browse-tool-records.json`), asked every day by the `public-pages-craft` check (`src/capability-checks.json`). |
| `process-session/` | The part of bitfield-packages `packages/process-session` the documents surface imports: a session's live output and starting one (imports at `#workspace-records`). |
| `eeaf/` | The decomposed SQLite store each person's decisions lived in before `record-log/`; a store still on it is moved across and its tables dropped (`src/record-move.mjs`). |
| `record-log/` | The SQLite store each person's records live in: one log row per write, records and field indexes packed as pages, reads from bounded memory (`do-work/record-log-store.mjs`, `do-work/kept-runs.mjs`). |
| `slot-table/` | A current view where a key becomes a small integer once and every later read or write is a typed-array index: kind, version, size and hot fields declared as DATA kept in typed columns, generation-checked handles, bounded by bytes with a CLOCK sweep (`do-work/slot-table.mjs`); the record store keeps its resident records in it. |
| `funnel-offer-graph/` | Funnels as DATA resolved into measured stages and drawn as a tornado (`show/FunnelCanvas.tsx`), for the Funnels screens. |
| `formula-engine/` | Rule operators (`rules/rule-operators.json`), the record filter (`rules/filter-records.mjs`) and its compiled evaluator (`built-stored-bytes/evaluate-over-rows/`), used by the workspace's filters. |
| `guided-overlay/` | Guided tours over the workspace: one host runs any tour given as DATA (`src/workspace/walkthroughs/*.json`), keeps the person's progress in their own store, and lists tours to take again (from bitfield-packages `packages/guided-overlay`). |
| `graph-canvas/` | The zoomable canvas (`show/GraphCanvas.tsx`, `show/CanvasView.tsx` with its dot grid, `show/types.ts`) the pane map, workflow graphs and funnels draw on. |
| `headless-browser/` | The switches every local Chromium starts with (`quiet-switches.json`: no login keychain prompt on a Mac) and `launch.mjs` (`launchChromium`, `launchPersistentChromium`) that every browser test and proof script launches through; `test/every-browser-launch-is-quiet.test.mjs` refuses any other launch. |
| `group/` | Folders, saved layouts and sidebar lists as one group graph (`read-data/`, `do-work/`); the workspace answers `group.load-graph` and `group.apply-mutation` with it. |
| `http-client/` | `sender-config.json`: the request sender's own config DATA for each person's locked box. `do-work/public-address.mjs` (`publicAddress`, `fetchPublic`, `privateHost`, `NotPublicAddress`): the one test of where the service may send a request to an address someone else gave it (no private, loopback, link-local, metadata or private-name host; ranges and names are DATA in `do-work/public-address.json`) and the one way to send it, judging every redirect again. |
| `live-namespace/` | The folder uploader a customer runs, the chunked sender every uploader shares (`do-work/send-a-file-to-a-namespace.mjs`: content-defined chunks, one window of chunks in flight per person (`do-work/send-window.mjs`: it opens while the service takes chunks and halves when it answers busy, numbers in `send-settings.json`), `sendFiles` in the browser sender sends many files at once (small ones many to a request, larger ones side by side), a file opens while it uploads, a file still being written is sent as it grows with its length fixed at the end (`growingFileSource`), chunks a reader waits for go first, chunks already held are never resent), the chunker it loads (`do-work/content-chunks.mjs`, compiled bytes in `built-stored-bytes/content-chunks/`) and the namespace client. |
| `local-files/` | The request a shared screen sends to reach local files (`read-data/invoke-local-files-target.ts`). |
| `media-playback/` | The shared player (`show/MediaPlaybackSurface.tsx`, with `MediaFrame`, `PlaybackControls` and the read-data types it names), from bitfield-packages `packages/media-playback`: every video and sound the workspace and the show_file view play. |
| `media-composition/` | The video editing scripts the Workshop's media tools run in the tool container (`do-work/`, `read-data/`) and those tools' rows (`records.json`). |
| `public-sales-page/` | Sales and landing pages from one row of DATA each, written through the shared page writer as the Workshop tool `tool:write-a-sales-page` (`records.json`), the page kept in the person's files. |
| `receive-files-over-ftp/` | A receiver on a computer on a device's network that takes the files a device pushes over FTP (a camera's automatic transfer after each recording) and sends each on into the person's namespace at once; devices and their setup screens are DATA (`devices.json`). |
| `record-a-web-page/` | Records a web page as a demo: a headless Chromium plays a list of steps (click, hover, type, press, scroll, wait, go) while its frames are kept, then a large pointer, click ripples, zoom toward each step and marked step pictures are drawn over them; the Workshop tool `tool:record-a-web-demo` (`records/workshop-recording-tool-records.json`). |
| `screen-arrangement/` | Tabs, panes, dragging between panes, saved layouts and the pane map (`show/mount-screen-arrangement.tsx`, `show/ArrangementNavigator.tsx`); its layout math is `crates/screen-arrangement`. |
| `screen-look/` | The looks (themes as records, `read-data/`) and the stylesheets the shared screens use (`show/*.css`). |
| `screen-ready-records/` | `read-data/read-screen-ready-records.ts`, the record reader media-playback's read-data types sit beside (from bitfield-packages `packages/screen-ready-records`). |
| `service-connections/` | Connect, disconnect and rename a service; `records.json` holds the service descriptors and how-to-ask rows, `work-contract.json` the one record the Worker bundles. |
| `sidebar/` | The app sidebar: rows, icons, names, hover cards and actions, collapsible collections, a collection that hosts a panel (`show/mount-sidebar.tsx`). |
| `signed-event-effects/` | Verifies a signed event and runs its effects once (`records.json`). |
| `stdio-mcp-gateway/` | `do-work/gateway.mjs` (`createGateway`): serves stdio MCP servers (each app is DATA: the command that runs it) as streamable-HTTP ones at `/<app>/mcp`, with a session id, bounded sessions, idle reaping and a working folder per session. `do-work/serve.mjs`: runs it as a web server from a config file. Hosted by `src/hosted-mcp-apps.mjs`. |
| `stripe-payment-provider/` | Stripe signatures, webhook mapping, request building and payment links. |
| `timed-action/` | Scheduled work as DATA: recurring schedules in IANA zones with daylight-saving handling, one-off actions and their receipts, and `do-work/when-to-wake.ts`, the one call a Durable Object alarm makes to learn what is due and when to wake next. |
| `ui/` | The shared page writer (`show/server-rendered-page/`), declared selectors, and every shared control the workspace draws with (record views, dropzone, notifications, guide, breadcrumb, tooltips, `show/coss/`). |
| `workflow-canvas/` | A job's steps drawn as a graph with each step's state and what it handed back (`show/StepGraph.tsx`), the curved edge and the layered layout, for the Workflows screens. |

## Key Types / Functions

Each part's public files are listed in its `part.json` (`{ "public": ["<file or folder>", ...] }`). A part may also list `side_effects` (`["*.css"]`): the only files that do something merely by being imported; every other file of the part is then left out of a browser bundle when nothing it exports is used (`scripts/part-side-effects.mjs`, used by `scripts/build-workspace.mjs`), so importing one component from a part's index does not carry the whole part.

## Dependencies

**Depends on:** `@noble/hashes` (live-namespace), React, lucide-react, Base UI, Radix and Tailwind (the workspace parts, package.json), Node built-ins for the scripts that run on a computer.

**Depended on by:** the Workshop's tool container (the parts whose `records.json` rows run there, bundled by `scripts/tool-bundles.mjs`, found by name through `records/tool-folders.json`), `src/` (the Worker), `src/workspace/` (the signed-in workspace, built by `scripts/build-workspace.mjs`), `scripts/` (build, deploy, workshop rows), `test/`.
