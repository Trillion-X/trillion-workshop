// packages/group/do-work/board-date-coverage.ts
//
// DATE COVERAGE — the scheduling completeness of a board. Once a board is partly scheduled (some cards carry a
// due date), the cards WITHOUT one are the gaps — the tasks still missing a deadline. And the dated cards
// define a TIMELINE SPAN (earliest → latest) — how far out the plan reaches. This surfaces both: "which cards
// still need a date?" and "what window does this board cover?".
//
// Distinct from the other date readers: `board-agenda` groups the dated cards by URGENCY (overdue/soon/…),
// `board-forecast` projects COMPLETION — this is about COVERAGE (dated vs not) and the raw span. A pure
// composition of the due-date SSOT (`dueDateFromRaw` from board-due-date, L069/L093 — owns no date parsing) +
// the furniture guard (so a generated region-heading is never flagged "needs a deadline"). Pure, deterministic;
// reads only the cards' own due dates (no clock — the span is a property of the data, not of "now").

import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import { dueDateFromRaw, dueMsToDateLabel } from '../read-data/board-due-date';
import { itemIsBoardFurniture } from './batch-actions';

/** A content card = not a connector (an edge) and not generated furniture (a heading/axis-tick). Only content
 *  cards can meaningfully carry — or lack — a due date. */
function contentCards(items: readonly BoardItem[]): BoardItem[] {
  return items.filter((i) => !itemIsConnector(i) && !itemIsBoardFurniture(i));
}

/** A card's due date in epoch-ms, or null when it has none. Reads the same `extra.dueDate` the board writes. */
function dueOf(item: BoardItem): number | null {
  return dueDateFromRaw((item.extra as Record<string, unknown> | undefined)?.dueDate);
}

/** The content cards that HAVE a due date, sorted. */
export function datedCardIds(items: readonly BoardItem[]): string[] {
  return contentCards(items).filter((i) => dueOf(i) !== null).map((i) => i.memberId).sort();
}

/** The content cards that LACK a due date — the "needs a deadline" set, sorted. */
export function undatedCardIds(items: readonly BoardItem[]): string[] {
  return contentCards(items).filter((i) => dueOf(i) === null).map((i) => i.memberId).sort();
}

/** True iff the board is PARTLY scheduled — ≥1 dated card AND ≥1 undated card. Only then is "select the cards
 *  still missing a deadline" meaningful (a fully-undated board isn't a schedule; a fully-dated one has no gap).
 *  The gate for the Select-undated affordance (L118). */
export function boardHasDateGaps(items: readonly BoardItem[]): boolean {
  const cards = contentCards(items);
  let dated = 0;
  let undated = 0;
  for (const c of cards) (dueOf(c) === null ? undated++ : dated++);
  return dated > 0 && undated > 0;
}

/** The board's date coverage: the earliest + latest due date, the span in whole days, and the dated/undated
 *  counts. `null` when NO card carries a date (there is no timeline to describe). */
export interface DateSpan {
  readonly earliestMs: number;
  readonly latestMs: number;
  readonly spanDays: number;
  readonly datedCount: number;
  readonly undatedCount: number;
}

export function dateSpan(items: readonly BoardItem[]): DateSpan | null {
  const cards = contentCards(items);
  let earliestMs = Infinity;
  let latestMs = -Infinity;
  let datedCount = 0;
  let undatedCount = 0;
  for (const c of cards) {
    const due = dueOf(c);
    if (due === null) { undatedCount++; continue; }
    datedCount++;
    if (due < earliestMs) earliestMs = due;
    if (due > latestMs) latestMs = due;
  }
  if (datedCount === 0) return null;
  return { earliestMs, latestMs, spanDays: Math.round((latestMs - earliestMs) / 86_400_000), datedCount, undatedCount };
}

/** Render the coverage readout: the timeline window (earliest → latest, N days) + the dated/undated tally.
 *  "No scheduled cards" when nothing is dated. */
export function dateCoverageText(items: readonly BoardItem[], title?: string): string {
  const span = dateSpan(items);
  const head: string[] = title && title.trim() !== '' ? [`# ${title.trim()}`, ''] : [];
  if (span === null) return [...head, 'No scheduled cards'].join('\n');
  const window = span.spanDays === 0
    ? `${dueMsToDateLabel(span.earliestMs)}`
    : `${dueMsToDateLabel(span.earliestMs)} → ${dueMsToDateLabel(span.latestMs)} (${span.spanDays} ${span.spanDays === 1 ? 'day' : 'days'})`;
  return [
    ...head,
    '## Timeline span',
    `- Window: ${window}`,
    `- Scheduled: ${span.datedCount} ${span.datedCount === 1 ? 'card' : 'cards'}`,
    `- Undated: ${span.undatedCount} ${span.undatedCount === 1 ? 'card' : 'cards'}`,
  ].join('\n');
}
