import { describe, expect, it } from 'vitest';
import {
  mulberry32,
  hashSeed,
  roughenPolyline,
  strokePathD,
  STROKE_STYLES,
  strokeStyleById,
  resolveStroke,
  arrowheadPoints,
  type Point,
} from './stroke-style';

const P = (x: number, y: number): Point => ({ x, y });
const LINE: Point[] = [P(0, 0), P(100, 0)];

describe('stroke-style (sketch primitive — roughness is a generative DATA axis)', () => {
  describe('deterministic PRNG', () => {
    it('mulberry32 is deterministic and stays in [0,1)', () => {
      const a = mulberry32(123);
      const b = mulberry32(123);
      for (let i = 0; i < 20; i += 1) {
        const v = a();
        expect(v).toBe(b());
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    });
    it('hashSeed is stable and differs per id (each line gets its own wobble)', () => {
      expect(hashSeed('c1')).toBe(hashSeed('c1'));
      expect(hashSeed('c1')).not.toBe(hashSeed('c2'));
    });
  });

  describe('roughenPolyline', () => {
    it('roughness 0 → identity (crisp lines never change — zero regression)', () => {
      expect(roughenPolyline(LINE, 0, 1, mulberry32(1))).toEqual(LINE);
    });
    it('keeps BOTH endpoints EXACT so a rough connector still touches its nodes', () => {
      const knots = roughenPolyline(LINE, 4, 1, mulberry32(7));
      expect(knots[0]).toEqual(P(0, 0));
      expect(knots[knots.length - 1]).toEqual(P(100, 0));
    });
    it('perturbs the interior within ~roughness of the straight line (bounded, not wild)', () => {
      const knots = roughenPolyline(LINE, 3, 1, mulberry32(9));
      for (const k of knots) expect(Math.abs(k.y)).toBeLessThanOrEqual(3 + 0.01); // y=0 line, jitter ≤ roughness
    });
    it('a higher roughness bows the line further from straight', () => {
      const mid = (r: number) => Math.abs(roughenPolyline(LINE, r, 1, mulberry32(4))[1].y);
      // the midpoint bow scales with roughness (same seed → same random draw)
      expect(mid(6)).toBeGreaterThan(mid(1));
    });
  });

  describe('strokePathD', () => {
    it('roughness 0 → a single crisp polyline path (M …L …)', () => {
      const d = strokePathD(LINE, { roughness: 0 }, 1);
      expect(d).toHaveLength(1);
      expect(d[0]).toBe('M 0 0 L 100 0');
    });
    it('roughness > 0 → smooth quadratic path(s); doubleStroke yields TWO layered strokes', () => {
      const d = strokePathD(LINE, { roughness: 2, doubleStroke: true }, hashSeed('c1'));
      expect(d).toHaveLength(2);
      for (const path of d) {
        expect(path.startsWith('M ')).toBe(true);
        expect(path).toContain('Q'); // quadratic bows
      }
      expect(d[0]).not.toBe(d[1]); // the two layers are decorrelated (the pencil look)
    });
    it('is deterministic for a given seed (no re-render jitter)', () => {
      const a = strokePathD(LINE, { roughness: 3 }, 42);
      const b = strokePathD(LINE, { roughness: 3 }, 42);
      expect(a).toEqual(b);
    });
    it('different seeds → different wobble (each line unique)', () => {
      const a = strokePathD(LINE, { roughness: 3 }, 1);
      const b = strokePathD(LINE, { roughness: 3 }, 2);
      expect(a).not.toEqual(b);
    });
    it('handles a multi-vertex polyline (a border rectangle) and keeps its corners anchored', () => {
      const rect: Point[] = [P(0, 0), P(100, 0), P(100, 60), P(0, 60), P(0, 0)];
      const d = strokePathD(rect, { roughness: 2 }, 5);
      expect(d[0].startsWith('M 0 0')).toBe(true);
    });
  });

  describe('STROKE_STYLES catalog (a new brushstroke is ONE row — deletion test)', () => {
    it('every style has a unique id, label, and numeric roughness', () => {
      const ids = STROKE_STYLES.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const s of STROKE_STYLES) {
        expect(s.label.length).toBeGreaterThan(0);
        expect(typeof s.roughness).toBe('number');
      }
    });
    it('crisp styles (solid/dashed/dotted) carry roughness 0; sketch styles carry roughness > 0', () => {
      expect(strokeStyleById('solid').roughness).toBe(0);
      expect(strokeStyleById('dashed').dash).toBeTruthy();
      expect(strokeStyleById('pencil').roughness).toBeGreaterThan(0);
      expect(strokeStyleById('sketch').roughness).toBeGreaterThan(strokeStyleById('pencil').roughness);
    });
    it('strokeStyleById resolves known / unknown / undefined', () => {
      expect(strokeStyleById('marker').id).toBe('marker');
      expect(strokeStyleById('nope')).toBe(STROKE_STYLES[0]);
      expect(strokeStyleById(undefined)).toBe(STROKE_STYLES[0]);
    });
    it('a DROPPED-IN style DATA the catalog never named still renders (the primitive is blind)', () => {
      const invented = { id: 'wavy', label: 'Wavy', roughness: 5, bowing: 2.5 };
      const d = strokePathD(LINE, { roughness: invented.roughness, bowing: invented.bowing }, hashSeed(invented.id));
      expect(d[0]).toContain('Q'); // works with zero engine change
    });
  });

  describe('resolveStroke — named brushstroke + raw overrides → {roughness, bowing, dash} (the SSOT)', () => {
    it('a named style supplies ALL THREE axes — pencil/marker/sketch are now distinguishable', () => {
      // The bug this fixes: renderers ignored bowing, so these looked alike. The resolver flows bowing.
      const pencil = resolveStroke('pencil');
      const marker = resolveStroke('marker');
      const sketch = resolveStroke('sketch');
      expect(pencil.roughness).toBe(strokeStyleById('pencil').roughness);
      expect(marker.bowing).toBe(strokeStyleById('marker').bowing); // 0.5 — flatter than pencil
      expect(sketch.bowing).toBeGreaterThan(pencil.bowing); // 1.4 > 1 — sketch bows more
      expect(marker.bowing).toBeLessThan(pencil.bowing); // 0.5 < 1 — marker bows less
    });
    it('dashed/dotted styles carry a dash; solid/pencil do not', () => {
      expect(resolveStroke('dashed').dash).toBeTruthy();
      expect(resolveStroke('dotted').dash).toBeTruthy();
      expect(resolveStroke('solid').dash).toBeUndefined();
      expect(resolveStroke('pencil').dash).toBeUndefined();
    });
    it('a positive raw override wins per-axis; a dashed override forces a dash over a solid style', () => {
      const r = resolveStroke('pencil', 4, 0, true); // raw roughness 4, raw bowing 0 (straight), forced dash
      expect(r.roughness).toBe(4); // raw wins over pencil 1.6
      expect(r.bowing).toBe(0); // raw 0 (>= 0) wins → straight-but-jittered
      expect(r.dash).toBe('7 5'); // dashed override over pencil's undefined dash
    });
    it('an unknown/absent style → crisp solid, so an un-themed line is byte-identical', () => {
      expect(resolveStroke(undefined)).toEqual({ roughness: 0, bowing: 1, dash: undefined });
      expect(resolveStroke('nope')).toEqual({ roughness: 0, bowing: 1, dash: undefined });
    });
  });

  describe('arrowheadPoints — the open hand-drawn arrowhead V (a rough arrow head, not a crisp triangle)', () => {
    it('returns [barbA, tip, barbB] with the tip in the middle, barbs behind it, symmetric about the axis', () => {
      const pts = arrowheadPoints(P(100, 0), P(0, 0), 12, 0.55);
      expect(pts.length).toBe(3);
      expect(pts[1]).toEqual({ x: 100, y: 0 }); // the tip is the middle knot
      expect(pts[0].x).toBeLessThan(100); // barbs sit BEHIND the tip
      expect(pts[2].x).toBeLessThan(100);
      expect(pts[0].y).toBeCloseTo(-pts[2].y); // symmetric across the line axis
    });
    it('is empty for a degenerate direction (from == tip) — nothing to draw', () => {
      expect(arrowheadPoints(P(5, 5), P(5, 5))).toEqual([]);
    });
    it('a bigger size pushes the barbs further back from the tip', () => {
      const small = arrowheadPoints(P(100, 0), P(0, 0), 8);
      const large = arrowheadPoints(P(100, 0), P(0, 0), 20);
      expect(large[0].x).toBeLessThan(small[0].x);
    });
    it('feeds strokePathD → a hand-drawn (bowed Q) head when roughness is set', () => {
      const head = arrowheadPoints(P(100, 0), P(0, 0));
      expect(strokePathD(head, { roughness: 2 }, hashSeed('e'))[0]).toContain('Q');
    });
  });
});

