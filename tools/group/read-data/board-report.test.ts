// packages/group/read-data/board-report.test.ts
//
// Proves b179's report descriptor: the DATA catalogs (measures/dimensions/reductions), and that runReport is a
// BLIND dispatcher — each reduction descriptor produces exactly what the underlying reducer's text helper
// produces (so the runner adds no behaviour, only selection), plus the never-designed-combination (deletion
// test) and the honest handling of bad keys.

import { describe, it, expect } from 'vitest';
import type { BoardItem } from './group-board-model';
import {
  runReport, reportRows, reportSelect, REDUCTIONS, reductionDefByKey, BOARD_MEASURES, measureDefById,
  BOARD_DIMENSIONS, dimensionDefById, PROGRESS_MEASURE, PROGRESS_BUCKETS,
} from './board-report';
import { facetCensusText } from './board-facet-census';
import { facetPivotText, aggregatorById } from './board-facet-pivot';
import { bucketDistributionText } from './board-measure-bucket';
import { crossTabText } from './board-crosstab';
import { itemTags } from '../show/item-tags';
import { kindFamilyOf } from '../show/board-item-facets';

const card = (memberId: string, kind: string, tags: string[], metric?: { current: number; target: number }): BoardItem =>
  ({ memberId, kind, x: 0, y: 0, w: 100, h: 40, text: 'a few words here', extra: { tags, ...(metric ? { metric } : {}) }, isSection: false } as unknown as BoardItem);

const board: BoardItem[] = [
  card('a', 'note', ['design'], { current: 8, target: 10 }),
  card('b', 'note', ['design'], { current: 4, target: 10 }),
  card('c', 'goal', ['urgent'], { current: 3, target: 10 }),
];

describe('DATA catalogs', () => {
  it('measures, dimensions, reductions are DATA rows with lookups', () => {
    expect(BOARD_MEASURES.map((m) => m.key)).toEqual(['progress', 'words', 'deadline']);
    expect(BOARD_DIMENSIONS.map((d) => d.key)).toEqual(['tag', 'color', 'kind', 'cluster', 'progress-band']);
    expect(REDUCTIONS.map((r) => r.key)).toEqual(['census', 'pivot', 'histogram', 'crosstab']);
    expect(measureDefById('progress')?.format(0.5)).toBe('50%');
    expect(measureDefById('nope')).toBeNull();
    expect(dimensionDefById('cluster')?.label).toBe('Cluster');
    expect(typeof dimensionDefById('cluster')?.extract(board)).toBe('function'); // topology dim precomputes
    expect(reductionDefByKey('pivot')?.label).toBe('Aggregate');
  });
});

describe('runReport — blind dispatch equals the underlying reducer', () => {
  it('census descriptor === facetCensusText over that dimension', () => {
    const out = runReport(board, { reduction: 'census', dimension: 'tag', title: 'Tag counts' });
    expect(out).toBe(facetCensusText(board, itemTags, 'Tag counts'));
    expect(out).toContain('design — 2 cards');
  });

  it('pivot descriptor === facetPivotText (measure × aggregator × format)', () => {
    const out = runReport(board, { reduction: 'pivot', dimension: 'tag', measure: 'progress', aggregator: 'mean', title: 'P' });
    expect(out).toBe(facetPivotText(board, itemTags, PROGRESS_MEASURE, aggregatorById('mean')!, 'P', measureDefById('progress')!.format));
    expect(out).toContain('design — 60% (2/2 cards)'); // mean(.8,.4)=.6
  });

  it('histogram descriptor === bucketDistributionText over the measure bands', () => {
    const out = runReport(board, { reduction: 'histogram', measure: 'progress', title: 'H' });
    expect(out).toBe(bucketDistributionText(board, PROGRESS_MEASURE, PROGRESS_BUCKETS, 'H'));
  });

  it('crosstab descriptor === crossTabText over two dimensions', () => {
    const out = runReport(board, { reduction: 'crosstab', dimension: 'kind', colDimension: 'tag', title: 'K×T' });
    expect(out).toBe(crossTabText(board, kindFamilyOf, itemTags, 'K×T'));
  });

  it('generates a heading when none is given', () => {
    expect(runReport(board, { reduction: 'census', dimension: 'kind' })).toContain('## Kind counts');
    expect(runReport(board, { reduction: 'pivot', dimension: 'tag', measure: 'progress' })).toContain('## Progress by tag (average)');
  });
});

