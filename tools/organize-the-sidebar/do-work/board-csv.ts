// packages/group/do-work/board-csv.ts
//
// Board -> CSV export: one row per goal card (Title, Due, Progress %, Checklist Done/Total, Tags), so a
// board's goals drop into a spreadsheet for sorting, filtering, pivoting, and charting. The tabular member
// of the export family — Markdown is the document, iCalendar is the calendar, CSV is the SPREADSHEET; all
// three are DATA rows in the export registry (do-work/board-document-exports). Pure + deterministic (Due is
// an absolute date, locale-free — no clock needed). Composes the shipped leaves (cardCompletion SSOT for
// progress, due-date, checklist, tags) — no new signal, no storage.
//
// RFC 4180: header row, CRLF line endings, and any field containing a comma / quote / newline is wrapped in
// double quotes with internal quotes doubled. Progress is a bare NUMBER (80, not "80%") so a spreadsheet
// can compute on it. Connectors, furniture, and sections are not goal rows and are skipped.

import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import { itemIsBoardFurniture } from './batch-actions';
import { cardCompletion } from '../read-data/card-completion';
import { dueDateFromRaw, dueMsToDateLabel } from '../read-data/board-due-date';
import { checklistFromRaw, checklistProgress } from '../read-data/board-checklist';
import { itemTags } from '../show/item-tags';

const HEADERS = ['Title', 'Due', 'Progress %', 'Checklist Done', 'Checklist Total', 'Tags'] as const;

/** Quote a CSV field per RFC 4180 (only when it contains a comma, quote, or newline). Shared with
 *  `report-export` (a report's rows serialise through the SAME escaping — one CSV-quoting SSOT, L100). */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const labelOf = (item: BoardItem): string => {
  const t = typeof item.text === 'string' ? item.text.trim() : '';
  return t.length > 0 ? t : '(untitled)';
};

/** A goal ROW is real content: not a connector, not furniture, not a section (a section is not a goal). */
function isGoalRow(item: BoardItem): boolean {
  return !itemIsConnector(item) && !itemIsBoardFurniture(item) && !item.isSection;
}

/**
 * Serialize a board's goal cards to CSV. Each row carries the card's title, its due date (YYYY-MM-DD or
 * blank), its completion percent (a bare number, or blank when the card tracks no progress), its checklist
 * done/total counts, and its tags (semicolon-separated). Always emits the header row. Pure + deterministic.
 */
export function boardToCsv(items: readonly BoardItem[]): string {
  const rows: string[] = [HEADERS.join(',')];

  for (const it of items) {
    if (!isGoalRow(it)) continue;

    const due = dueDateFromRaw(it.extra?.dueDate);
    const completion = cardCompletion(it);
    const list = checklistProgress(checklistFromRaw(it.extra?.checklist));

    const cells = [
      labelOf(it),
      due !== null ? dueMsToDateLabel(due) : '',
      completion !== undefined ? String(Math.round(completion * 100)) : '',
      list.total > 0 ? String(list.done) : '',
      list.total > 0 ? String(list.total) : '',
      itemTags(it).join('; '),
    ];
    rows.push(cells.map(csvField).join(','));
  }

  return rows.join('\r\n');
}
