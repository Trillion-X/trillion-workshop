// Proof for the Catmull-Rom spline: it emits one cubic per segment, INTERPOLATES every point (the curve
// passes through each bend, not just near it), a 2-point chain is one cubic whose controls sit on the
// chord (visually straight), and degenerate 0/1-point chains are safe.
import { describe, expect, it } from 'vitest';
import { catmullRomPath } from './catmull-rom';
import type { Pt } from './connector-geometry';

const P = (x: number, y: number): Pt => ({ x, y });
const cubics = (d: string) => (d.match(/ C /g) ?? []).length;

describe('catmull-rom — catmullRomPath', () => {
  it('is safe for empty / single-point chains', () => {
    expect(catmullRomPath([])).toBe('');
    expect(catmullRomPath([P(3, 4)])).toBe('M 3 4');
  });

  it('a 2-point chain is one cubic starting/ending at the endpoints', () => {
    const d = catmullRomPath([P(0, 0), P(60, 0)]);
    expect(cubics(d)).toBe(1);
    expect(d.startsWith('M 0 0')).toBe(true);
    expect(d.trim().endsWith('60 0')).toBe(true);
  });

  it('a 2-point chain is visually straight (both controls lie on the chord)', () => {
    // horizontal chord y=0 → every control y must be 0.
    const d = catmullRomPath([P(0, 0), P(60, 0)]);
    const t = d.trim().split(/\s+/); // M 0 0 C c1x c1y c2x c2y 60 0
    expect(Number(t[5])).toBe(0); // c1y
    expect(Number(t[7])).toBe(0); // c2y
  });

  it('interpolates every bend: a 3-point chain is two cubics whose join IS the middle point', () => {
    const d = catmullRomPath([P(0, 0), P(50, 40), P(100, 0)]);
    expect(cubics(d)).toBe(2);
    // the first cubic ends exactly at the middle point (Catmull-Rom passes through it).
    expect(d).toContain(' 50 40 C '); // segment 1 ends at (50,40), segment 2 begins
    expect(d.trim().endsWith('100 0')).toBe(true);
  });

  it('emits exactly (n-1) cubics for an n-point chain', () => {
    const pts = [P(0, 0), P(20, 30), P(40, -10), P(60, 20), P(80, 0)];
    expect(cubics(catmullRomPath(pts))).toBe(pts.length - 1);
  });
});
