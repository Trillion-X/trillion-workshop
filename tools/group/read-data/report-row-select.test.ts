// packages/group/read-data/report-row-select.test.ts
//
// Proves the DATA-driven bulk selectors over report rows (report-row-select.ts): the data-derived threshold
// (mean of the measured values) drives above/below-average; "highest" is the single strongest measured group;
// "unmeasured" is the null-value groups; and `reportRowSelection` unions the kept rows' card ids (deduped). Uses
// hand-authored ReportRow[] so the math is readable and independent of the reduction that produced them.

import { describe, it, expect } from 'vitest';
import type { ReportRow } from './board-report';
import {
  ROW_SELECTORS,
  measuredMean,
  rowSelectorById,
  reportRowSelection,
} from 'trillion-workshop/tools/organize-the-sidebar/read-data/report-row-select.ts';

// Rows as a reduction would emit them (pre-sorted most-first), with one unmeasured group.
const rows: ReportRow[] = [
  { label: 'design', value: 0.9, cardIds: ['a', 'b'] },
  { label: 'urgent', value: 0.6, cardIds: ['b', 'c'] }, // shares b with design
  { label: 'idea', value: 0.3, cardIds: ['d'] },
  { label: 'someday', value: null, cardIds: ['e'] },    // carries the dimension, not the measure
];
// mean of measured = (0.9 + 0.6 + 0.3) / 3 = 0.6

describe('report-row-select — DATA-driven bulk selectors', () => {
  it('measuredMean averages only the non-null values (null when none)', () => {
    expect(measuredMean(rows)).toBeCloseTo(0.6, 10);
    expect(measuredMean([{ label: 'x', value: null, cardIds: [] }])).toBeNull();
    expect(measuredMean([])).toBeNull();
  });

  it('highest = the single strongest measured group', () => {
    expect(reportRowSelection(rows, 'highest')).toEqual(['a', 'b']); // design (0.9)
  });

  it('highest is the TRUE max by value even when rows are NOT sorted desc (histogram bucket order)', () => {
    // A histogram arrives in bucket order with a zero-filled first bucket — the max is the LAST row here.
    const histogram: ReportRow[] = [
      { label: '≤10 words', value: 0, cardIds: [] },
      { label: '10–40', value: 2, cardIds: ['a', 'b'] },
      { label: '100+ words', value: 5, cardIds: ['c', 'd', 'e', 'f', 'g'] },
    ];
    expect(reportRowSelection(histogram, 'highest')).toEqual(['c', 'd', 'e', 'f', 'g']); // the 100+ bucket, not the first
  });

  it('above-average keeps groups at or above the mean (0.6), deduping shared cards', () => {
    // design(0.9) + urgent(0.6) → a,b (design) ∪ b,c (urgent) = a,b,c (b once, first-seen order)
    expect(reportRowSelection(rows, 'above-avg')).toEqual(['a', 'b', 'c']);
  });

  it('below-average keeps only groups strictly under the mean', () => {
    expect(reportRowSelection(rows, 'below-avg')).toEqual(['d']); // idea (0.3)
  });

  it('unmeasured keeps the null-value groups', () => {
    expect(reportRowSelection(rows, 'unmeasured')).toEqual(['e']); // someday
  });

  it('all selectors return [] when there is nothing to average / an unknown id', () => {
    const allNull: ReportRow[] = [{ label: 'x', value: null, cardIds: ['z'] }];
    expect(reportRowSelection(allNull, 'above-avg')).toEqual([]); // no mean → nothing above it
    expect(reportRowSelection(allNull, 'below-avg')).toEqual([]);
    expect(reportRowSelection(allNull, 'highest')).toEqual([]);   // no measured group
    expect(reportRowSelection(rows, 'no-such-selector')).toEqual([]);
    expect(rowSelectorById('no-such-selector')).toBeNull();
  });

  it('the catalog is the SSOT the UI folds — stable ids + labels', () => {
    expect(ROW_SELECTORS.map((s) => s.id)).toEqual(['highest', 'above-avg', 'below-avg', 'unmeasured']);
    expect(ROW_SELECTORS.every((s) => typeof s.label === 'string' && s.label.length > 0)).toBe(true);
  });
});
