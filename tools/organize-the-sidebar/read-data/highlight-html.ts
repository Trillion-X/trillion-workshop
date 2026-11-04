// packages/group/read-data/highlight-html.ts
//
// SEARCH-MATCH HIGHLIGHTING for a note's rich text — the visible completion of the find UX: while a board
// search is active, the matched substring GLOWS inside each matching card (the browser-, Notion-, Figma-
// find canon), not just a dimmed/undimmed card. Given a note's `html` and the live query, it wraps every
// case-insensitive occurrence of the query in a `<mark>` (semantic content HTML — the same element the
// share sanitizer already allows, styled by the browser, zero inline CSS / L065) and returns the new html
// for the read-only `RichTextEditor` (`root.innerHTML = editorHtml`, re-seeded on change).
//
// It walks TEXT NODES ONLY inside an inert `DOMParser` document (never string-regex into markup): a match
// can only fall within one contiguous text run, so it NEVER splits across a tag, never corrupts an
// attribute, never breaks an entity, and formatting (`<strong>`, colour spans, links) is preserved
// exactly. Because it only ADDS `<mark>` around already-present text, it introduces no new innerHTML
// content the note didn't already carry — no new injection surface (the note html is the user's own,
// already sanitized at every untrusted boundary; see [[reference_untrusted_html_innerHTML_sink_in_share_chat_link_surfaces]]).
//
// Pure leaf (L069/L088): no I/O, no group imports — only the DOM `DOMParser` (present in the browser and
// under jsdom). Fail-closed: an empty/whitespace query or an environment without `DOMParser` returns the
// html UNCHANGED (highlight is cosmetic — never worse than no highlight, never throws in the render path).

// Tags whose text is NOT highlighted: an existing <mark> (never double-wrap) and non-content tags that
// should never carry a search hit. Everything else is descended into so a match inside <strong>/<a>/<li>
// still highlights. A closed set by Physics (these are structural, not user-extensible) — not an L083 enum.
const SKIP_TAGS = new Set(['mark', 'script', 'style', 'code', 'pre']);

/** Wrap every case-insensitive occurrence of `query` in `html`'s text with `<mark>`, preserving the
 *  original casing and all surrounding markup. Empty/whitespace query or no `DOMParser` → `html` verbatim. */
export function highlightHtml(html: string, query: string): string {
  const needle = query.trim().toLowerCase();
  if (!html || needle === '' || typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;
  if (!body) return html;
  markMatches(body, needle, doc);
  return body.innerHTML;
}

/** Depth-first: recurse into content elements, and for each text node splice its query matches out into
 *  `<mark>` elements. Skips SKIP_TAGS subtrees so an existing mark is never re-wrapped. */
function markMatches(node: Node, needle: string, doc: Document): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3 /* TEXT_NODE */) {
      markTextNode(child as Text, needle, doc);
    } else if (child.nodeType === 1 /* ELEMENT_NODE */) {
      const tag = (child as Element).tagName.toLowerCase();
      if (!SKIP_TAGS.has(tag)) markMatches(child, needle, doc);
    }
  }
}

/** Replace one text node with a run of [text, <mark>hit</mark>, text, …] for every match of `needle`
 *  (compared case-insensitively; the ORIGINAL-cased slice is what gets wrapped). No match → untouched. */
function markTextNode(textNode: Text, needle: string, doc: Document): void {
  const text = textNode.data;
  const hay = text.toLowerCase();
  let from = hay.indexOf(needle);
  if (from < 0) return; // no match — leave the node exactly as-is (zero churn)
  const frag = doc.createDocumentFragment();
  let cursor = 0;
  while (from >= 0) {
    if (from > cursor) frag.appendChild(doc.createTextNode(text.slice(cursor, from)));
    const mark = doc.createElement('mark');
    mark.textContent = text.slice(from, from + needle.length); // preserve original casing
    frag.appendChild(mark);
    cursor = from + needle.length;
    from = hay.indexOf(needle, cursor);
  }
  if (cursor < text.length) frag.appendChild(doc.createTextNode(text.slice(cursor)));
  textNode.parentNode?.replaceChild(frag, textNode);
}
