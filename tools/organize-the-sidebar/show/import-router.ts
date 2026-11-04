// packages/group/show/import-router.ts
//
// The ONE import router — maps a pasted/dropped text into a placement instruction, shared by every input
// channel (clipboard paste AND file drop, and any future channel). It composes the blind `detectImport`
// registry with the two placement shapes the board supports, so the "which placement?" decision lives in
// exactly ONE pure place (L063/SSOT) instead of being re-branched at each call site. A caller just switches
// on `placement.kind` and calls the matching board primitive.
//
//   text → detectImport (format registry) → parse → { tree | drafts }
//        → routeImport → { kind: 'tree'  }  → place hierarchically (materializeItems) — markdown sections
//                        { kind: 'drafts'}  → flat grid (fillFromDrafts)               — csv / section-less md
//                        null                → not a recognized document (caller falls through to plain paste)

import type { BoardItemDraft } from './item-add-strategies';
import type { BoardItem } from '../read-data/group-board-model';
import { flattenTreeToDrafts, type MarkdownNode } from './markdown-to-drafts';
import { detectImport } from './document-imports';

/** A placement instruction: a hierarchy-bearing tree (place via `materializeItems`), a flat draft list
 *  (place via `fillFromDrafts`), a pre-built board FRAGMENT with positions + connectors (place via the clone
 *  pipeline — a graph, e.g. a Mermaid flowchart), or null when the text is not a recognized document.
 *  Self-describing (L090) — the caller dispatches on `kind`, never on a format name. */
export type ImportPlacement =
  | { readonly kind: 'tree'; readonly nodes: readonly MarkdownNode[] }
  | { readonly kind: 'drafts'; readonly drafts: readonly BoardItemDraft[] }
  | { readonly kind: 'items'; readonly items: readonly BoardItem[] }
  | null;

/**
 * Decide how a pasted/dropped text should land on the board. Recognizes the format via the `DOCUMENT_IMPORTS`
 * registry, parses it, and returns a tree placement (when the parse yields sections) or a flat draft
 * placement (section-less markdown or csv). Returns null when nothing recognizes the text OR the recognized
 * document is empty (the caller then falls through to plain one-note-per-line paste). Pure + deterministic.
 */
export function routeImport(text: string): ImportPlacement {
  const imp = detectImport(text);
  if (!imp) return null;
  const result = imp.parse(text);
  if ('tree' in result) {
    if (result.tree.some((n) => n.kind === 'section')) return { kind: 'tree', nodes: result.tree };
    const drafts = flattenTreeToDrafts(result.tree);
    return drafts.length > 0 ? { kind: 'drafts', drafts } : null;
  }
  if ('items' in result) {
    return result.items.length > 0 ? { kind: 'items', items: result.items } : null;
  }
  return result.drafts.length > 0 ? { kind: 'drafts', drafts: result.drafts } : null;
}
