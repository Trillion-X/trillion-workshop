// Proof for rounded connector corners: a straight 2-point line is untouched, each interior corner of an
// orthogonal polyline becomes a quadratic fillet (approach L + Q through the vertex), the radius clamps to
// half the shorter incident segment, a multi-corner route rounds every corner, and endpoints are preserved.
import { describe, expect, it } from 'vitest';
import { roundedPolyline } from 'trillion-workshop/tools/organize-the-sidebar/do-work/connector-corners.ts';
import type { Pt } from './connector-geometry';

const P = (x: number, y: number): Pt => ({ x, y });
const qCount = (d: string) => (d.match(/ Q /g) ?? []).length;

describe('connector-corners — roundedPolyline', () => {
  it('leaves a straight 2-point line as a plain M…L (no fillet)', () => {
    expect(roundedPolyline([P(0, 0), P(100, 0)], 10)).toBe('M 0 0 L 100 0');
    expect(qCount(roundedPolyline([P(0, 0), P(100, 0)], 10))).toBe(0);
  });

  it('rounds a single L-corner into one quadratic through the vertex', () => {
    // horizontal then vertical, corner at (100,0); radius 10 fits (both legs are 100).
    const d = roundedPolyline([P(0, 0), P(100, 0), P(100, 100)], 10);
    expect(qCount(d)).toBe(1);
    expect(d.startsWith('M 0 0')).toBe(true);
    expect(d.endsWith('L 100 100')).toBe(true);
    // approach 10 before the corner along the incoming leg, depart 10 after along the outgoing leg.
    expect(d).toContain('L 90 0 Q 100 0 100 10');
  });

  it('clamps the radius to half the shorter incident segment', () => {
    // the outgoing leg is only 12 long → radius clamps to 6 (half of 12), not 10.
    const d = roundedPolyline([P(0, 0), P(100, 0), P(100, 12)], 10);
    expect(d).toContain('L 94 0 Q 100 0 100 6'); // approach 6 before, depart 6 after
  });

  it('rounds EVERY interior corner of a U-route (two corners → two quadratics)', () => {
    const d = roundedPolyline([P(0, 0), P(100, 0), P(100, 100), P(0, 100)], 10);
    expect(qCount(d)).toBe(2);
    expect(d.startsWith('M 0 0')).toBe(true);
    expect(d.endsWith('L 0 100')).toBe(true);
  });

  it('passes a zero-length incident segment straight through (no degenerate arc)', () => {
    const d = roundedPolyline([P(0, 0), P(100, 0), P(100, 0), P(100, 100)], 10);
    // the middle vertex has a zero-length incoming leg → r clamps to 0 → plain L, no extra Q there.
    expect(qCount(d)).toBeLessThanOrEqual(1);
  });
});