describe('runReport — genericity + honesty', () => {
  it('a never-designed combination (crosstab cluster × kind, measure=words/max) runs with zero new code', () => {
    const out = runReport(board, { reduction: 'crosstab', dimension: 'kind', colDimension: 'tag', measure: 'words', aggregator: 'max' });
    expect(out).toContain('##'); // a real table, not an error note
    expect(out).not.toContain('_crosstab needs');
  });

  it('unknown keys return an honest note, never throw', () => {
    expect(runReport(board, { reduction: 'nope' })).toContain('_unknown reduction');
    expect(runReport(board, { reduction: 'census', dimension: 'ghost' })).toContain('_unknown dimension_');
    expect(runReport(board, { reduction: 'pivot', dimension: 'tag' })).toContain('_pivot needs');
    expect(runReport(board, { reduction: 'histogram', measure: 'deadline' })).toContain('_histogram needs a measure with bands_'); // deadline has no buckets
    expect(runReport(board, { reduction: 'crosstab', dimension: 'tag' })).toContain('_crosstab needs two dimensions_');
  });
});

describe('reportRows — the common structured shape', () => {
  it('census rows carry the group label, count, and cards', () => {
    const rows = reportRows(board, { reduction: 'census', dimension: 'tag' });
    expect(rows).toEqual([
      { label: 'design', value: 2, cardIds: ['a', 'b'] },
      { label: 'urgent', value: 1, cardIds: ['c'] },
    ]);
  });

  it('pivot rows carry the aggregate as value', () => {
    const rows = reportRows(board, { reduction: 'pivot', dimension: 'tag', measure: 'progress' });
    // design a=.8,b=.4 → mean .6 ; urgent c=.3
    expect(rows.find((r) => r.label === 'design')).toMatchObject({ value: 0.6000000000000001, cardIds: ['a', 'b'] });
    expect(rows.find((r) => r.label === 'urgent')?.value).toBe(0.3);
  });

  it('crosstab rows are one per cell, labelled row × col', () => {
    const rows = reportRows(board, { reduction: 'crosstab', dimension: 'kind', colDimension: 'tag' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.label.includes(' × design'))).toBe(true); // one cell per (kind × tag) pair
    expect(rows.every((r) => Array.isArray(r.cardIds) && typeof r.label === 'string')).toBe(true);
  });

  it('unknown/underspecified descriptor → []', () => {
    expect(reportRows(board, { reduction: 'nope' })).toEqual([]);
    expect(reportRows(board, { reduction: 'pivot', dimension: 'tag' })).toEqual([]); // missing measure
  });
});

describe('reportSelect — analysis → board selection', () => {
  it('selects the cards in the groups a predicate keeps (underperforming tags)', () => {
    // avg progress: design .6, urgent .3 → keep < 0.5 → urgent → card c
    const sel = reportSelect(board, { reduction: 'pivot', dimension: 'tag', measure: 'progress' }, (r) => r.value !== null && r.value < 0.5);
    expect(sel).toEqual(['c']);
  });

  it('a card in several kept groups is returned ONCE', () => {
    // a card with two tags lands in two census rows; keeping both must not duplicate it
    const multi = [
      card('m', 'note', ['x', 'y']),
      card('n', 'note', ['x']),
    ];
    const sel = reportSelect(multi, { reduction: 'census', dimension: 'tag' }, () => true);
    expect(sel.sort()).toEqual(['m', 'n']); // m once, despite being in both x and y
  });

  it('no group kept → empty selection', () => {
    expect(reportSelect(board, { reduction: 'census', dimension: 'tag' }, () => false)).toEqual([]);
  });
});
