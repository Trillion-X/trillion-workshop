// packages/group/read-data/board-orphans.ts
//
// ORPHAN cards — content cards connected to NOTHING, across BOTH relationship layers: no drawn connector
// (relationship-graph) AND no typed [[reference]] (card-references), in either direction. On a big vision /
// mind-map board these are the forgotten, unintegrated ideas — the ones worth either wiring in or deleting.
// A pure COMPOSITION of the two shipped relationship leaves — it owns no graph logic of its own (L069/L093):
// a card is NOT an orphan the moment it is reachable by a line you DREW or a reference you TYPED.
//
// Connectors and sections are never orphans (a connector is not a content card; a section is a container).
// A card whose only reference is BROKEN (`[[Nonexistent]]`) still counts as an orphan — a dangling link
// connects it to nothing real (cardReferences only yields RESOLVED edges). Deterministic (sorted).

import type { BoardItem } from './group-board-model';
import { itemIsConnector } from './group-board-model';
import { buildRelationGraph } from './relationship-graph';
import { cardReferences } from './card-references';

/** The member ids of every card touched by a drawn connector OR a resolved `[[reference]]` (either direction). */
function connectedIds(items: readonly BoardItem[]): Set<string> {
  const graph = buildRelationGraph(items);
  const touched = new Set<string>();
  for (const e of graph.edges) {
    touched.add(e.from);
    touched.add(e.to);
  }
  for (const r of cardReferences(items)) {
    touched.add(r.from);
    touched.add(r.to);
  }
  return touched;
}

/** The ORPHANS: content cards (not connectors, not sections) that no connector and no reference touches.
 *  Sorted, deterministic. */
export function orphanCards(items: readonly BoardItem[]): string[] {
  const touched = connectedIds(items);
  const out: string[] = [];
  for (const it of items) {
    if (itemIsConnector(it) || it.isSection) continue;
    if (!touched.has(it.memberId)) out.push(it.memberId);
  }
  return out.sort();
}

/** True iff `cardId` is an orphan on this board (a content card touched by no connector and no reference). */
export function isOrphan(items: readonly BoardItem[], cardId: string): boolean {
  const item = items.find((it) => it.memberId === cardId);
  if (!item || itemIsConnector(item) || item.isSection) return false;
  return !connectedIds(items).has(cardId);
}
