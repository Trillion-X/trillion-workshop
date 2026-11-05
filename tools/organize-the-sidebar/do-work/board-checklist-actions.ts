// packages/group/do-work/board-checklist-actions.ts
//
// The GRAPH bridge for the checklist primitive (read-data/board-checklist): read an item's checklist as
// self-describing DATA, and mutate it through the ONE tested `patchItem` write path. A checklist lives
// ON the item as `extra.checklist` (co-locates → moves + deletes with the item, rides along in shares/
// templates via the existing `extra` preservation). Connectors + auto furniture are never checklist
// targets — you break down CONTENT, not the board's own scaffolding.

import type { GroupGraph, AddressRef } from '../../ui/show/group/group-graph';
import type { BoardItem } from '../read-data/group-board-model.ts';
import { readItems, patchItem, itemIsConnector } from '../read-data/group-board-model.ts';
import { itemIsBoardFurniture } from './batch-actions.ts';
import {
  type Checklist,
  type ChecklistItem,
  type ChecklistedItem,
  EMPTY_CHECKLIST,
  addChecklistItem,
  boardChecklistRollup,
  checklistFromRaw,
  removeChecklistItem,
  renameChecklistItem,
  toggleChecklistItem,
} from '../read-data/board-checklist.ts';

/** An item is a checklist TARGET iff it is real content, not a connector or furniture. */
export function itemIsChecklistTarget(item: BoardItem): boolean {
  return !itemIsConnector(item) && !itemIsBoardFurniture(item);
}

/** The normalized checklist on one item (EMPTY_CHECKLIST when it has none / a malformed value). */
export function checklistOfItem(item: BoardItem): Checklist {
  return checklistFromRaw(item.extra?.checklist);
}

/** Read one item's checklist from the live graph. */
export function checklistOf(graph: GroupGraph, ref: AddressRef, memberId: string): Checklist {
  const item = readItems(graph, ref).find((it) => it.memberId === memberId);
  return item ? checklistOfItem(item) : EMPTY_CHECKLIST;
}

/** Every checklist target on the board paired with its checklist — the input to the rollup. */
export function boardChecklists(items: readonly BoardItem[]): ChecklistedItem[] {
  return items.filter(itemIsChecklistTarget).map((it): ChecklistedItem => ({ id: it.memberId, checklist: checklistOfItem(it) }));
}

/** The whole-board rollup (done/total steps across every item) — the header readout. */
export function boardRollup(items: readonly BoardItem[]): { done: number; total: number } {
  return boardChecklistRollup(boardChecklists(items));
}

// ── mutations: each reads the current checklist, applies the pure leaf op, writes back via patchItem ──

/** Add a step to an item's checklist (the caller injects its id). */
export function addStepToItem(graph: GroupGraph, ref: AddressRef, memberId: string, step: ChecklistItem): GroupGraph {
  return patchItem(graph, ref, memberId, { checklist: addChecklistItem(checklistOf(graph, ref, memberId), step) });
}

/** Toggle a step's done flag. */
export function toggleStepOnItem(graph: GroupGraph, ref: AddressRef, memberId: string, stepId: string): GroupGraph {
  return patchItem(graph, ref, memberId, { checklist: toggleChecklistItem(checklistOf(graph, ref, memberId), stepId) });
}

/** Rename a step. */
export function renameStepOnItem(graph: GroupGraph, ref: AddressRef, memberId: string, stepId: string, text: string): GroupGraph {
  return patchItem(graph, ref, memberId, { checklist: renameChecklistItem(checklistOf(graph, ref, memberId), stepId, text) });
}

/** Remove a step. */
export function removeStepFromItem(graph: GroupGraph, ref: AddressRef, memberId: string, stepId: string): GroupGraph {
  return patchItem(graph, ref, memberId, { checklist: removeChecklistItem(checklistOf(graph, ref, memberId), stepId) });
}
