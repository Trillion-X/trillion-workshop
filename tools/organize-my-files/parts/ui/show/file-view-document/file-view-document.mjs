// file: parts/ui/show/file-view-document/file-view-document.mjs
//
// A PERSON'S FILE, SHOWN INSIDE THE CHAT THAT MADE IT.
//
// An AI app (ChatGPT, Claude) draws a tool's picture, video or sound only when the tool names a view: a small HTML
// document the app loads in its own sandboxed frame (the MCP Apps standard, `text/html;profile=mcp-app`). This is that
// document: an empty host, the app's copy, and the script and stylesheet that fill it. The script (built by the app,
// served from the service's own origin, which the view's CSP admits) hears the tool result through
// file-view-bridge.mjs and shows the file with the shared FilePreview: a video or sound plays in the shared player,
// read by range from its address, a picture fits and zooms.
//
// Invariants
// - The document holds no markup beyond its host and no behaviour of its own: presentation is the shared player's.
// - Only the given script and stylesheet addresses are loaded; the copy travels as JSON, never as markup.
// - IT LIVES IN THE SHARED UI PART because it is an HTML sink: callers hand copy and addresses, never tags.

// The page itself is the one view document every AI-app view uses (../ai-app-bridge/ai-app-view-document.mjs).
import { aiAppViewDocument } from '../ai-app-bridge/ai-app-view-document.mjs';

/** The id of the element the script fills, and of the JSON holding the copy. */
export const FILE_VIEW_HOST_ID = 'file-view';
export const FILE_VIEW_WORDS_ID = 'file-view-words';

/** The whole view document. `words` is the copy (`title`, and whatever the script shows in words); `scriptUrl` and
 * `stylesheetUrl` are the addresses of the view's script and look. */
export const fileViewDocument = ({ words, scriptUrl, stylesheetUrl }) => aiAppViewDocument({ hostId: FILE_VIEW_HOST_ID, wordsId: FILE_VIEW_WORDS_ID, words, scriptUrl, stylesheetUrl });
