// Proof for the board -> iCalendar (.ics) export: each due-dated card is an all-day VEVENT (stable UID,
// DTSTART;VALUE=DATE, DTSTAMP, escaped SUMMARY, optional metric DESCRIPTION), cards with no due date +
// connectors + furniture are skipped, TEXT is RFC-escaped, long lines fold, and lines are CRLF-joined.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model';
import { AXIS_TICK_PREFIX } from './batch-actions';
import { setItemDueDate } from './board-due-date-actions';
import { setItemMetric } from './board-metric-actions';
import { dueMsToDateLabel } from '../read-data/board-due-date';
import { boardToICalendar } from './board-icalendar';

const DAY = 86_400_000;
const NOW = 1_760_000_000_000;
const STAMP = 1_760_000_000_000;
const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };
const ics = (g: ReturnType<typeof emptyGraph>) => boardToICalendar(readItems(g, PARENT), NOW, { dtstamp: STAMP });
const put = (g: ReturnType<typeof emptyGraph>, a: Record<string, unknown>) =>
  placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, kind: 'note', ...a } as never);

describe('board-icalendar — .ics export of due dates', () => {
  it('wraps a valid, CRLF-joined VCALENDAR even with no events', () => {
    const out = boardToICalendar([], NOW);
    expect(out.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0')).toBe(true);
    expect(out.endsWith('END:VCALENDAR')).toBe(true);
    expect(out.includes('BEGIN:VEVENT')).toBe(false);
  });

  it('a due card becomes an all-day VEVENT with a stable UID, DTSTART DATE, and DTSTAMP', () => {
    let g = emptyGraph();
    g = put(g, { memberId: 'goal', x: 0, y: 0, text: 'Ship v1' });
    g = setItemDueDate(g, PARENT, 'goal', NOW + 3 * DAY);
    const out = ics(g);
    const date = dueMsToDateLabel(NOW + 3 * DAY).replace(/-/g, '');
    expect(out).toContain('BEGIN:VEVENT');
    expect(out).toContain('UID:goal@example.com');
    expect(out).toContain(`DTSTART;VALUE=DATE:${date}`);
    expect(out).toContain('SUMMARY:Ship v1');
    expect(out).toContain('DTSTAMP:'); // present
  });

  it('a card with NO due date produces no event', () => {
    let g = emptyGraph();
    g = put(g, { memberId: 'nodate', x: 0, y: 0, text: 'someday' });
    expect(ics(g).includes('BEGIN:VEVENT')).toBe(false);
  });

  it('a metric adds a DESCRIPTION with the percent complete', () => {
    let g = emptyGraph();
    g = put(g, { memberId: 'goal', x: 0, y: 0, text: 'Save' });
    g = setItemDueDate(g, PARENT, 'goal', NOW + DAY);
    g = setItemMetric(g, PARENT, 'goal', { current: 8, target: 10 });
    expect(ics(g)).toContain('DESCRIPTION:80% complete');
  });

  it('SUMMARY escapes comma, semicolon, and backslash (RFC 5545 TEXT)', () => {
    let g = emptyGraph();
    g = put(g, { memberId: 'g', x: 0, y: 0, text: 'Plan A, B; C\\D' });
    g = setItemDueDate(g, PARENT, 'g', NOW + DAY);
    expect(ics(g)).toContain('SUMMARY:Plan A\\, B\\; C\\\\D');
  });

  it('connectors and furniture never become events', () => {
    let g = emptyGraph();
    g = put(g, { memberId: 'g', x: 0, y: 0, text: 'real' });
    g = setItemDueDate(g, PARENT, 'g', NOW + DAY);
    g = put(g, { memberId: 'edge', x: 0, y: 0, kind: 'connector', extra: { fromMemberId: 'g', toMemberId: 'g', dueDate: NOW + DAY } });
    g = put(g, { memberId: `${AXIS_TICK_PREFIX}x:1`, x: 0, y: 9, text: '1', extra: { axisTick: true, dueDate: NOW + DAY } });
    expect((ics(g).match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
  });

  it('a long SUMMARY folds at 75 octets (continuation line starts with a space)', () => {
    let g = emptyGraph();
    g = put(g, { memberId: 'g', x: 0, y: 0, text: 'x'.repeat(120) });
    g = setItemDueDate(g, PARENT, 'g', NOW + DAY);
    const out = ics(g);
    // every physical line is <= 75 chars, and the folded continuation begins with a space
    const summaryLines = out.split('\r\n').filter((l, i, arr) => l.startsWith('SUMMARY:') || (arr[i - 1] && (arr[i - 1].startsWith('SUMMARY:') || arr[i - 1].startsWith(' '))));
    expect(out.split('\r\n').every((l) => l.length <= 75)).toBe(true);
    expect(out.split('\r\n').some((l) => l.startsWith(' x'))).toBe(true);
  });
});
