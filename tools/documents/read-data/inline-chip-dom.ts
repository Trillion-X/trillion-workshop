// parts/documents/read-data/inline-chip-dom.ts
//
// PURPOSE
//   The DOM side of the inline model (inline-tokens.ts), ported from the documents package
//   (bitfield-packages/packages/documents/read-data/inline-chip-dom.ts) with no runtime ties: a block's stored text
//   becomes live chips (mentions) and mark elements (bold, italic, ...) inside an editable element, and the element
//   reads back to the same text. Zero React.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A chip is one atomic, non-editable element carrying its mention on data-* attributes, so reading it back
//      re-encodes exactly the token it was drawn from, glyph included.
//   2. A chip's colour is the caller's DATA (`colourOf(kind)`), stamped as `data-colour`, the one colour attribute
//      screen-look draws every coloured thing with. Nothing here names a kind or a colour.
//   3. Marks are the caller's table rows: a drawn mark element carries `data-mark-id`; a row's `legacy_tags` let the
//      browser's own formatting elements read back as that mark. No marker or tag is named here.
//   4. renderBlockRuns and serializeBlockElement are inverses; a block with no token and no mark keeps the plain
//      textContent path.
//   5. Only createElement / createTextNode / textContent build anything: no markup strings.

import { parseEmphasisRuns, encodeInlineLinkOpen, encodeRefToken, safeInlineLinkUrl, sanitizeInlineStyle, type InlineMark, type Ref, type Run } from 'trillion-workshop/tools/edit-a-document-together/read-data/inline-tokens.ts';
import { applySceneStyleToElement } from '../../ui/show/composition-scene-style/index.ts';

export const CHIP_CLASS = 'document-chip';
/** How a caller colours a mention by its kind (a screen-look colour id), or leaves it plain. */
export type ColourOf = (kind: string) => string | undefined;
const noColour: ColourOf = () => undefined;

/** A DATA-supplied tag must be a plain element name before createElement / selector use; a hostile row degrades to
 *  the literal-marker text path, never a DOM exception. */
const isSafeTag = (tag: string): boolean => /^[a-zA-Z][a-zA-Z0-9-]*$/.test(tag);

/** The chip for one mention: its glyph (the DATA's own, else `@`) and its name, stepped over as one unit. */
export function makeRefChip(ref: Ref, colour?: string, doc: Document = document): HTMLElement {
  const chip = doc.createElement('span');
  chip.className = CHIP_CLASS;
  chip.contentEditable = 'false';
  chip.dataset.refKind = ref.kind;
  chip.dataset.refValue = ref.value;
  chip.dataset.refLabel = ref.label;
  if (ref.icon) chip.dataset.refIcon = ref.icon;
  if (ref.destination) chip.dataset.refDestination = ref.destination;
  if (colour) chip.dataset.colour = colour;
  const glyph = doc.createElement('span');
  glyph.className = 'document-chip-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = ref.icon || '@';
  const label = doc.createElement('span');
  label.className = 'document-chip-label';
  label.textContent = ref.label;
  chip.append(glyph, label);
  return chip;
}

/** The table row a DOM element reads back as: its own `data-mark-id` first, else a tag match. */
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

/** Draw a block's text into `el`: tokens as chips, the table's marker pairs as their `render_tag` elements. */
export function renderBlockRuns(el: HTMLElement, text: string, marks: readonly InlineMark[], colourOf: ColourOf = noColour): void {
  const doc = el.ownerDocument;
  el.replaceChildren();
  const containers: HTMLElement[] = [el];
  let active: string[] = [];
  for (const run of parseEmphasisRuns(text, marks.filter(mark => isSafeTag(mark.render_tag)))) {
    const wanted = [...(run.marks ?? [])];
    let common = 0;
    while (common < active.length && common < wanted.length && active[common] === wanted[common]) common++;
    containers.length = common + 1;
    active = active.slice(0, common);
    for (let index = common; index < wanted.length; index++) {
      const mark = marks.find(row => row.id === wanted[index]);
      if (!mark) continue;
      const wrapper = doc.createElement(isSafeTag(mark.render_tag) ? mark.render_tag : 'span');
      wrapper.dataset.markId = mark.id;
      applySceneStyleToElement(wrapper, sanitizeInlineStyle(mark.style));
      containers[containers.length - 1].appendChild(wrapper);
      containers.push(wrapper);
      active.push(mark.id);
    }
    let target = containers[containers.length - 1];
    const href = safeInlineLinkUrl(run.link);
    if (href) {
      const link = doc.createElement('a');
      link.dataset.inlineLink = href;
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      target.appendChild(link);
      target = link;
    }
    const style = sanitizeInlineStyle(run.style);
    if (Object.keys(style).length) {
      const wrapper = doc.createElement('span');
      wrapper.dataset.inlineStyle = encodeURIComponent(JSON.stringify(style));
      applySceneStyleToElement(wrapper, style);
      target.appendChild(wrapper);
      target = wrapper;
    }
    if (run.type === 'ref') target.appendChild(makeRefChip(run, colourOf(run.kind), doc));
    else if (run.text) target.appendChild(doc.createTextNode(run.text));
  }
  // Appending nodes directly keeps nested marks around references as one structure,
  // so their literal marker boundaries serialize in their original order.
  if (!el.childNodes.length) el.replaceChildren(doc.createTextNode(''));
}

