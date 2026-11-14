// The parts of an HTML document, for code that has one and needs the other.
//
// WHY THIS EXISTS. This package composes documents from fragments all day: `pageShell` wraps a body,
// `fallback_body_file` names a FRAGMENT, `injectRoot` splices into a document. It had no name for
// the boundary in the other direction, so anyone holding a document and needing the fragment had two
// options, both bad: hand-copy the markup, or write a regex at the call site and get a different one
// each time.
//
// Knows nothing about who made the document or what the fragment is for.

/**
 * What is inside a document's `<body>`, or the input unchanged when there is no body element.
 *
 * Returning the input for a fragment is the honest answer rather than a refusal or an empty string:
 * a fragment is already what the caller asked for. It also makes this idempotent, so a pipeline that
 * runs it twice cannot quietly empty a page, which is the failure mode of every "strip the wrapper"
 * helper written at a call site.
 *
 * The opening tag is matched up to its own `>` so `<body class="x">` is handled, and the LAST
 * `</body>` closes it so a document that mentions the string in a script or a comment does not
 * truncate the page at the mention.
 */
export function bodyOf(document) {
  if (typeof document !== 'string') return '';
  const opening = /<body\b[^>]*>/i.exec(document);
  if (!opening) return document;
  const start = opening.index + opening[0].length;
  const end = document.toLowerCase().lastIndexOf('</body>');
  if (end < start) return document.slice(start);
  return document.slice(start, end);
}
