// packages/group/do-work/board-icalendar.ts
//
// Board -> iCALENDAR (.ics) export: every card that has a due date becomes an all-day VEVENT, so a goal
// board's deadlines drop straight into any calendar app (Apple/Google/Outlook). A third document-export
// FORMAT alongside Markdown (do-work/board-markdown) — both are DATA rows in the export registry
// (do-work/board-document-exports); this file owns ONLY the RFC 5545 serialization. Pure + deterministic:
// `now` is injected (the DTSTAMP). Composes the shipped due-date leaf — no new signal, no storage.
//
// RFC 5545 correctness: CRLF line endings, TEXT escaping (\ ; , and newlines), all-day events via
// DTSTART;VALUE=DATE, a stable UID per card (so re-import updates rather than duplicates), and content
// lines folded at 75 octets. A card with no due date is skipped; connectors + furniture are never events.

import type { BoardItem } from '../read-data/group-board-model.ts';
import { itemIsConnector } from '../read-data/group-board-model.ts';
import { itemIsBoardFurniture } from './batch-actions.ts';
import { dueDateFromRaw, dueMsToDateLabel } from '../read-data/board-due-date.ts';
import { metricFromRaw, progressPct } from '../read-data/board-metric.ts';

/** Escape a value for an iCalendar TEXT property (RFC 5545 §3.3.11): backslash, semicolon, comma, newline. */
function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** An all-day DATE value (YYYYMMDD) from an epoch-ms due date — UTC-day, locale-free (via the due leaf). */
function icsDate(ms: number): string {
  return dueMsToDateLabel(ms).replace(/-/g, ''); // "2026-07-11" -> "20260711"
}

/** A UTC DATE-TIME stamp (YYYYMMDDTHHMMSSZ) from epoch-ms — the DTSTAMP. */
function icsDateTimeUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Fold a content line to 75 octets per RFC 5545 §3.1 (continuation = CRLF + a single space). */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 0) {
    parts.push(' ' + rest.slice(0, 74)); // leading space costs one octet -> 74 payload
    rest = rest.slice(74);
  }
  return parts.join('\r\n');
}

const labelOf = (item: BoardItem): string => {
  const t = typeof item.text === 'string' ? item.text.trim() : '';
  return t.length > 0 ? t : '(untitled)';
};

export interface BoardICalendarOptions {
  /** Stamp applied to every VEVENT's DTSTAMP (defaults to `now`); exposed for deterministic proofs. */
  readonly dtstamp?: number;
  /** A stable suffix for UIDs so re-export/re-import updates the same events (defaults to a board tag). */
  readonly uidDomain?: string;
}

/**
 * Serialize a board's due-dated cards to an iCalendar document at `now`. Each due card becomes an all-day
 * VEVENT (SUMMARY = card text, optional DESCRIPTION = metric %). Cards with no due date, connectors, and
 * furniture are skipped. Deterministic given `now` (+ opts). Always returns a valid (possibly event-less)
 * VCALENDAR.
 */
export function boardToICalendar(items: readonly BoardItem[], now: number, opts: BoardICalendarOptions = {}): string {
  const dtstamp = icsDateTimeUtc(typeof opts.dtstamp === 'number' ? opts.dtstamp : now);
  const domain = typeof opts.uidDomain === 'string' && opts.uidDomain.length > 0 ? opts.uidDomain : 'board.bitfield';

  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bitfield//Board//EN', 'CALSCALE:GREGORIAN'];

  for (const it of items) {
    if (itemIsConnector(it) || itemIsBoardFurniture(it)) continue;
    const due = dueDateFromRaw(it.extra?.dueDate);
    if (due === null) continue;

    const metric = metricFromRaw(it.extra?.metric);
    lines.push('BEGIN:VEVENT');
    lines.push(foldLine(`UID:${escapeText(it.memberId)}@${domain}`));
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${icsDate(due)}`);
    lines.push(foldLine(`SUMMARY:${escapeText(labelOf(it))}`));
    if (metric) lines.push(foldLine(`DESCRIPTION:${escapeText(`${progressPct(metric)}% complete`)}`));
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