/** One element's drawn shape: its text runs merged, each chip as its token, each mark as its row and words, each line
 *  break as a newline. Two elements with the same shape show the same thing. */
function drawnShape(el: HTMLElement, marks: readonly InlineMark[]): string[] {
  const shape: string[] = [];
  const push = (part: string, plain: boolean) => {
    if (plain && shape.length && shape[shape.length - 1].startsWith('t:')) shape[shape.length - 1] += part;
    else shape.push(plain ? `t:${part}` : part);
  };
  const visit = (parent: HTMLElement) => parent.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) { if (n.textContent) push(n.textContent, true); }
    else if (n instanceof HTMLElement && n.classList.contains(CHIP_CLASS)) {
      push(`c:${encodeRefToken({ kind: n.dataset.refKind ?? '', value: n.dataset.refValue ?? '', label: n.dataset.refLabel ?? '', icon: n.dataset.refIcon || undefined, destination: n.dataset.refDestination || undefined })}`, false);
    } else if (n instanceof HTMLElement && n.tagName === 'BR') push('\n', true);
    else if (n instanceof HTMLElement) {
      if (n.dataset.inlineLink) {
        const open = encodeInlineLinkOpen(n.dataset.inlineLink);
        if (open) { push(`l:${open}:open`, false); visit(n); push('l:close', false); return; }
      }
      if (n.dataset.inlineStyle) { push(`s:${n.dataset.inlineStyle}:open`, false); visit(n); push(`s:${n.dataset.inlineStyle}:close`, false); return; }
      const mark = markForElement(n, marks);
      if (mark) { push(`m:${mark.id}:open`, false); visit(n); push(`m:${mark.id}:close`, false); }
      else visit(n);
    }
  });
  visit(el);
  return shape;
}

/** Whether `el` already shows `text` drawn: the words typed with their markers still showing (`**balls**` as typed)
 *  read back to the same text but are not drawn, so a block redraws them once the caret has left. */
export function isDrawnAs(el: HTMLElement, text: string, marks: readonly InlineMark[]): boolean {
  const probe = el.ownerDocument.createElement('div');
  renderBlockRuns(probe, text, marks);
  const want = drawnShape(probe, marks);
  const have = drawnShape(el, marks);
  return want.length === have.length && want.every((part, index) => part === have[index]);
}

/** Read a block element back to stored text: text verbatim, chips as tokens, mark elements with their row's markers,
 *  <br> as a newline, anything else as its text. Inverse of renderBlockRuns. */
export function serializeBlockElement(el: HTMLElement, marks: readonly InlineMark[], includeLinkTokens = true): string {
  const read = (parent: HTMLElement): string => Array.from(parent.childNodes).map((n): string => {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? '';
    if (n instanceof HTMLElement && n.classList.contains(CHIP_CLASS)) {
      return encodeRefToken({ kind: n.dataset.refKind ?? '', value: n.dataset.refValue ?? '', label: n.dataset.refLabel ?? '', icon: n.dataset.refIcon || undefined, destination: n.dataset.refDestination || undefined });
    }
    if (n instanceof HTMLElement && n.tagName === 'BR') return '\n';
    if (n instanceof HTMLElement) {
      if (n.dataset.inlineLink) {
        const open = encodeInlineLinkOpen(n.dataset.inlineLink);
        if (open) return includeLinkTokens ? `${open}${read(n)}⟦/link⟧` : read(n);
      }
      if (n.dataset.inlineStyle) return `⟦style:${n.dataset.inlineStyle}⟧${read(n)}⟦/style⟧`;
      const mark = markForElement(n, marks);
      const content = read(n);
      return mark ? `${mark.open_marker}${content}${mark.close_marker}` : content;
    }
    return n.textContent ?? '';
  }).join('');
  return read(el);
}

/** The "does this element hold any structure?" selector, composed from the caller's table. Never names a tag. */
function structureSelector(marks: readonly InlineMark[]): string {
  const tags = new Set<string>();
  for (const m of marks) {
    if (isSafeTag(m.render_tag)) tags.add(m.render_tag.toLowerCase());
    for (const t of m.legacy_tags ?? []) if (isSafeTag(t)) tags.add(t.toLowerCase());
  }
  return [`.${CHIP_CLASS}`, '[data-mark-id]', '[data-inline-style]', '[data-inline-link]', 'br', ...tags].join(', ');
}

