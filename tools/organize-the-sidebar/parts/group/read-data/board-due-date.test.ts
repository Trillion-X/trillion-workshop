// Proof for the due-date primitive: fail-closed normalize + the relative-time engine (UTC-day math,
// deterministic regardless of machine timezone).
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  type DueItem,
  dueDateFromRaw,
  dueMsToDateLabel,
  isDueSoon,
  relativeDue,
  sortByDue,
} from '../../../read-data/board-due-date.ts';

const DAY = 86_400_000;
// A fixed "now" pinned to a UTC-day start so day offsets are exact.
const NOW = Math.floor(1_760_000_000_000 / DAY) * DAY + 12 * 3_600_000; // midday UTC on some day

describe('board-due-date — the due-date primitive', () => {
  it('dueDateFromRaw is fail-closed: positive integer ms only', () => {
    expect(dueDateFromRaw(NOW)).toBe(NOW);
    expect(dueDateFromRaw(0)).toBeNull();
    expect(dueDateFromRaw(-5)).toBeNull();
    expect(dueDateFromRaw(1.5)).toBeNull();
    expect(dueDateFromRaw('2026')).toBeNull();
    expect(dueDateFromRaw(undefined)).toBeNull();
  });

  it('relativeDue computes whole UTC-days, overdue flag, urgency bucket, and label', () => {
    const at = (days: number) => relativeDue(NOW + days * DAY, NOW);
    expect(at(0)).toMatchObject({ daysUntil: 0, overdue: false, urgency: 'today', label: 'Today' });
    expect(at(1)).toMatchObject({ daysUntil: 1, urgency: 'soon', label: 'Tomorrow' });
    expect(at(3)).toMatchObject({ daysUntil: 3, urgency: 'soon', label: 'in 3 days' });
    expect(at(10)).toMatchObject({ daysUntil: 10, urgency: 'upcoming', label: 'in 10 days' });
    expect(at(30)).toMatchObject({ daysUntil: 30, urgency: 'later' });
    expect(at(-1)).toMatchObject({ daysUntil: -1, overdue: true, urgency: 'overdue', label: 'Yesterday' });
    expect(at(-5)).toMatchObject({ daysUntil: -5, overdue: true, label: '5 days ago' });
  });

  it('isDueSoon = overdue | today | within 3 days', () => {
    expect(isDueSoon(NOW - 2 * DAY, NOW)).toBe(true); // overdue
    expect(isDueSoon(NOW, NOW)).toBe(true); // today
    expect(isDueSoon(NOW + 3 * DAY, NOW)).toBe(true); // soon
    expect(isDueSoon(NOW + 4 * DAY, NOW)).toBe(false); // upcoming
    expect(isDueSoon(NOW + 30 * DAY, NOW)).toBe(false); // later
  });

  it('sortByDue orders nearest (most overdue) first', () => {
    const items: DueItem[] = [
      { id: 'far', due: NOW + 10 * DAY },
      { id: 'overdue', due: NOW - 3 * DAY },
      { id: 'soon', due: NOW + 1 * DAY },
    ];
    expect(sortByDue(items).map((d) => d.id)).toEqual(['overdue', 'soon', 'far']);
  });
});

describe('board-due-date — out-of-Date-range due is rejected, no toISOString RangeError (cont.98 batch-20)', () => {
  it('a due beyond the ECMAScript Date range → null (would crash new Date(ms).toISOString())', () => {
    expect(dueDateFromRaw(8_640_000_000_000_001)).toBeNull(); // one ms past the max valid Date
    expect(dueDateFromRaw(Number.MAX_SAFE_INTEGER)).toBeNull();
    // the boundary itself is accepted (a valid instant) and never throws when formatted:
    const ok = dueDateFromRaw(8_640_000_000_000_000);
    expect(ok).toBe(8_640_000_000_000_000);
    expect(() => new Date(ok!).toISOString()).not.toThrow();
  });
  it('a normal due date is unchanged', () => {
    expect(dueDateFromRaw(1_760_000_000_000)).toBe(1_760_000_000_000);
  });
});

describe('dueMsToDateLabel — deterministic YYYY-MM-DD axis/badge label (cont.98 batch-58)', () => {
  it('formats an epoch-ms as a locale-free UTC YYYY-MM-DD string', () => {
    expect(dueMsToDateLabel(0)).toBe('1970-01-01'); // epoch, UTC — timezone-independent
    expect(dueMsToDateLabel(1_760_000_000_000)).toBe('2025-10-09');
    // exactly one UTC day later is exactly the next calendar day (no DST/tz drift):
    expect(dueMsToDateLabel(1_760_000_000_000 + DAY)).toBe('2025-10-10');
  });
  it('clamps an out-of-Date-range ms to the boundary instead of throwing RangeError', () => {
    const MAX = 8_640_000_000_000_000;
    expect(() => dueMsToDateLabel(MAX + 1e9)).not.toThrow();
    expect(dueMsToDateLabel(MAX + 1e9)).toBe(dueMsToDateLabel(MAX)); // clamped to the max instant
    expect(() => dueMsToDateLabel(-MAX - 1e9)).not.toThrow();
  });
});
