// packages/group/read-data/linkify-html.ts
//
// DISPLAY-ONLY linkifier for a note's read-only HTML — the exact twin of `highlight-html.ts`'s <mark> walk,
// but it wraps detected NAVIGABLE entities (a URL/email/phone with an href) in an <a>. It runs on the
// ALREADY-SANITISED display html (never the contentEditable edit path), walks TEXT NODES only, and skips
// SKIP_TAGS + any existing <a> subtree, so it can never re-link an existing anchor, touch an attribute, or
// inject anything but an anchor element. Non-navigable entities (#tag/@mention → href null) are left as plain
// text here (they need a board action, not a URL); the underlying `detectEntities` still surfaces them for
// extractor callers. Anchors get target=_blank + rel="noopener noreferrer" so an opened link can't reach back.

import { detectEntities, entityHref, type EntityPattern, TEXT_ENTITY_PATTERNS } from '../do-work/text-entities';

// Never linkify inside these subtrees: an existing <a> (no nested links), <mark> (search hit), or verbatim
// code/pre, or non-content script/style.
const SKIP_TAGS = new Set(['a', 'mark', 'script', 'style', 'code', 'pre']);

/** The note html with bare URLs/emails/phones turned into anchors. No entities, no DOMParser, or empty html
 *  → returned verbatim (zero churn — same fail-open contract as highlightHtml). */
export function linkifyHtml(html: string, patterns: readonly EntityPattern[] = TEXT_ENTITY_PATTERNS): string {
  if (!html || typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;
  if (!body) return html;
  linkifyNode(body, patterns, doc);
  return body.innerHTML;
}

/** Depth-first: recurse into content elements (skipping SKIP_TAGS subtrees), linkifying each text node. */
function linkifyNode(node: Node, patterns: readonly EntityPattern[], doc: Document): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3 /* TEXT_NODE */) {
      linkifyTextNode(child as Text, patterns, doc);
    } else if (child.nodeType === 1 /* ELEMENT_NODE */) {
      const tag = (child as Element).tagName.toLowerCase();
      if (!SKIP_TAGS.has(tag)) linkifyNode(child, patterns, doc);
    }
  }
}

/** Replace one text node with [text, <a>link</a>, text, …] for every navigable entity it contains. A text
 *  node with no navigable entity is left exactly as-is (zero churn). */
function linkifyTextNode(textNode: Text, patterns: readonly EntityPattern[], doc: Document): void {
  const text = textNode.data;
  const links = detectEntities(text, patterns)
    .map((e) => ({ e, href: entityHref(e, patterns) }))
    .filter((x): x is { e: (typeof x)['e']; href: string } => typeof x.href === 'string' && x.href.length > 0);
  if (links.length === 0) return; // nothing navigable — leave the node untouched
  const frag = doc.createDocumentFragment();
  let cursor = 0;
  for (const { e, href } of links) {
    if (e.start > cursor) frag.appendChild(doc.createTextNode(text.slice(cursor, e.start)));
    const a = doc.createElement('a');
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    a.setAttribute('data-linkified', 'true');
    a.textContent = e.value;
    frag.appendChild(a);
    cursor = e.end;
  }
  if (cursor < text.length) frag.appendChild(doc.createTextNode(text.slice(cursor)));
  textNode.parentNode?.replaceChild(frag, textNode);
}
