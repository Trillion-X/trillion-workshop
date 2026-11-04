// file: parts/ui/show/file-view-document/file-view-bridge.mjs
//
// HOW A VIEW AN AI APP DRAWS HEARS WHICH FILE TO SHOW.
//
// An AI app (ChatGPT, Claude) hands a tool's view the tool's result by either of two roads: the MCP Apps bridge (the
// view sends `ui/initialize`, then `ui/notifications/initialized`, and the app sends `ui/notifications/tool-result`),
// or ChatGPT's own `window.openai.toolOutput` (announced by `openai:set_globals`). Whichever arrives first is shown;
// the same file arriving again by the other road is ignored.
//
// Invariants
// - Only a file whose `url` is an https address is handed on; anything else is ignored.
// - Nothing here draws: the caller hands `show(file)`, and `reportSize()` tells the app the height the view needs:
//   where `content` (the element the view fills) ends, so the frame shrinks to the file and never keeps empty space.
// - A view never waits forever: a tool result with no file in it (the file was not found, the call failed) calls
//   `noFile(reason)` at once, and no result at all within `waitMs` calls `noFile(null)`. A file arriving later is
//   still shown.
// - What the tool left for the view alone (the result's `_meta` under FILE_VIEW_DATA_KEY, ChatGPT's
//   `toolResponseMetadata`) is handed on with the file, such as a text file's `first_text`.
// - `win` is the view's window, passed in so the bridge runs the same in a browser and in a test.

import { connectToAiApp } from '../ai-app-bridge/ai-app-bridge.mjs';

/** The key under a tool result's `_meta` holding what only the view reads (the app hands `_meta` to the view, never
 * to the AI): `{ first_text: { text, shown_bytes, byte_length } }`, a text file's first part, so the view shows it
 * without reading the file's address from a frame that may refuse the read. */
export const FILE_VIEW_DATA_KEY = 'trillion/file-view';

/** Starts listening. `show` receives `{ url, media_type, name, first_text?, ... }`. Answers `{ reportSize, stop }`. */
export function listenForShownFile(win, show, { protocolVersion = '2026-01-26', appName = 'file-view', noFile = () => {}, waitMs = 20000, content = null } = {}) {
  let shown = null;
  let gaveUp = false;
  const giveUp = reason => { if (shown || gaveUp) return; gaveUp = true; noFile(reason); };
  const timer = (win.setTimeout ?? setTimeout)(() => giveUp(null), waitMs);
  // What a result without a file says went wrong, in the tool's own words when it gave any.
  const reasonOf = result => [result?.error, result?.message, ...(Array.isArray(result?.content) ? result.content.map(block => block?.text) : [])]
    .find(text => typeof text === 'string' && text.trim())?.trim().slice(0, 300) ?? null;
  const offer = (file, meta) => {
    if (!file || typeof file.url !== 'string' || !/^https:\/\//.test(file.url) || shown === file.url) return false;
    shown = file.url;
    (win.clearTimeout ?? clearTimeout)(timer);
    const forView = meta?.[FILE_VIEW_DATA_KEY];
    show(forView && typeof forView === 'object' ? { ...file, ...forView } : file);
    return true;
  };
  // Both roads an app hands a result by are spoken by the one bridge (../ai-app-bridge/ai-app-bridge.mjs).
  const app = connectToAiApp(win, {
    appName, protocolVersion, content,
    onToolResult: ({ structuredContent, meta, content: blocks }) => {
      if (!offer(structuredContent, meta) && !shown) giveUp(reasonOf(structuredContent) ?? reasonOf({ content: blocks }));
    },
  });
  return {
    reportSize: app.reportSize,
    stop: () => { (win.clearTimeout ?? clearTimeout)(timer); app.stop(); },
  };
}
