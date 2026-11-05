// packages/group/do-work/date-scale.test.ts
import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  parseFlexibleDate,
  niceDateTicks,
  formatDateTick,
  dateBucketKey,
  DAY_MS,
} from '../../../do-work/date-scale.ts';

describe('parseFlexibleDate', () => {
  it('parses ISO date strings as UTC', () => {
    expect(parseFlexibleDate('2026-03-15')).toBe(Date.UTC(2026, 2, 15));
    expect(parseFlexibleDate('2026-01-01T00:00:00Z')).toBe(Date.UTC(2026, 0, 1));
  });
  it('accepts ms and seconds timestamps', () => {
    const ms = Date.UTC(2026, 5, 1);
    expect(parseFlexibleDate(ms)).toBe(ms);
    expect(parseFlexibleDate(Math.floor(ms / 1000))).toBe(ms); // seconds → ms
  });
  it('accepts a Date instance', () => {
    expect(parseFlexibleDate(new Date(Date.UTC(2026, 0, 2)))).toBe(Date.UTC(2026, 0, 2));
  });
  it('fail-closed → null on garbage / empty / non-finite', () => {
    expect(parseFlexibleDate('not a date')).toBeNull();
    expect(parseFlexibleDate('')).toBeNull();
    expect(parseFlexibleDate(NaN)).toBeNull();
    expect(parseFlexibleDate({})).toBeNull();
    expect(parseFlexibleDate(undefined)).toBeNull();
  });
});

describe('niceDateTicks', () => {
  it('a ~week range → DAY-granularity ticks aligned to UTC midnight', () => {
    const min = Date.UTC(2026, 0, 1);
    const max = Date.UTC(2026, 0, 6);
    const ticks = niceDateTicks(min, max, 6);
    expect(ticks.every((t) => t.granularity === 'day')).toBe(true);
    expect(ticks.every((t) => t.ts % DAY_MS === 0)).toBe(true); // aligned
    expect(ticks[0].ts).toBe(min);
  });

  it('a multi-month range → MONTH ticks on the 1st (UTC)', () => {
    const ticks = niceDateTicks(Date.UTC(2026, 0, 10), Date.UTC(2026, 5, 20), 6);
    expect(ticks.every((t) => t.granularity === 'month')).toBe(true);
    expect(ticks.every((t) => new Date(t.ts).getUTCDate() === 1)).toBe(true);
  });

  it('a multi-year range → YEAR ticks on Jan 1', () => {
    const ticks = niceDateTicks(Date.UTC(2020, 3, 1), Date.UTC(2030, 8, 1), 6);
    expect(ticks.every((t) => t.granularity === 'year')).toBe(true);
    expect(ticks.every((t) => new Date(t.ts).getUTCMonth() === 0 && new Date(t.ts).getUTCDate() === 1)).toBe(true);
  });

  it('ticks span the range and are ascending', () => {
    const ticks = niceDateTicks(Date.UTC(2026, 0, 15), Date.UTC(2026, 3, 15), 5);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].ts).toBeGreaterThan(ticks[i - 1].ts);
  });

  it('degenerate / non-finite range never hangs', () => {
    expect(niceDateTicks(1000, 1000)).toHaveLength(1);
    expect(niceDateTicks(NaN, 5)).toEqual([]);
    expect(niceDateTicks(-Infinity, Infinity)).toEqual([]);
  });

  it('is deterministic', () => {
    const a = niceDateTicks(Date.UTC(2026, 0, 1), Date.UTC(2026, 2, 1));
    const b = niceDateTicks(Date.UTC(2026, 0, 1), Date.UTC(2026, 2, 1));
    expect(a).toEqual(b);
  });
});

describe('formatDateTick', () => {
  it('formats by granularity (UTC, stable)', () => {
    const ts = Date.UTC(2026, 2, 15);
    expect(formatDateTick(ts, 'day')).toBe('Mar 15');
    expect(formatDateTick(ts, 'month')).toBe('Mar 2026');
    expect(formatDateTick(ts, 'quarter')).toBe('Q1 2026');
    expect(formatDateTick(Date.UTC(2026, 8, 1), 'quarter')).toBe('Q3 2026');
    expect(formatDateTick(ts, 'year')).toBe('2026');
  });
  it('non-finite → empty string', () => {
    expect(formatDateTick(NaN, 'day')).toBe('');
  });
});

describe('dateBucketKey', () => {
  it('stable keys per granularity (UTC)', () => {
    const ts = Date.UTC(2026, 2, 15, 9, 30);
    expect(dateBucketKey(ts, 'day')).toBe('2026-03-15');
    expect(dateBucketKey(ts, 'month')).toBe('2026-03');
    expect(dateBucketKey(ts, 'quarter')).toBe('2026-Q1');
    expect(dateBucketKey(ts, 'year')).toBe('2026');
  });
  it('same day → same key regardless of time', () => {
    expect(dateBucketKey(Date.UTC(2026, 0, 5, 1), 'day')).toBe(dateBucketKey(Date.UTC(2026, 0, 5, 23), 'day'));
  });
});
