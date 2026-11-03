# tools/keep-open-screens-in-step-with-changes/

Keeps an open screen in step with the person's store: one live socket per browser (the tab holding the stream lock owns it and hands every frame to the other tabs; when it leaves, the next tab takes over), each change named by the records and fields it touched so a screen reads again only when something it showed changed (`src/record-depends.mjs`), and the live protocol's batched events, numbered requests, hello on connect and detection of missed updates (`src/live-protocol.mjs`). A reconnect names the last numbered change it heard (`epoch`, `after`) and the store replays what it missed in order; after a gap, or a revision that does not follow the last one heard, every screen reads itself again.

Moved here byte for byte from Trillion-X/trillion; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Files

| File | Purpose |
|------|---------|
| `src/workspace/store-changes.ts` | `onStoreChange`, `onRecordsChange`, `onLiveEvent`, `keepFresh`, `liveFreshness`, `watchWindow`, `whileWriting`: the page side of the live stream. |
| `src/workspace/tab-leader.ts` | `leadBrowser` and `inOneTab`: one tab leads a job through Web Locks; without them every tab is its own leader. |
| `src/workspace/first-answers.json`, `src/workspace/store-change-reads.json` | The timing and the reads a change wakes. |
| `src/record-depends.mjs` | `touches`, `writesOf`: which reads a change touches. |
| `src/live-protocol.mjs`, `src/live-protocol.json` | The live protocol both ends speak. |
| `part.json` | The tree that imports these files. |
| `test/store-changes-*.test.mjs` | Old trillion's stream tests with their assertions unchanged: one stream for two tabs, remount, resume, the early socket. |
| `test/tab-leader.test.mjs` | Old trillion's tab-leader tests (from `test/client-data-layer.test.mjs`) with their assertions unchanged. |

## Known failing

`test/store-changes-one-stream.test.mjs` fails its takeover assertion ("the second tab opened the stream when the first left", 1 !== 2). It fails the same way in old trillion at b92aa549f2 with the same bytes; it is moved unchanged, not skipped.

## Dependencies

**Depends on:** a browser's WebSocket, BroadcastChannel and Web Locks (the tests stand in for them); Node 24 for the tests.
