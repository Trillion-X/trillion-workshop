// packages/group/do-work/board-text-replace.ts
//
// The graph bridge over the pure `text-replace` matcher: find-and-replace across the board's notes,
// folded back as patches and committed as ONE undo step by the caller. TWO subtleties make this the
// bridge, not the pure leaf:
//
//  1. A note's rendered body is `item.html` when present (the read-only render PREFERS html; `text`
//     is only its plain projection — group-board-model). Replacing `text` alone would leave a rich
//     note visually UNCHANGED. So for html notes we replace inside the html's TEXT NODES only (an
//     inert DOMParser walk — tags/attributes untouched, so no structure break and no injection: the
//     replacement is set as a text node value, never parsed as markup) and refresh `text` to the new
//     textContent. Plain notes replace `text` directly.
//  2. Connectors (no user text) and auto-generated FURNITURE (region headings / axis-tick labels)
//     are excluded — "replace v1 with v2" must never rewrite a lane header or a tick value.
//
// The match semantics (literal/regex/whole-word/case) come from the ONE `buildMatcher` SSOT, so a
// plain-text note and a rich note match identically. DOMParser is present in the browser and jsdom.

import type { GroupGraph, AddressRef } from '../../ui/show/group/group-graph';
import { readItems, patchItems, itemIsConnector } from '../read-data/group-board-model.ts';
import { itemIsBoardFurniture } from './batch-actions.ts';
import { buildMatcher, replaceString, replacementFor, type TextReplaceOptions } from '../read-data/text-replace.ts';

export interface BoardReplaceResult {
  readonly graph: GroupGraph;
  readonly matchCount: number; // total occurrences replaced
  readonly itemCount: number; // notes changed
  readonly touchedMemberIds: string[];
}

/** The board items find-and-replace acts on: everything with user text — never connectors or the
 *  board's own generated furniture (headings / axis ticks). One SSOT for "what counts as content". */
function contentItems(graph: GroupGraph, parentRef: AddressRef) {
  return readItems(graph, parentRef).filter((i) => !itemIsConnector(i) && !itemIsBoardFurniture(i));
}

/**
 * Replace matches inside an HTML body, touching ONLY text nodes (an inert DOMParser document never
 * executes scripts or loads resources). Tags + attributes are left exactly as-is, so formatting
 * survives and no markup is injected (the replacement is a text-node value, escaped on serialize).
 * Returns the new html, its refreshed plain-text projection, and the match count. Pure.
 */
export function replaceInHtml(html: string, opts: TextReplaceOptions): { html: string; text: string; count: number } {
  const re = buildMatcher(opts);
  if (!re) return { html, text: '', count: 0 };
  const replaceWith = replacementFor(opts);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let count = 0;
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3 /* TEXT_NODE */) {
        const { value, count: c } = replaceString(child.nodeValue ?? '', re, replaceWith);
        if (c > 0) {
          child.nodeValue = value;
          count += c;
        }
      } else {
        walk(child);
      }
    }
  };
  walk(doc.body);
  return { html: doc.body.innerHTML, text: doc.body.textContent ?? '', count };
}

/**
 * Apply find-and-replace across the board's content notes, returning the new graph + counts. A rich
 * note replaces inside its html (text nodes only) and refreshes its `text`; a plain note replaces
 * `text`. No match anywhere → the SAME graph reference (a trivially detectable no-op). `scopeIds` in
 * `opts` limits to a selection. Each changed note is one `patchItem`; the caller commits the batch
 * as a single undo step and can report "replaced N in M notes".
 */
export function applyTextReplace(graph: GroupGraph, parentRef: AddressRef, opts: TextReplaceOptions): BoardReplaceResult {
  const re = buildMatcher(opts);
  if (!re) return { graph, matchCount: 0, itemCount: 0, touchedMemberIds: [] };
  const scope = Array.isArray(opts.scopeIds) ? new Set(opts.scopeIds) : null;
  const replaceWith = replacementFor(opts);

  let matchCount = 0;
  const touched: string[] = [];
  // Collect one patch per matched item, then apply them in ONE batch (O(M+K)) instead of folding patchItem
  // per match (O(K*M) = O(N^2) on a large replace-all). The loop reads the ORIGINAL graph, so accumulating
  // the patches and applying once is identical to the fold.
  const patches: Array<{ memberId: string; patch: Record<string, unknown> }> = [];
  for (const it of contentItems(graph, parentRef)) {
    if (scope && !scope.has(it.memberId)) continue;
    if (typeof it.html === 'string' && it.html !== '') {
      const { html, text, count } = replaceInHtml(it.html, opts);
      if (count > 0) {
        patches.push({ memberId: it.memberId, patch: { html, text } });
        matchCount += count;
        touched.push(it.memberId);
      }
    } else if (typeof it.text === 'string' && it.text !== '') {
      const { value, count } = replaceString(it.text, re, replaceWith);
      if (count > 0 && value !== it.text) {
        patches.push({ memberId: it.memberId, patch: { text: value } });
        matchCount += count;
        touched.push(it.memberId);
      }
    }
  }
  const g = patchItems(graph, parentRef, patches);
  return { graph: g, matchCount, itemCount: touched.length, touchedMemberIds: touched };
}

/** Count matches across the board (the "N matches" readout) WITHOUT changing anything — same content
 *  scope + matcher as {@link applyTextReplace} (rich notes counted in their plain text), so the
 *  preview equals the effect. */
export function countBoardMatches(
  graph: GroupGraph,
  parentRef: AddressRef,
  opts: Pick<TextReplaceOptions, 'find' | 'caseSensitive' | 'wholeWord' | 'regex' | 'scopeIds'>,
): number {
  const re = buildMatcher({ ...opts, replaceWith: '' });
  if (!re) return 0;
  const scope = Array.isArray(opts.scopeIds) ? new Set(opts.scopeIds) : null;
  let total = 0;
  for (const it of contentItems(graph, parentRef)) {
    if (scope && !scope.has(it.memberId)) continue;
    if (typeof it.html === 'string' && it.html !== '') {
      // A rich note must be counted PER TEXT NODE — the exact granularity replaceInHtml replaces at.
      // Counting the FLATTENED plain text over-counts a match that spans a tag boundary (e.g. "cat"
      // across `<b>ca</b>t`), which cannot be replaced without reflowing formatting, and mis-scores a
      // word-boundary match at a node edge — so the "N matches" preview promised more (or fewer) than
      // the replace delivers. Reuse the replace path (replaceWith:'' is a pure count) so the preview
      // is STRUCTURALLY equal to the effect, not equal only by convention.
      total += replaceInHtml(it.html, { ...opts, replaceWith: '' }).count;
    } else if (typeof it.text === 'string' && it.text !== '') {
      re.lastIndex = 0;
      const found = it.text.match(re);
      total += found ? found.length : 0;
    }
  }
  return total;
}
