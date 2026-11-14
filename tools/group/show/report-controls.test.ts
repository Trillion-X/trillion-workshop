// packages/group/show/report-controls.test.ts
//
// Proves the report control model: the option catalogs mirror the b179 report DATA, relevance gating per
// reduction, descriptor building (only relevant fields kept), value formatting (pivot in measure units, else
// count), and that a built descriptor feeds reportRows to real grouped rows with card ids (the click target).

import { describe, it, expect } from 'vitest';
import type { BoardItem } from '../read-data/group-board-model';
import { reportRows } from '../read-data/board-report';
import {
  REDUCTION_OPTIONS, DIMENSION_OPTIONS, MEASURE_OPTIONS,
  reportControlRelevance, buildReportDescriptor, formatReportValue,
  controlsFromDescriptor, DEFAULT_REPORT_CONTROLS,
} from './report-controls';

const note = (memberId: string, tags: string[], progress: number): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, extra: { tags, metric: { current: progress * 10, target: 10 } } } as unknown as BoardItem);

describe('option catalogs', () => {
  it('mirror the b179 report catalogs (keys present)', () => {
    expect(REDUCTION_OPTIONS.map((o) => o.key)).toEqual(['census', 'pivot', 'histogram', 'crosstab']);
    expect(DIMENSION_OPTIONS.map((o) => o.key)).toContain('tag');
    expect(MEASURE_OPTIONS.map((o) => o.key)).toEqual(['progress', 'words', 'deadline']);
  });
});

describe('reportControlRelevance', () => {
  it('gates the right controls per reduction; unknown → dimension-only', () => {
    expect(reportControlRelevance('census')).toEqual({ dimension: true, measure: false, colDimension: false });
    expect(reportControlRelevance('pivot')).toEqual({ dimension: true, measure: true, colDimension: false });
    expect(reportControlRelevance('histogram')).toEqual({ dimension: false, measure: true, colDimension: false });
    expect(reportControlRelevance('crosstab')).toEqual({ dimension: true, measure: false, colDimension: true });
    expect(reportControlRelevance('mystery')).toEqual({ dimension: true, measure: false, colDimension: false });
  });
});

describe('buildReportDescriptor', () => {
  it('keeps only the fields the reduction uses', () => {
    expect(buildReportDescriptor('census', 'tag', 'progress')).toEqual({ reduction: 'census', dimension: 'tag' });
    expect(buildReportDescriptor('pivot', 'tag', 'progress')).toEqual({ reduction: 'pivot', dimension: 'tag', measure: 'progress' });
    expect(buildReportDescriptor('histogram', 'tag', 'words')).toEqual({ reduction: 'histogram', measure: 'words' });
    expect(buildReportDescriptor('crosstab', 'tag', 'x', 'kind')).toEqual({ reduction: 'crosstab', dimension: 'tag', colDimension: 'kind' });
  });
});

describe('formatReportValue', () => {
  it('pivot in measure units; other reductions as a count; null → em-dash', () => {
    expect(formatReportValue({ reduction: 'pivot', measure: 'progress' }, 0.5)).toBe('50%'); // percent
    expect(formatReportValue({ reduction: 'census', dimension: 'tag' }, 3)).toBe('3');        // count
    expect(formatReportValue({ reduction: 'census', dimension: 'tag' }, null)).toBe('—');
  });
});

describe('controlsFromDescriptor (inverse of buildReportDescriptor — re-open a saved report)', () => {
  it('restores the pickers from a descriptor; missing fields fall back to defaults', () => {
    expect(controlsFromDescriptor({ reduction: 'pivot', dimension: 'tag', measure: 'words' }))
      .toEqual({ reduction: 'pivot', dimension: 'tag', measure: 'words', colDimension: DEFAULT_REPORT_CONTROLS.colDimension });
  });
  it('round-trips: controls → descriptor → controls for the fields the reduction uses', () => {
    const desc = buildReportDescriptor('pivot', 'color', 'progress', 'kind');
    const back = controlsFromDescriptor(desc);
    // pivot uses reduction+dimension+measure (not colDimension) → those survive the round-trip
    expect(back.reduction).toBe('pivot');
    expect(back.dimension).toBe('color');
    expect(back.measure).toBe('progress');
  });
});

describe('descriptor → reportRows (the click target)', () => {
  it('a built census descriptor produces grouped rows with card ids', () => {
    const items = [note('a', ['work'], 0.9), note('b', ['work'], 0.2), note('c', ['home'], 0.5)];
    const rows = reportRows(items, buildReportDescriptor('census', 'tag'));
    const work = rows.find((r) => r.label === 'work');
    expect(work?.value).toBe(2);
    expect([...(work?.cardIds ?? [])].sort()).toEqual(['a', 'b']); // clicking this row selects a,b
  });
});