describe('stroke-style red-team — untrusted amplitudes/points never emit a non-finite path (cont.98 batch-34)', () => {
  const finitePath = (d: string) => !/NaN|Infinity/.test(d);

  it('a MAX_VALUE / NaN roughness or bowing still yields a finite SVG `d` (clamped, never "Infinity")', () => {
    for (const bad of [Number.MAX_VALUE, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const d of strokePathD(LINE, { roughness: bad, bowing: bad }, hashSeed('x'))) {
        expect(finitePath(d)).toBe(true);
      }
    }
  });

  it('a MAX_VALUE point coordinate is clamped in the crisp path (roughness 0, no jitter)', () => {
    const [d] = strokePathD([P(0, 0), P(Number.MAX_VALUE, Number.NEGATIVE_INFINITY)], {}, 0);
    expect(finitePath(d)).toBe(true);
  });

  it('resolveStroke caps a hostile raw override to MAX_AMPLITUDE and drops NaN to the catalog default', () => {
    const capped = resolveStroke('pencil', Number.MAX_VALUE, Number.MAX_VALUE);
    expect(Number.isFinite(capped.roughness)).toBe(true);
    expect(capped.roughness).toBeLessThanOrEqual(1000);
    expect(capped.bowing).toBeLessThanOrEqual(1000);
    // NaN raw → falls through to the trusted 'pencil' catalog values (roughness 1.6, bowing 1).
    const nanRaw = resolveStroke('pencil', Number.NaN, Number.NaN);
    expect(nanRaw.roughness).toBe(1.6);
    expect(nanRaw.bowing).toBe(1);
  });
});
