// packages/group/do-work/attribute-consistency.test.ts
import { describe, it, expect } from 'vitest';
import {
  meanOf,
  stdDevOf,
  consistencyOf,
  analyzeRhythm,
  rhythmBand,
  sizeMeasureById,
  SIZE_MEASURES,
  type SizeRect,
} from './attribute-consistency';

const rect = (w: number, h: number): SizeRect => ({ x: 0, y: 0, w, h });

describe('meanOf / stdDevOf', () => {
  it('mean of a list; empty → 0', () => {
    expect(meanOf([2, 4, 6])).toBe(4);
    expect(meanOf([])).toBe(0);
  });
  it('population stddev; <2 → 0', () => {
    expect(stdDevOf([2, 4, 6])).toBeCloseTo(Math.sqrt((4 + 0 + 4) / 3), 5);
    expect(stdDevOf([5])).toBe(0);
    expect(stdDevOf([])).toBe(0);
  });
});

describe('consistencyOf', () => {
  it('identical values → perfectly consistent (1, cv 0)', () => {
    expect(consistencyOf([10, 10, 10])).toEqual({ consistency: 1, cv: 0 });
  });
  it('spread values → lower consistency', () => {
    const tight = consistencyOf([100, 105, 98, 102]);
    const wild = consistencyOf([10, 400, 30, 900]);
    expect(tight.consistency).toBeGreaterThan(wild.consistency);
    expect(tight.consistency).toBeGreaterThan(0.8);
  });
  it('bounded [0,1] even for extreme spread', () => {
    const r = consistencyOf([1, 100000]);
    expect(r.consistency).toBeGreaterThanOrEqual(0);
    expect(r.consistency).toBeLessThanOrEqual(1);
  });
  it('single / empty / non-positive mean → 1', () => {
    expect(consistencyOf([42]).consistency).toBe(1);
    expect(consistencyOf([]).consistency).toBe(1);
    expect(consistencyOf([0, 0]).consistency).toBe(1);
  });
});

describe('analyzeRhythm', () => {
  const uniform: SizeRect[] = [rect(100, 60), rect(100, 60), rect(100, 60), rect(100, 60)];
  const jumbled: SizeRect[] = [rect(40, 30), rect(300, 200), rect(80, 400), rect(500, 20)];

  it('a uniform-size board scores near-perfect on every measure', () => {
    const r = analyzeRhythm(uniform);
    for (const m of r.measures) expect(m.consistency).toBeCloseTo(1, 5);
    expect(r.overall).toBeCloseTo(1, 5);
  });
  it('scores a uniform board far higher than a jumbled one', () => {
    expect(analyzeRhythm(uniform).overall).toBeGreaterThan(analyzeRhythm(jumbled).overall);
    expect(analyzeRhythm(jumbled).overall).toBeLessThan(0.6);
  });
  it('every measure bounded [0,1] and overall is their mean', () => {
    const r = analyzeRhythm(jumbled);
    for (const m of r.measures) {
      expect(m.consistency).toBeGreaterThanOrEqual(0);
      expect(m.consistency).toBeLessThanOrEqual(1);
    }
    const mean = r.measures.reduce((s, m) => s + m.consistency, 0) / r.measures.length;
    expect(r.overall).toBeCloseTo(mean, 5);
  });
  it('catches a board uniform in width but wild in height', () => {
    const r = analyzeRhythm([rect(100, 20), rect(100, 300), rect(100, 40)]);
    const width = r.measures.find((m) => m.id === 'width')!;
    const height = r.measures.find((m) => m.id === 'height')!;
    expect(width.consistency).toBeCloseTo(1, 5);
    expect(height.consistency).toBeLessThan(width.consistency);
  });
  it('0 or 1 card is trivially consistent (overall 1)', () => {
    expect(analyzeRhythm([]).overall).toBe(1);
    expect(analyzeRhythm([rect(123, 45)]).overall).toBe(1);
  });
  it('is deterministic', () => {
    expect(analyzeRhythm(jumbled)).toEqual(analyzeRhythm(jumbled));
  });
  it('honours a custom measure catalog', () => {
    const only = [SIZE_MEASURES[1]]; // width
    const r = analyzeRhythm(uniform, only);
    expect(r.measures).toHaveLength(1);
    expect(r.measures[0].id).toBe('width');
    expect(r.overall).toBeCloseTo(r.measures[0].consistency, 5);
  });
  it('non-finite dimensions never produce NaN', () => {
    const r = analyzeRhythm([rect(100, 60), { x: 0, y: 0, w: NaN, h: Infinity }]);
    expect(Number.isFinite(r.overall)).toBe(true);
    for (const m of r.measures) expect(Number.isFinite(m.consistency)).toBe(true);
  });
});

describe('catalog + band', () => {
  it('sizeMeasureById falls back to the first for unknown/undefined', () => {
    expect(sizeMeasureById(undefined).id).toBe('area');
    expect(sizeMeasureById('nope').id).toBe('area');
    expect(sizeMeasureById('aspect').id).toBe('aspect');
  });
  it('rhythmBand green/amber/red words', () => {
    expect(rhythmBand(0.9).label).toBe('Consistent sizes');
    expect(rhythmBand(0.6).label).toBe('Somewhat mixed');
    expect(rhythmBand(0.3).label).toBe('Mixed sizes');
  });
});
