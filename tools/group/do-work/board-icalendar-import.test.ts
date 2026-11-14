// packages/group/do-work/board-icalendar-import.test.ts
import { describe, it, expect } from 'vitest';
import { looksLikeICalendar, parseICalendar, icalendarToDrafts } from './board-icalendar-import';
import { boardToICalendar } from './board-icalendar';
import type { BoardItem } from '../read-data/group-board-model';

const card = (id: string, text: string, dueDate?: number): BoardItem =>
  ({ memberId: id, nodeRef: { id }, kind: 'note', x: 0, y: 0, w: 1, h: 1, isSection: false, childCount: 0, text, extra: dueDate ? { dueDate } : {} } as unknown as BoardItem);

const DAY = 86_400_000;

describe('looksLikeICalendar', () => {
  it('recognizes a VCALENDAR document, rejects plain text', () => {
    expect(looksLikeICalendar('BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR')).toBe(true);
    expect(looksLikeICalendar('buy milk\nwash car')).toBe(false);
    expect(looksLikeICalendar('')).toBe(false);
  });
});

describe('parseICalendar', () => {
  it('parses a VEVENT: SUMMARY, DTSTART (all-day DATE), UID', () => {
    const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:abc@example.com\nDTSTART;VALUE=DATE:20260711\nSUMMARY:Buy a house\nEND:VEVENT\nEND:VCALENDAR';
    const [ev] = parseICalendar(ics);
    expect(ev.summary).toBe('Buy a house');
    expect(ev.uid).toBe('abc@example.com');
    expect(ev.dueMs).toBe(Date.UTC(2026, 6, 11));
  });

  it('takes the date part of a date-time DTSTART (all-day card)', () => {
    const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260711T090000Z\nSUMMARY:Meeting\nEND:VEVENT\nEND:VCALENDAR';
    expect(parseICalendar(ics)[0].dueMs).toBe(Date.UTC(2026, 6, 11));
  });

  it('un-escapes TEXT (\\, \\; \\n) in the SUMMARY', () => {
    const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20260101\nSUMMARY:Plan A\\, then B\\; go\\nnext line\nEND:VEVENT\nEND:VCALENDAR';
    expect(parseICalendar(ics)[0].summary).toBe('Plan A, then B; go\nnext line');
  });

  it('un-folds a continuation line (CRLF + space) before parsing', () => {
    const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260101\r\nSUMMARY:A very long summary that the exporter\r\n  folded across two lines\r\nEND:VEVENT\r\nEND:VCALENDAR';
    expect(parseICalendar(ics)[0].summary).toBe('A very long summary that the exporter folded across two lines');
  });

  it('skips an event with no DTSTART and a calendar with none', () => {
    const noStart = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:No date\nEND:VEVENT\nEND:VCALENDAR';
    expect(parseICalendar(noStart)).toEqual([]);
    expect(parseICalendar('BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR')).toEqual([]);
  });

  it('parses multiple events in order', () => {
    const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20260101\nSUMMARY:One\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20260202\nSUMMARY:Two\nEND:VEVENT\nEND:VCALENDAR';
    expect(parseICalendar(ics).map((e) => e.summary)).toEqual(['One', 'Two']);
  });
});

describe('icalendarToDrafts', () => {
  it('makes one dated note draft per event', () => {
    const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20260711\nSUMMARY:Ship it\nEND:VEVENT\nEND:VCALENDAR';
    expect(icalendarToDrafts(ics)).toEqual([{ kind: 'note', text: 'Ship it', extra: { dueDate: Date.UTC(2026, 6, 11) } }]);
  });

  it('is empty for a non-calendar document', () => {
    expect(icalendarToDrafts('just a plain note')).toEqual([]);
  });

  it('round-trips a boardToICalendar export: export → import recovers text + all-day due date', () => {
    // A due date at a non-midnight instant: the export floors it to the day; re-import lands on UTC midnight.
    const due = Date.UTC(2026, 6, 11) + 9 * 3_600_000; // 09:00 UTC on 2026-07-11
    const board: BoardItem[] = [card('a', 'Buy a house', due), card('b', 'No date card')];
    const ics = boardToICalendar(board, Date.UTC(2026, 0, 1));
    const drafts = icalendarToDrafts(ics);
    expect(drafts).toHaveLength(1); // only the due-dated card round-trips (an all-day event)
    expect(drafts[0].text).toBe('Buy a house');
    expect(drafts[0].extra?.dueDate).toBe(Date.UTC(2026, 6, 11)); // floored to the day
    expect((drafts[0].extra?.dueDate as number) % DAY).toBe(0); // exactly a UTC-day boundary
  });
});
