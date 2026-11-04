// packages/group/read-data/board-checklist.ts
//
// The item-CHECKLIST primitive: an ordered list of {text, done} steps attached to an item — the
// vision->action move (a goal note becomes a checklist of steps). This ONE blind engine yields, from
// DATA alone, every checklist feature — toggle a step, a done/total progress fraction, add/rename/
// remove, and a whole-board rollup ("18 of 30 steps done") — with zero per-feature code (L069/L090).
// A checklist lives as self-describing DATA on the item (`extra.checklist`); this leaf reads/normalizes/
// reduces it and never touches the graph. Pure + deterministic: new-item ids are INJECTED by the caller.

/** One checklist step: a stable id, its text, and whether it is done. */
export interface ChecklistItem {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
}

/** A checklist = an ordered list of steps. */
export type Checklist = readonly ChecklistItem[];

/** The progress readout for a checklist — the DATA behind a bar/pill/rollup. */
export interface ChecklistProgress {
  readonly done: number;
  readonly total: number;
  /** done/total in 0..1 (0 for an empty checklist — no divide-by-zero). */
  readonly fraction: number;
  /** True iff there is at least one step and all are done. */
  readonly complete: boolean;
}

/** The canonical empty checklist (an item with no steps → no pill). */
export const EMPTY_CHECKLIST: Checklist = [];

function isChecklistItem(raw: unknown): raw is ChecklistItem {
  if (!raw || typeof raw !== 'object') return false;
  const c = raw as Record<string, unknown>;
  return typeof c.id === 'string' && typeof c.text === 'string' && typeof c.done === 'boolean';
}

/** Max steps kept from one item's `extra.checklist` — a guardrail against a paste-bombed/corrupted
 *  persisted value, NOT a feature cap (a real checklist has a handful of steps). The board-momentum /
 *  board-attention rollups call checklistFromRaw once PER ITEM per compute, so an uncapped million-entry
 *  checklist on even one item forces unbounded filter/reduce across every render. */
const MAX_CHECKLIST_ITEMS = 512;
/** Hard scan bound so even an all-duplicate / all-junk bomb (which never fills the keep cap) is O(1) work. */
const MAX_CHECKLIST_SCAN = 4096;

/**
 * Normalize opaque DATA into a {@link Checklist}, fail-closed: keep only well-formed `{id,text,done}`
 * steps (malformed entries dropped, never crash the board), deduped by id, capped. Non-array → empty.
 * Read-time id dedup mirrors the write path (addChecklistItem rejects dup ids): two steps sharing an id
 * would both toggle/rename/remove together and double-count in progress/rollup, so a crafted duplicate id
 * must never enter the list. Self-describing DATA + a generic reader (L090) — no by-hand parsing downstream.
 */
export function checklistFromRaw(raw: unknown): Checklist {
  if (!Array.isArray(raw)) return EMPTY_CHECKLIST;
  const seen = new Set<string>();
  const out: ChecklistItem[] = [];
  const scanEnd = Math.min(raw.length, MAX_CHECKLIST_SCAN);
  for (let i = 0; i < scanEnd && out.length < MAX_CHECKLIST_ITEMS; i += 1) {
    const entry = raw[i];
    if (!isChecklistItem(entry) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push({ id: entry.id, text: entry.text, done: entry.done });
  }
  return out;
}

/** The progress of a checklist (done/total/fraction/complete). */
export function checklistProgress(list: Checklist): ChecklistProgress {
  const total = list.length;
  const done = list.reduce((n, it) => n + (it.done ? 1 : 0), 0);
  return { done, total, fraction: total === 0 ? 0 : done / total, complete: total > 0 && done === total };
}

/** True iff the checklist has any steps (drives whether an item shows a progress pill). */
export function hasChecklist(list: Checklist): boolean {
  return list.length > 0;
}

/** Toggle one step's done flag. */
export function toggleChecklistItem(list: Checklist, id: string): Checklist {
  return list.map((it) => (it.id === id ? { ...it, done: !it.done } : it));
}

/** Set one step's done flag explicitly. */
export function setChecklistItemDone(list: Checklist, id: string, done: boolean): Checklist {
  return list.map((it) => (it.id === id ? { ...it, done } : it));
}

/**
 * Append a step (the caller injects its id). Blank text is rejected, and a DUPLICATE id is rejected — two
 * steps sharing an id would both toggle/rename/remove together (id-based ops match every occurrence) and
 * double-count in progress, so an id collision must never enter the list. Returns the list unchanged if so.
 */
export function addChecklistItem(list: Checklist, item: ChecklistItem): Checklist {
  const text = item.text.trim();
  if (text === '' || list.some((it) => it.id === item.id)) return list;
  return [...list, { ...item, text }];
}

/** Rename a step (blank text is ignored). */
export function renameChecklistItem(list: Checklist, id: string, text: string): Checklist {
  const t = text.trim();
  return t === '' ? list : list.map((it) => (it.id === id ? { ...it, text: t } : it));
}

/** Remove a step. */
export function removeChecklistItem(list: Checklist, id: string): Checklist {
  return list.filter((it) => it.id !== id);
}

/** An item paired with its checklist — the input to the board rollup. */
export interface ChecklistedItem {
  readonly id: string;
  readonly checklist: Checklist;
}

/** The whole-board rollup: total done + total steps across every item's checklist. */
export function boardChecklistRollup(items: readonly ChecklistedItem[]): { done: number; total: number } {
  return items.reduce(
    (acc, it) => {
      const p = checklistProgress(it.checklist);
      return { done: acc.done + p.done, total: acc.total + p.total };
    },
    { done: 0, total: 0 },
  );
}
