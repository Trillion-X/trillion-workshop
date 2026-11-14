// packages/documents/read-data/inline-chip-dom.ts
//
// The DOM side of the inline reference-chip model (C5) — the INVERSE PAIR that turns a block's stored
// text (which may carry `⟦ref:…⟧` tokens, the pure model in inline-tokens.ts) into live chip DOM and
// reads it back. Extracted out of the 6000-line surface so it is a pure, isolated, jsdom-testable unit:
// zero React, zero engine, zero @/packages/ui — only the DOM + the pure inline-tokens codec. A chip is
// `<span class="ca-ref-chip" contenteditable=false><span class="ca-ref-chip-ico">icon</span><span
// class="ca-ref-chip-label">label</span></span>` — atomic (the caret steps over it as one unit) and
// carries its ref identity (kind/value/label/icon) on data-* so serialize round-trips it losslessly.
//
// INLINE MARKS ARE DATA: every render/serialize call takes the caller's `InlineMark[]` table (the
// `kind:"inline-mark-set"` record) — this module never names a marker (`**`) or a tag (`strong`).
// A rendered mark element carries `data-mark-id` so the serializer inverts it by table row; a
// row's `legacy_tags` let elements this module didn't create (browser-native formatting, pre-table
// DOM) round-trip as that mark too (L090 / enum-dissolution).
//
// FAIL-SAFE: a block with NO token and NO mark is rendered/read via plain textContent (the unchanged
// fast path), so existing content and typing are 100% untouched.

import { parseEmphasisRuns, encodeRefToken, type InlineMark, type Ref, type Run } from './inline-tokens';

/** A DATA-supplied tag must be a plain element name before createElement/selector use —
 *  hostile table rows degrade to the literal-marker text path, never a DOM exception. */
const isSafeTag = (tag: string): boolean => /^[a-zA-Z][a-zA-Z0-9-]*$/.test(tag);

/** Build a reference chip element from a ref run (icon + label, atomic/non-editable). */
export function makeRefChip(ref: Ref): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'ca-ref-chip';
  chip.contentEditable = 'false';
  chip.dataset.refKind = ref.kind;
  chip.dataset.refValue = ref.value;
  chip.dataset.refLabel = ref.label;
  // Store the DATA glyph on the chip too, so serializeBlockElement round-trips it (otherwise a saved +
  // reloaded chip loses its icon — the token would re-encode with only kind/value/label).
  if (ref.icon) chip.dataset.refIcon = ref.icon;
  const ico = document.createElement('span');
  ico.className = 'ca-ref-chip-ico';
  ico.setAttribute('aria-hidden', 'true');
  // The glyph is DATA (the picker option's source carries it) — a task/person/date reference shows its
  // own icon. Never a per-kind switch (L090); '@' is only the neutral fallback when DATA omits one.
  ico.textContent = ref.icon || '@';
  const lbl = document.createElement('span');
  lbl.className = 'ca-ref-chip-label';
  lbl.textContent = ref.label;
  chip.append(ico, lbl);
  return chip;
}

/** The table row a DOM element serializes as: its own `data-mark-id` first (exact identity),
 *  else a tag-name match against `render_tag`/`legacy_tags` (foreign formatting DOM). */
function markForElement(el: HTMLElement, marks: readonly InlineMark[]): InlineMark | undefined {
  const id = el.dataset.markId;
  if (id) {
    const byId = marks.find((m) => m.id === id);
    if (byId) return byId;
  }
  const tag = el.tagName.toLowerCase();
  return marks.find(
    (m) => m.render_tag.toLowerCase() === tag || (m.legacy_tags ?? []).some((t) => t.toLowerCase() === tag),
  );
}

/** Render a block's text into `el`, materializing `⟦ref:…⟧` tokens as chips and the DATA table's
 *  marker pairs as their `render_tag` elements (stamped `data-mark-id`). The STORED text keeps the
 *  literal markers — mark DOM is a render projection the serializer inverts losslessly. A row whose
 *  render_tag can't be an element degrades to the literal marked text (still lossless). */
export function renderBlockRuns(el: HTMLElement, text: string, marks: readonly InlineMark[]): void {
  const runs: Run[] = parseEmphasisRuns(text, marks);
  el.textContent = '';
  for (const run of runs) {
    if (run.type !== 'text') { el.appendChild(makeRefChip(run)); continue; }
    if (!run.text) continue;
    const mark = run.marks?.length ? marks.find((m) => m.id === run.marks![0]) : undefined;
    if (mark && isSafeTag(mark.render_tag)) {
      const wrap = document.createElement(mark.render_tag);
      wrap.dataset.markId = mark.id;
      wrap.textContent = run.text;
      el.appendChild(wrap);
    } else if (mark) {
      el.appendChild(document.createTextNode(`${mark.open_marker}${run.text}${mark.close_marker}`));
    } else {
      el.appendChild(document.createTextNode(run.text));
    }
  }
}

/** Serialize a block element's DOM back to stored text: text nodes verbatim, chips → their token,
 *  mark elements (by `data-mark-id`, else by table tag match) → their row's literal markers,
 *  <br> → newline, anything else → its textContent. Inverse of renderBlockRuns. */
export function serializeBlockElement(el: HTMLElement, marks: readonly InlineMark[]): string {
  let out = '';
  el.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? '';
    else if (n instanceof HTMLElement && n.classList.contains('ca-ref-chip')) {
      out += encodeRefToken({ kind: n.dataset.refKind ?? '', value: n.dataset.refValue ?? '', label: n.dataset.refLabel ?? '', icon: n.dataset.refIcon || undefined });
    } else if (n instanceof HTMLElement && n.tagName === 'BR') out += '\n';
    else if (n instanceof HTMLElement) {
      const mark = markForElement(n, marks);
      out += mark ? `${mark.open_marker}${n.textContent ?? ''}${mark.close_marker}` : (n.textContent ?? '');
    } else out += (n as ChildNode).textContent ?? '';
  });
  return out;
}

/** The "does this element hold any structure?" selector, composed from the caller's table
 *  (chips + `data-mark-id` elements + every table render/legacy tag). Never names a tag. */
function structureSelector(marks: readonly InlineMark[]): string {
  const tags = new Set<string>();
  for (const m of marks) {
    if (isSafeTag(m.render_tag)) tags.add(m.render_tag.toLowerCase());
    for (const t of m.legacy_tags ?? []) if (isSafeTag(t)) tags.add(t.toLowerCase());
  }
  return ['.ca-ref-chip', '[data-mark-id]', ...tags].join(', ');
}

/** Read a block's current text — the structure-aware serializer only when a chip or mark
 *  element is present, else the plain textContent fast path (unchanged behavior for the
 *  overwhelming majority of blocks). */
export function readBlockText(el: HTMLElement, marks: readonly InlineMark[]): string {
  return el.querySelector(structureSelector(marks)) ? serializeBlockElement(el, marks) : (el.textContent ?? '');
}
