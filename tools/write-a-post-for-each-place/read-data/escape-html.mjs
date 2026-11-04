// parts/ui/show/server-rendered-page/escape-html.mjs
//
// Purpose: the one HTML escape every server-side sink in parts/ui/show shares (page sections, the document page,
// the share row), in a module that imports nothing, so any sink can use it without importing another sink.
// Invariant: text escaped here is safe inside an element and inside a single- or double-quoted attribute.

/** HTML-escape text going into an element or a quoted attribute. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
