// packages/ui/show/rich-text-paint/apply-selection-paint.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The DOM mechanism that applies an INFINITE visual-layer paint to a run of text
// inside a contentEditable — the text-target sibling of painting a card region.
// A selected Range (one letter, a word, a whole line) is wrapped ONCE in a
// `<span data-visual-layer-stack="…JSON…" style="…composed CSS…">`; thereafter
// the SAME span is patched in place as the user edits the stack. The span carries
// BOTH representations (Codex convergence, correction C):
//   • data-visual-layer-stack = the structured stack (re-editable SOURCE OF TRUTH)
//   • inline style            = the composed CSS projection (renders read-only,
//                               survives innerHTML persistence + copy/paste)
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. NO naive `Range.surroundContents` (throws on partial node boundaries). We
//    extract + wrap + insert, which handles any selection incl. spans crossing
//    existing markup.
// 2. Re-painting an already-painted run targets the EXISTING span (no nesting).
// 3. The helpers are storage-blind and editor-agnostic — they take an editor root
//    element + a composed CSS object; they never know about the board, the note,
//    or how the HTML persists (L098). The host commits innerHTML when it wishes.
// =============================================================================

import type * as React from 'react';

/** The attribute that marks (and re-identifies) a paint span. */
export const PAINT_STACK_ATTR = 'data-visual-layer-stack';

/** camelCase React.CSSProperties → a DOM `cssText` string (kebab + vendor). */
export function cssPropsToText(css: React.CSSProperties): string {
  return Object.entries(css)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => {
      const prop = k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      return `${prop}: ${String(v)}`;
    })
    .join('; ');
}

/** The contentEditable root that owns the current selection, or null. */
function selectionRoot(root: HTMLElement): Range | null {
  if (typeof window === 'undefined') return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  // The selection must live inside this editor root.
  if (!root.contains(range.commonAncestorContainer)) return null;
  return range;
}

/** The paint span entirely containing the selection (for re-edit), or null. */
function existingPaintSpan(root: HTMLElement, range: Range): HTMLElement | null {
  let node: Node | null = range.commonAncestorContainer;
  while (node && node !== root) {
    if (node instanceof HTMLElement && node.hasAttribute(PAINT_STACK_ATTR)) return node;
    node = node.parentNode;
  }
  return null;
}

/**
 * Resolve the paint target for the current selection: the existing paint span if
 * the selection sits inside one, otherwise wrap the selected Range in a new span.
 * Returns null when there is no (non-collapsed) selection inside `root`.
 */
export function resolvePaintTarget(root: HTMLElement): HTMLElement | null {
  const range = selectionRoot(root);
  if (!range) return null;
  const existing = existingPaintSpan(root, range);
  if (existing) return existing;
  if (range.collapsed) return null; // nothing selected to paint
  const span = document.createElement('span');
  span.setAttribute(PAINT_STACK_ATTR, '');
  // extract + append handles partial-node boundaries that surroundContents rejects.
  span.appendChild(range.extractContents());
  range.insertNode(span);
  // Re-select the span's contents so the user keeps a visible selection.
  const sel = window.getSelection();
  if (sel) {
    const next = document.createRange();
    next.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(next);
  }
  return span;
}

/**
 * Resolve a paint target, falling back to the WHOLE editor when the selection is
 * collapsed or absent. The requirement: opening the paint control must give
 * controls immediately — never a "select some text first" stub. If the user has a
 * real selection (one letter, a word) that wins; otherwise the entire run is
 * selected and wrapped, so painting fills the whole note by default.
 */
export function ensurePaintTarget(root: HTMLElement): HTMLElement | null {
  const direct = resolvePaintTarget(root);
  if (direct) return direct;
  if (typeof window === 'undefined' || !root.textContent) return null;
  // No usable selection — select all editor contents, then wrap.
  const sel = window.getSelection();
  if (!sel) return null;
  const all = document.createRange();
  all.selectNodeContents(root);
  sel.removeAllRanges();
  sel.addRange(all);
  return resolvePaintTarget(root);
}

/** Write the composed CSS + structured stack JSON onto a paint span. */
export function setSpanPaint(span: HTMLElement, css: React.CSSProperties, stackJson: string): void {
  span.style.cssText = cssPropsToText(css);
  span.setAttribute(PAINT_STACK_ATTR, stackJson);
}

/** Read the structured stack JSON previously written to a span (or null). */
export function readSpanStack(span: HTMLElement): unknown {
  const raw = span.getAttribute(PAINT_STACK_ATTR);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Tidy paint spans after editing: unwrap empties, merge adjacent siblings that
 * carry an identical stack, then `normalize()` text nodes. Idempotent; safe to
 * call on every commit. Keeps the persisted HTML minimal and re-editable.
 */
export function normalizePaintSpans(root: HTMLElement): void {
  const spans = Array.from(root.querySelectorAll(`span[${PAINT_STACK_ATTR}]`)) as HTMLElement[];
  for (const span of spans) {
    // Unwrap an empty paint span (selection was cleared/deleted).
    if (!span.textContent) {
      span.remove();
      continue;
    }
    // Merge with an immediately-following identical-stack sibling.
    let next = span.nextSibling;
    while (
      next instanceof HTMLElement &&
      next.hasAttribute(PAINT_STACK_ATTR) &&
      next.getAttribute(PAINT_STACK_ATTR) === span.getAttribute(PAINT_STACK_ATTR) &&
      next.style.cssText === span.style.cssText
    ) {
      while (next.firstChild) span.appendChild(next.firstChild);
      const after = next.nextSibling;
      next.remove();
      next = after;
    }
  }
  root.normalize();
}
