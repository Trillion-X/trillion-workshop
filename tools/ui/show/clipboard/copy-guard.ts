// parts/ui/show/clipboard/copy-guard.ts
//
// PURPOSE
//   One copy handler for the whole page. Native copy inlines the computed colours of the selected text, so words painted
//   in a dark look's own light ink arrive near-invisible in a light document. The guard notices that case and puts the
//   words on the clipboard as plain text plus structure-only HTML (paragraphs and line breaks, no colours or styles).
//   Every other copy is left to the browser untouched.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every number and word is copy-guard.json; nothing here names a look, a colour or a screen.
//   2. The decision (`ownInkShare`, `shouldGuard`) and the shape of the words (`structureBlocks`) are pure; only
//      `installCopyGuard` reads the page.
//   3. A copy from an editable field, an empty selection, or a page whose scheme is unknown or equals the paste target's
//      is never touched.
//   4. The written HTML is made from text nodes only (textContent), so no element or attribute of the page reaches the clipboard.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import settings from './copy-guard.json' with { type: 'json' };
import { colourOf } from 'trillion-workshop/tools/screen-look/read-data/look-scheme.ts';

export type Scheme = 'light' | 'dark';
export interface CopyGuardSettings {
  readonly paste_target_scheme: Scheme;
  readonly probe_most_text_nodes: number;
  readonly own_ink_share: number;
  readonly light_ink_above: number;
  readonly dark_ink_below: number;
}

/** Perceived luma of a CSS colour text, 0 (black) to 1 (white); null when it is not a plain colour. */
export function perceivedLuma(colour: string): number | null {
  const parsed = colourOf(colour);
  return parsed ? (0.299 * parsed[0] + 0.587 * parsed[1] + 0.114 * parsed[2]) / 255 : null;
}

/** The share of the inks that are the look's own (light ink on a dark look, dark ink on a light one); 0 when none can be read. */
export function ownInkShare(inks: readonly string[], scheme: Scheme, data: CopyGuardSettings = settings as CopyGuardSettings): number {
  const lumas = inks.map(perceivedLuma).filter((luma): luma is number => luma !== null);
  if (!lumas.length) return 0;
  const own = lumas.filter(luma => (scheme === 'dark' ? luma > data.light_ink_above : luma < data.dark_ink_below));
  return own.length / lumas.length;
}

/** Whether a copy needs the guard: the look is not the paste target's scheme and the text is painted in the look's own ink. */
export const shouldGuard = (inks: readonly string[], scheme: Scheme | null, data: CopyGuardSettings = settings as CopyGuardSettings): boolean =>
  scheme !== null && scheme !== data.paste_target_scheme && ownInkShare(inks, scheme, data) >= data.own_ink_share;

/** The words as blocks of lines: a blank line starts a new block, a newline a new line inside it. */
export const structureBlocks = (text: string): string[][] => text.split(/\n{2,}/).map(block => block.split('\n'));

/** The blocks as structure-only HTML text, made as elements holding text nodes so nothing in the words can become markup. */
export function structureOnlyHtml(text: string): string {
  const holder = document.createElement('div');
  for (const lines of structureBlocks(text)) {
    const paragraph = document.createElement('p');
    lines.forEach((line, at) => {
      if (at) paragraph.append(document.createElement('br'));
      paragraph.append(document.createTextNode(line));
    });
    holder.append(paragraph);
  }
  return holder.innerHTML;
}

const editable = (node: Node | null): boolean => {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return Boolean(element?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
};

/** The inks of at most `probe_most_text_nodes` text nodes the selection touches, as computed colour texts. */
function inksOf(selection: Selection, data: CopyGuardSettings): string[] {
  const inks: string[] = [];
  for (let at = 0; at < selection.rangeCount && inks.length < data.probe_most_text_nodes; at += 1) {
    const range = selection.getRangeAt(at);
    const root = range.commonAncestorContainer;
    const walker = document.createTreeWalker(root.nodeType === Node.TEXT_NODE ? root.parentNode ?? root : root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && inks.length < data.probe_most_text_nodes; node = walker.nextNode()) {
      if (!range.intersectsNode(node) || !node.textContent?.trim() || !node.parentElement) continue;
      inks.push(getComputedStyle(node.parentElement).color);
    }
  }
  return inks;
}

/** Installs the one capture-phase copy handler; returns what removes it. Safe to call again: the second call does nothing. */
export function installCopyGuard(data: CopyGuardSettings = settings as CopyGuardSettings): () => void {
  if (typeof document === 'undefined') return () => {};
  const marker = '__copyGuardInstalled';
  const host = document as unknown as Record<string, unknown>;
  if (host[marker]) return () => {};
  const onCopy = (event: ClipboardEvent) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !event.clipboardData || editable(selection.anchorNode)) return;
    const scheme = document.documentElement.getAttribute('data-look-scheme');
    if (scheme !== 'light' && scheme !== 'dark') return;
    const text = selection.toString();
    if (!text || !shouldGuard(inksOf(selection, data), scheme, data)) return;
    event.clipboardData.setData('text/plain', text);
    event.clipboardData.setData('text/html', structureOnlyHtml(text));
    event.preventDefault();
  };
  document.addEventListener('copy', onCopy, true);
  host[marker] = true;
  return () => { document.removeEventListener('copy', onCopy, true); host[marker] = false; };
}
