// packages/group/do-work/board-due-date-actions.ts
//
// The GRAPH bridge for the due-date primitive (read-data/board-due-date): read an item's due date as
// self-describing DATA, set/clear it through the ONE tested `patchItem` write path, and reduce the board
// to a "Due soon" list. A due date lives ON the item as `extra.dueDate` (co-locates → moves + deletes
// with the item, rides along in shares/templates via the existing `extra` preservation). Connectors +
// auto furniture are never due-date targets — you schedule CONTENT, not the board's own scaffolding.

import type { GroupGraph, AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { BoardItem } from '../read-data/group-board-model';
import { readItems, patchItem, itemIsConnector } from '../read-data/group-board-model';
import { itemIsBoardFurniture } from './batch-actions';
import { type DueItem, type RelativeDue, dueDateFromRaw, relativeDue, sortByDue } from 'trillion-workshop/tools/organize-the-sidebar/read-data/board-due-date.ts';

/** An item is a due-date TARGET iff it is real content, not a connector or furniture. */
export function itemIsDueTarget(item: BoardItem): boolean {
  return !itemIsConnector(item) && !itemIsBoardFurniture(item);
}

/** The due date on one item (null when none / malformed). */
export function dueDateOfItem(item: BoardItem): number | null {
  return dueDateFromRaw(item.extra?.dueDate);
}

/** Read one item's due date from the live graph (null if absent). */
export function dueDateOf(graph: GroupGraph, ref: AddressRef, memberId: string): number | null {
  const item = readItems(graph, ref).find((it) => it.memberId === memberId);
  return item ? dueDateOfItem(item) : null;
}

/** Set (or clear with null) an item's due date. */
export function setItemDueDate(graph: GroupGraph, ref: AddressRef, memberId: string, due: number | null): GroupGraph {
  return patchItem(graph, ref, memberId, { dueDate: due ?? undefined });
}

/** Every due-date target that HAS a due date, paired with it. */
export function boardDueItems(items: readonly BoardItem[]): DueItem[] {
  const out: DueItem[] = [];
  for (const it of items) {
    if (!itemIsDueTarget(it)) continue;
    const due = dueDateOfItem(it);
    if (due !== null) out.push({ id: it.memberId, due });
  }
  return out;
}

/** One "Due soon" row: the item + a human label + its relative-time readout. */
export interface DueRow {
  readonly memberId: string;
  readonly label: string;
  readonly relative: RelativeDue;
}

/**
 * The "Due soon" rows (nearest due first) with each item's own text as its label — the DATA behind a
 * due list with jump-to. `now` is injected. Pure read-model over `boardDueItems` + `sortByDue`.
 */
export function dueRows(items: readonly BoardItem[], now: number): DueRow[] {
  const byId = new Map(items.map((it) => [it.memberId, it]));
  const label = (id: string): string => {
    const t = byId.get(id)?.text;
    const trimmed = typeof t === 'string' ? t.trim() : '';
    return trimmed !== '' ? trimmed : id;
  };
  return sortByDue(boardDueItems(items)).map((d): DueRow => ({ memberId: d.id, label: label(d.id), relative: relativeDue(d.due, now) }));
}

/** Count of items whose due date is overdue at `now` — the header "N overdue" readout. */
export function overdueCount(items: readonly BoardItem[], now: number): number {
  return boardDueItems(items).filter((d) => relativeDue(d.due, now).overdue).length;
}
