// packages/group/do-work/board-icalendar-import.ts
//
// iCALENDAR (.ics) -> board import: the round-trip partner of the .ics EXPORT (do-work/board-icalendar). A
// pasted or dropped calendar becomes one dated card per VEVENT — SUMMARY -> the card text, DTSTART -> the
// card's `extra.dueDate` (the SAME due-date field the export reads + the badge/timeline consume), so a goal
// board's deadlines come back from any calendar app (Apple/Google/Outlook). A fourth DATA row in the blind
// import registry (show/document-imports) alongside markdown/csv/mermaid; this file owns ONLY the RFC 5545
// PARSE. Pure + deterministic (no clock — `Date.UTC` of parsed digits is a pure function of the text).
//
// RFC 5545 handled: line UNFOLDING (a CRLF/LF followed by a space or tab continues the prior line — the
// inverse of the export's 75-octet fold), TEXT unescaping (\\ \; \, \n), DTSTART as an all-day DATE
// (YYYYMMDD) OR a date-time (YYYYMMDDThhmmssZ — the date part is taken, an all-day card), and VEVENT framing.
// An event with no parseable DTSTART is skipped (a due-less card is not a calendar event); an empty calendar
// yields [] (the funnel then falls through to plain paste).

import type { BoardItemDraft } from '../show/item-add-strategies';

/** One parsed calendar event — the SOURCE fields a board card is reconstructed from (derived readouts like
 *  the export's "NN% complete" DESCRIPTION are NOT re-imported: they are computed on export, not source). */
export interface ParsedIcalEvent {
  readonly uid: string | null;
  readonly summary: string;
  /** The event day as epoch-ms at UTC midnight (all-day) — the value written to `extra.dueDate`. */
  readonly dueMs: number;
}

/** Conservative recognizer — a real .ics always opens with `BEGIN:VCALENDAR`; a plain paste never does. */
export function looksLikeICalendar(text: string): boolean {
  return /BEGIN:VCALENDAR/i.test(text);
}

/** Reverse the export's TEXT escaping (RFC 5545 §3.3.11): `\\` `\;` `\,` `\n`/`\N`. Single pass so an escaped
 *  backslash before a comma (`\\,`) unescapes to a literal backslash + a comma, not a newline-run. */
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Undo RFC 5545 line folding: a line break followed by a single space or tab is a continuation. */
function unfold(text: string): string {
  return text.replace(/\r?\n[ \t]/g, '');
}

/** Parse a DTSTART value (`20260711`, `2026-07-11`, or `20260711T090000Z`) to epoch-ms at UTC midnight of
 *  that day, or null if no YYYYMMDD is present. All-day semantics: the time part (if any) is ignored. */
function dtStartToUtcMs(value: string): number | null {
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;
  const y = Number(digits.slice(0, 4));
  const mo = Number(digits.slice(4, 6));
  const d = Number(digits.slice(6, 8));
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  return Number.isFinite(ms) ? ms : null;
}

/** Split a content line `NAME[;PARAM=…]:VALUE` into its property name (upper-cased, params dropped) + value. */
function splitProp(line: string): { name: string; value: string } | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const semi = head.indexOf(';');
  const name = (semi < 0 ? head : head.slice(0, semi)).trim().toUpperCase();
  return name.length > 0 ? { name, value } : null;
}

/**
 * Parse an iCalendar document into its dated events. Unfolds first, then walks VEVENT blocks pulling SUMMARY +
 * DTSTART (+ UID). Events without a parseable DTSTART are dropped (an all-day card needs a day). Pure.
 */
export function parseICalendar(text: string): ParsedIcalEvent[] {
  const lines = unfold(text).split(/\r?\n/);
  const events: ParsedIcalEvent[] = [];
  let inEvent = false;
  let uid: string | null = null;
  let summary = '';
  let dueMs: number | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      uid = null;
      summary = '';
      dueMs = null;
      continue;
    }
    if (line === 'END:VEVENT') {
      if (inEvent && dueMs !== null) {
        events.push({ uid, summary: summary.trim().length > 0 ? summary.trim() : '(untitled)', dueMs });
      }
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;
    const prop = splitProp(line);
    if (!prop) continue;
    if (prop.name === 'SUMMARY') summary = unescapeText(prop.value);
    else if (prop.name === 'DTSTART') dueMs = dtStartToUtcMs(prop.value);
    else if (prop.name === 'UID') uid = prop.value.trim() || null;
  }
  return events;
}

/**
 * Turn a pasted/dropped iCalendar into board card drafts — one `{kind:'note'}` per dated event, carrying the
 * event day as `extra.dueDate` so the shipped due-date badge/timeline light up immediately. Flat (no
 * connectors) → the funnel drops them via the shared grid placement. `[]` for a non-calendar / event-less doc.
 */
export function icalendarToDrafts(text: string): BoardItemDraft[] {
  return parseICalendar(text).map((ev) => ({ kind: 'note', text: ev.summary, extra: { dueDate: ev.dueMs } }));
}
