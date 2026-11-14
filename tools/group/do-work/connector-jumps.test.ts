// Proof for connector crossing jumps: only HORIZONTAL segments hop over VERTICAL crossers (single-sided),
// the hop is an arc (A command) bulging up, the path stays anchored at its endpoints, crossers outside the
// segment interior or merely touching an endpoint do not trigger a hop, and the radius clamps when tight.
import { describe, expect, it } from 'vitest';
import { pointsFromLinePath, verticalSegments, pathWithJumps, type Seg } from 'trillion-workshop/tools/organize-the-sidebar/do-work/connector-jumps.ts';
import type { Pt } from './connector-geometry';

const P = (x: number, y: number): Pt => ({ x, y });
const vseg = (x: number, y0: number, y1: number): Seg => ({ a: P(x, y0), b: P(x, y1) });
const arcs = (d: string) => (d.match(/ A /g) ?? []).length;

describe('connector-jumps — pointsFromLinePath', () => {
  it('parses an M/L polyline into points', () => {
    expect(pointsFromLinePath('M 0 0 L 10 0 L 10 10')).toEqual([P(0, 0), P(10, 0), P(10, 10)]);
  });
  it('returns [] for a curved (or already-arced) path — jumps only apply to plain polylines', () => {
    expect(pointsFromLinePath('M 0 0 Q 5 5 10 0')).toEqual([]);
    expect(pointsFromLinePath('M 0 0 L 5 0 A 3 3 0 0 0 11 0 L 20 0')).toEqual([]);
  });
});

describe('connector-jumps — verticalSegments', () => {
  it('keeps only the vertical segments of a polyline', () => {
    const pts = [P(0, 0), P(10, 0), P(10, 10), P(20, 10)]; // H, V, H
    expect(verticalSegments(pts)).toEqual([{ a: P(10, 0), b: P(10, 10) }]);
  });
});

describe('connector-jumps — pathWithJumps', () => {
  it('leaves a straight horizontal segment untouched when nothing crosses it', () => {
    const d = pathWithJumps([P(0, 50), P(100, 50)], []);
    expect(arcs(d)).toBe(0);
    expect(d).toBe('M 0 50 L 100 50');
  });

  it('hops a horizontal segment over one vertical crosser (an arc appears; endpoints preserved)', () => {
    const d = pathWithJumps([P(0, 50), P(100, 50)], [vseg(50, 0, 100)], 6);
    expect(arcs(d)).toBe(1);
    expect(d.startsWith('M 0 50')).toBe(true);
    expect(d.endsWith('L 100 50')).toBe(true);
    // approaches the crossing from the left (44) and resumes on the right (56), arc between.
    expect(d).toContain('L 44 50');
    expect(d).toContain('A 6 6 0 0 0 56 50');
  });

  it('a VERTICAL segment never hops (single-sided rule): a horizontal crosser triggers nothing', () => {
    // path is vertical x=50 y0..100; crosser is a horizontal-looking seg — but crossers are only vertical,
    // so model the symmetric case: a vertical path can't hop, so no arc regardless.
    const d = pathWithJumps([P(50, 0), P(50, 100)], [vseg(50, 40, 60)]);
    expect(arcs(d)).toBe(0);
  });

  it('does not hop when the crosser is outside the segment span or only touches an endpoint', () => {
    expect(arcs(pathWithJumps([P(0, 50), P(100, 50)], [vseg(150, 0, 100)]))).toBe(0); // x outside
    expect(arcs(pathWithJumps([P(0, 50), P(100, 50)], [vseg(50, 60, 100)]))).toBe(0); // y-range below the line
    expect(arcs(pathWithJumps([P(0, 50), P(100, 50)], [vseg(0, 0, 100)]))).toBe(0); // x at the start endpoint
  });

  it('hops over MANY crossers on one segment, in travel order', () => {
    const d = pathWithJumps([P(0, 50), P(300, 50)], [vseg(100, 0, 100), vseg(200, 0, 100)], 6);
    expect(arcs(d)).toBe(2);
    expect(d.indexOf('L 94 50')).toBeLessThan(d.indexOf('L 194 50')); // first hop before the second
  });

  it('clamps the radius so two close crossings never overlap their arcs', () => {
    // crossers 8px apart with radius 6 → clamped to 4 each (half the gap), no overshoot.
    const d = pathWithJumps([P(0, 50), P(100, 50)], [vseg(48, 0, 100), vseg(56, 0, 100)], 6);
    expect(arcs(d)).toBe(2);
    expect(d).toContain('A 4 4 0 0 0'); // clamped radius
  });

  it('hops correctly on a right-to-left horizontal segment (sweep flips to still bulge up)', () => {
    const d = pathWithJumps([P(100, 50), P(0, 50)], [vseg(50, 0, 100)], 6);
    expect(arcs(d)).toBe(1);
    expect(d).toContain('A 6 6 0 0 1 44 50'); // leftward → sweep 1, ends at 50-6=44
  });
});
