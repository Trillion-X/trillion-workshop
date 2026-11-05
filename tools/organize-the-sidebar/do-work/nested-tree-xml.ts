// packages/group/do-work/nested-tree-xml.ts
//
// NESTED-TREE XML → depth-tagged outline (b173). The generative primitive behind EVERY "nested XML element tree
// → mind-map" importer. OPML (`<outline text="…">`), FreeMind/Freeplane (`<node TEXT="…">`), and any future
// nested-element mind-map format are the SAME parse: walk the elements, a depth counter opens a level per
// non-self-closing element and closes on `</tag>`, each element contributing one line at its depth. The ONLY
// things that differ are the element NAME and which ATTRIBUTE holds the label — so those are DATA
// (`NestedTreeSpec`), never a second hand-written tokenizer (L069/L090/enum-dissolution). Adding a nested-XML
// format is one spec row + a sniff, ZERO parser code.
//
// DOM-free (a pure leaf runs in the wasm slot too): a tolerant regex tokenizer over the configured tag, robust
// to attribute order + self-closing tags, un-escaping the five XML entities the exporters write. Deterministic
// (document order); malformed nesting tolerated (depth never goes below 0), never thrown.

import type { OutlineLine } from './batch-actions.ts';

/** How to read ONE nested-XML mind-map dialect: the nesting element name + the attribute(s) that hold a node's
 *  label (first present wins). OPML = `{tag:'outline', textAttrs:['text','title']}`; FreeMind =
 *  `{tag:'node', textAttrs:['TEXT']}`. */
export interface NestedTreeSpec {
  readonly tag: string;
  readonly textAttrs: readonly string[];
}

/** XML-escape a text value — the five predefined entities (`&` first so it never doubles the others). */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Reverse of the exporters' XML escaping — `&amp;` LAST so an escaped `&amp;lt;` is not double-decoded. */
export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Read an attribute value off an element's open-tag attribute string (`text="…"`), un-escaped, or undefined. */
export function xmlAttr(tagAttrs: string, name: string): string | undefined {
  const m = tagAttrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : undefined;
}

/**
 * Parse a nested-XML element tree into depth-tagged outline lines. A depth counter tracks nesting: an element
 * with children (`<tag …>`) opens a level, a self-closing element (`<tag …/>`) is a leaf, `</tag>` closes. A
 * line's text is the first present `spec.textAttrs` attribute (else ''). Only the configured tag is matched —
 * a document's `<map>`/`<opml>`/`<head>` wrapper is ignored. Tolerant + deterministic; never throws.
 */
export function parseNestedTree(text: string, spec: NestedTreeSpec): OutlineLine[] {
  const lines: OutlineLine[] = [];
  if (typeof text !== 'string') return lines;
  // group1 = leading slash (a close tag), group2 = attrs, group3 = trailing slash (self-close)
  const tagRe = new RegExp(`<(\\/)?${spec.tag}\\b([^>]*?)(\\/)?>`, 'g');
  let depth = 0;
  for (let m = tagRe.exec(text); m !== null; m = tagRe.exec(text)) {
    if (m[1] === '/') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const attrs = m[2] ?? '';
    let label = '';
    for (const a of spec.textAttrs) {
      const v = xmlAttr(attrs, a);
      if (v !== undefined) { label = v; break; }
    }
    lines.push({ depth, text: label });
    if (m[3] !== '/') depth += 1; // an open (non-self-closing) element nests its children one level deeper
  }
  return lines;
}

/**
 * Serialize depth-tagged outline lines back into a nested-XML element tree (the inverse of `parseNestedTree`,
 * the same dialect via the SAME `spec`). Each line becomes `<tag textAttr="…">`, closed when the walk ascends;
 * a stack tracks the open depths (a pre-order walk: depth rises by 1 going down, drops by any amount coming up).
 * The label is written to the spec's PRIMARY text attribute. `indentBase` sets the leading indent. Deterministic;
 * XML-escaped so a node's text can never break the document. This is the ONE nested-XML writer — OPML and
 * FreeMind exports are both configurations of it (L069/L100).
 */
export function outlineToNestedXml(
  lines: readonly OutlineLine[],
  spec: NestedTreeSpec,
  indentBase = 0,
): string {
  const attr = spec.textAttrs[0];
  const parts: string[] = [];
  const open: number[] = []; // depths of the currently-open elements
  const pad = (n: number) => '  '.repeat(indentBase + n);
  for (const line of lines) {
    while (open.length > line.depth) {
      open.pop();
      parts.push(`${pad(open.length)}</${spec.tag}>`);
    }
    parts.push(`${pad(open.length)}<${spec.tag} ${attr}="${escapeXml(line.text)}">`);
    open.push(line.depth);
  }
  while (open.length > 0) {
    open.pop();
    parts.push(`${pad(open.length)}</${spec.tag}>`);
  }
  return parts.join('\n');
}
