// packages/group/do-work/sanitize-capsule-html.ts
//
// A share LINK is UNTRUSTED input — anyone can hand-craft the capsule that rides in the URL
// fragment. The opener renders a note's `html` through RichTextEditor, which does
// `root.innerHTML = html` (an injection sink). Without this sanitizer, a link carrying
// `<img src=x onerror=…>` / `<svg onload=…>` runs arbitrary script in the victim's origin the
// instant the link is opened or pasted — XSS via a share link.
//
// This is the ONE trust boundary for a capsule's rich text (SP1 compiled-style verification at
// the boundary, SP5 fail-closed, L098 the boundary owns validation). It parses the html in an
// INERT document (a DOMParser document never executes scripts and never loads resources — per
// spec "scripting is disabled, resources are not loaded"), keeps only an ALLOW-LIST of inline
// formatting tags/attributes, drops every event handler and unsafe URL, sanitizes inline
// styles, and re-serializes. Safe formatting (bold / italic / colour spans / lists / links)
// survives so a shared board still LOOKS like the original; script cannot survive.
//
// Pure leaf (L069/L088): no I/O, no group imports — only the DOM `DOMParser` (present in the
// browser and under jsdom). Kept dependency-free so it can be promoted verbatim to a shared
// `packages/ui` sanitizer when the chat / link-preview / markdown renderers (the SAME
// `innerHTML` sink) become the 2nd/3rd consumers — a move, not a rewrite. Flagged for that
// ui-lane elevation; until then the untrusted-html surface in THIS lane (share) is closed.

// Inline formatting + lists + links + headings. Deliberately NO media/foreign-content tags
// (img/video/svg/math/iframe/object/embed) and NO script/style/template/form controls — any
// such tag is UNWRAPPED (replaced by its inert contents), so a hostile `<img onerror>` /
// `<script>` / `<svg onload>` cannot survive. A narrow allow-list is what makes a hand-written
// sanitizer correct-by-construction: no foreign-content tag means no mXSS re-parse vector.
const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'mark', 'sub', 'sup',
  'span', 'br', 'p', 'div', 'ul', 'ol', 'li', 'a', 'blockquote', 'code', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

// Attributes allowed on EVERY allowed tag. `style` is allowed but its value is sanitized
// (see safeStyle) — colour/weight/alignment fidelity without a CSS fetch/execute vector.
const GLOBAL_ATTRS = new Set(['style']);
// Per-tag extra attributes. Only `a` gets href/title; nothing gets `src`/`srcset` because no
// resource-loading tag is in the allow-list.
const TAG_ATTRS: Readonly<Record<string, ReadonlySet<string>>> = { a: new Set(['href', 'title']) };

// A URL is safe iff it is relative (`/`, `#`, `.`, or a bare path) or uses an inert scheme.
// This BLOCKS `javascript:`, `data:`, `vbscript:`, and any other active scheme.
const SAFE_URL = /^(?:https?:|mailto:|tel:|#|\/|\.|[^:]*$)/i;

// Inline TEXT-FORMATTING properties only. NONE of these accept a `<image>`/`<url>` value, so a
// kept declaration structurally CANNOT fetch or execute — the L063 category fix. A block-list of
// dangerous FUNCTIONS is whack-a-mole: `url()` is only one fetch function (`image()`, `image-set()`,
// `cross-fade()`, `element()`, `-webkit-*` variants all fetch too), and a CSS ESCAPE bypasses a
// literal string match (`u\72l(...)` unescapes to `url(...)` in the CSS parser). Excluding the
// image-accepting properties (background, background-image, border-image, list-style-image, content,
// cursor, mask, …) from the allow-list closes every one of those at once.
const SAFE_STYLE_PROPS = new Set([
  'color', 'background-color',
  'font', 'font-weight', 'font-style', 'font-size', 'font-family', 'font-variant',
  'text-align', 'text-decoration', 'text-decoration-line', 'text-decoration-color', 'text-decoration-style',
  'text-transform', 'line-height', 'letter-spacing', 'word-spacing', 'vertical-align', 'white-space',
]);

/** Keep only inert text-formatting declarations. A declaration survives iff its PROPERTY is in the
 *  allow-list (so it cannot reference a resource) AND its value carries no CSS escape or fetch/exec
 *  function — defense in depth. Returns the cleaned `a; b; c` string. */
function safeStyle(value: string): string {
  return value
    .split(';')
    .map((d) => d.trim())
    .filter((d) => {
      const i = d.indexOf(':');
      if (i <= 0) return false;
      const prop = d.slice(0, i).trim().toLowerCase();
      if (!SAFE_STYLE_PROPS.has(prop)) return false; // property allow-list: a kept prop can't fetch
      const val = d.slice(i + 1).trim();
      if (val.includes('\\')) return false; // no CSS escapes (they unescape past a substring block-list)
      // Only the safe colour/length functions may appear; any other `(` (url/image/expression/…) is out.
      if (/\(/.test(val) && !/^(?:rgb|rgba|hsl|hsla|calc)\s*\(/i.test(val)) return false;
      return true;
    })
    .join('; ');
}

/** Clean one element in place: recurse into children first, then either UNWRAP the element
 *  (if its tag is not allow-listed) or strip its disallowed attributes. */
function cleanElement(el: Element): void {
  // Depth-first so a kept parent's descendants are already clean, and an unwrapped parent
  // promotes already-clean children.
  for (const child of Array.from(el.children)) cleanElement(child);

  const tag = el.tagName.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) {
    // Unwrap: splice the element's (already-inert) children in its place, then remove it. A
    // <script>/<img onerror>/<iframe>/<svg> becomes its usually-empty contents — never runs.
    const parent = el.parentNode;
    if (parent) {
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    } else {
      el.remove();
    }
    return;
  }

  const perTag = TAG_ATTRS[tag];
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const permitted = GLOBAL_ATTRS.has(name) || (perTag?.has(name) ?? false);
    // Strip every event handler and every non-permitted attribute.
    if (name.startsWith('on') || !permitted) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === 'style') {
      const cleaned = safeStyle(attr.value);
      if (cleaned) el.setAttribute('style', cleaned);
      else el.removeAttribute('style');
      continue;
    }
    if (name === 'href' || name === 'src') {
      if (!SAFE_URL.test(attr.value.trim())) el.removeAttribute(attr.name);
    }
  }
}

/**
 * Sanitize untrusted rich-text HTML (from a share capsule) down to a safe formatting subset,
 * ready to hand to the read-only renderer's `innerHTML` sink. Fail-closed: an environment with
 * no DOMParser strips ALL markup (text only); malformed html parses to whatever the inert
 * parser recovers, then goes through the same allow-list.
 */
export function sanitizeCapsuleHtml(html: string): string {
  if (!html) return '';
  if (typeof DOMParser === 'undefined') return html.replace(/<[^>]*>/g, '');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;
  if (!body) return '';
  for (const child of Array.from(body.children)) cleanElement(child);
  return body.innerHTML;
}