/** A block's current text: the structure-aware reader when a chip, mark or line break is present, else textContent. */
export function readBlockText(el: HTMLElement, marks: readonly InlineMark[]): string {
  return el.querySelector(structureSelector(marks)) ? serializeBlockElement(el, marks) : (el.textContent ?? '');
}

/** The caret's offset in the FLATTENED text of `el` (what readBlockText produces, chips as tokens), or -1 when the
 *  caret is not inside `el`. The start-to-caret range is cloned into a holder and read the same way. */
export function caretFlatOffset(el: HTMLElement, marks: readonly InlineMark[]): number {
  const doc = el.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0) return -1;
  const caret = selection.getRangeAt(0);
  if (!el.contains(caret.endContainer)) return -1;
  const before = doc.createRange();
  before.selectNodeContents(el);
  before.setEnd(caret.endContainer, caret.endOffset);
  const holder = doc.createElement('div');
  holder.appendChild(before.cloneContents());
  return serializeBlockElement(holder, marks, false).length;
}

/** Put the caret at flat offset `offset` of `el` (the inverse of caretFlatOffset): walks the drawn nodes, a chip
 *  counting as its whole token, a mark element as its markers plus words. Out of range lands at the end. */
export function placeCaretAtFlatOffset(el: HTMLElement, offset: number, marks: readonly InlineMark[]): void {
  const doc = el.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (!selection) return;
  const range = doc.createRange();
  let left = Math.max(0, offset);
  let placed = false;
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      if (left <= length) { range.setStart(node, left); placed = true; break; }
      left -= length;
      continue;
    }
    const holder = doc.createElement('div');
    holder.appendChild(node.cloneNode(true));
    const length = serializeBlockElement(holder, marks, false).length;
    if (left < length) {
      if (node instanceof HTMLElement && node.dataset.inlineLink) {
        placeCaretAtFlatOffset(node, left, marks);
        return;
      }
      range.setStartAfter(node); placed = true; break;
    }
    left -= length;
    if (left === 0) { range.setStartAfter(node); placed = true; break; }
  }
  if (!placed) { range.selectNodeContents(el); range.collapse(false); } else range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function visibleLength(root: HTMLElement): number {
  let length = 0;
  const visit = (parent: Node) => parent.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) length += node.textContent?.length ?? 0;
    else if (node instanceof HTMLElement && node.classList.contains(CHIP_CLASS)) length += 1;
    else if (node instanceof HTMLElement && node.tagName === 'BR') length += 1;
    else visit(node);
  });
  visit(root);
  return length;
}

/** Return the selected visible UTF-16 range; every reference chip is one atomic unit. */
export function readBlockSelection(el: HTMLElement, _marks: readonly InlineMark[]): { start: number; end: number } | null {
  const selection = el.ownerDocument.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const current = selection.getRangeAt(0);
  if (!el.contains(current.startContainer) || !el.contains(current.endContainer)) return null;
  const offsetFor = (container: Node, offset: number): number => {
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    range.setEnd(container, offset);
    const holder = el.ownerDocument.createElement('div');
    holder.appendChild(range.cloneContents());
    return visibleLength(holder);
  };
  return { start: offsetFor(current.startContainer, current.startOffset), end: offsetFor(current.endContainer, current.endOffset) };
}

/** Restore a visible UTF-16 range into the editable DOM, treating each reference chip atomically. */
export function restoreBlockSelection(el: HTMLElement, start: number, end: number, _marks: readonly InlineMark[]): void {
  const selection = el.ownerDocument.defaultView?.getSelection();
  if (!selection) return;
  const total = visibleLength(el);
  const locate = (requested: number): { node: Node; offset: number } => {
    let remaining = Math.max(0, Math.min(total, requested));
    let fallback: { node: Node; offset: number } = { node: el, offset: el.childNodes.length };
    const visit = (parent: Node): { node: Node; offset: number } | null => {
      for (let index = 0; index < parent.childNodes.length; index++) {
        const node = parent.childNodes[index];
        if (node.nodeType === Node.TEXT_NODE) {
          const size = node.textContent?.length ?? 0;
          if (remaining <= size) return { node, offset: remaining };
          remaining -= size;
          fallback = { node: parent, offset: index + 1 };
        } else if (node instanceof HTMLElement && node.classList.contains(CHIP_CLASS)) {
          if (remaining <= 1) return { node: parent, offset: index + (remaining === 0 ? 0 : 1) };
          remaining -= 1;
          fallback = { node: parent, offset: index + 1 };
        } else if (node instanceof HTMLElement && node.tagName === 'BR') {
          if (remaining <= 1) return { node: parent, offset: index + (remaining === 0 ? 0 : 1) };
          remaining -= 1;
          fallback = { node: parent, offset: index + 1 };
        } else {
          const found = visit(node);
          if (found) return found;
          fallback = { node: parent, offset: index + 1 };
        }
      }
      return null;
    };
    return visit(el) ?? fallback;
  };
  const a = locate(start), b = locate(end);
  const range = el.ownerDocument.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}
