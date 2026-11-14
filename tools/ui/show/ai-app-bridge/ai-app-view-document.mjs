// file: parts/ui/show/ai-app-bridge/ai-app-view-document.mjs
//
// THE PAGE AN AI APP LOADS TO DRAW A TOOL'S VIEW.
//
// An AI app (ChatGPT, Claude) draws a tool's result only through a view the tool names: a small HTML document the app
// loads in its own sandboxed frame (the MCP Apps standard, `text/html;profile=mcp-app`). This is that document for
// every view Trillion offers: an empty host, the view's copy as JSON, and the script and stylesheet that fill it,
// served from the service's own origin (which the view's CSP admits).
//
// Invariants
// - The document holds no markup beyond its host and no behaviour of its own.
// - Only the given script and stylesheet addresses are loaded; the copy travels as JSON, never as markup.
// - `baseUrl`, when given, is where the view's own relative addresses point (the service, never the app's frame).
// - `inlineCss`, when given, is the look and shell styles the document carries itself (one <style>, before the link).
// - `importMap`, when given ({ imports }), names what bare module names resolve to before the script runs (a module the
//   view imports later, such as a tool's own screen, by the same name the service's own page gives it).
// - IT LIVES IN THE SHARED UI PART because it is an HTML sink: callers hand copy and addresses, never tags.

import { escapeHtml } from '../server-rendered-page/page-sections-html.mjs';

/** The whole view document. `hostId` is the element the script fills and `wordsId` the JSON holding `words` (`title`
 * and whatever the script shows in words); `module` loads the script as a module (it imports its other files); `importMap` names its bare imports. */
export function aiAppViewDocument({ hostId, wordsId, words, scriptUrl, stylesheetUrl, module = false, baseUrl = null, importMap = null, inlineCss = null }) {
  const copy = JSON.stringify(words).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(words.title)}</title>`
    + (baseUrl ? `<base href="${escapeHtml(baseUrl)}">` : '')
    // The look and the shell's own styles travel inside the document, ahead of the linked stylesheet, so the view wears
    // the person's look even when nothing else can be fetched. The linked sheet, when it arrives, refines them.
    + (typeof inlineCss === 'string' && inlineCss ? `<style>${inlineCss.replace(/<\/style/gi, '<\\/style')}</style>` : '')
    + `<link rel="stylesheet" href="${escapeHtml(stylesheetUrl)}">`
    + (importMap && typeof importMap === 'object' ? `<script type="importmap">${JSON.stringify(importMap).replace(/</g, '\\u003c')}</script>` : '')
    + '</head>'
    + `<body><div id="${escapeHtml(hostId)}"></div><script type="application/json" id="${escapeHtml(wordsId)}">${copy}</script><script${module ? ' type="module"' : ''} src="${escapeHtml(scriptUrl)}"></script></body></html>`;
}
