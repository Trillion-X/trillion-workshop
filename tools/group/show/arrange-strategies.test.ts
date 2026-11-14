import { describe, it, expect } from 'vitest';
import {
  ARRANGE_STRATEGIES,
  arrangeWith,
  type ArrangeStrategy,
  type Placed,
  type StrategyItem,
} from './arrange-strategies';

const sq = (memberId: string, w = 100, h = 100): StrategyItem => ({
  memberId,
  w,
  h,
});

const dist = (p: Placed, ox: number, oy: number): number =>
  Math.hypot(p.x - ox, p.y - oy);

describe('arrangeWith', () => {
  it('grid wraps at cols and places all n items', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((id) => sq(id));
    const out = arrangeWith('grid', items, { cols: 2, gap: 24 });
    expect(out).toHaveLength(5);
    // cell = (maxW+gap) x (maxH+gap) = 124 x 124
    // row-major with 2 cols: (0,0),(124,0),(0,124),(124,124),(0,248)
    expect(out[0]).toEqual({ memberId: 'a', x: 0, y: 0 });
    expect(out[1]).toEqual({ memberId: 'b', x: 124, y: 0 });
    expect(out[2]).toEqual({ memberId: 'c', x: 0, y: 124 });
    expect(out[3]).toEqual({ memberId: 'd', x: 124, y: 124 });
    expect(out[4]).toEqual({ memberId: 'e', x: 0, y: 248 });
    // every memberId is placed exactly once
    expect(new Set(out.map((p) => p.memberId)).size).toBe(5);
  });

  it('row is strictly monotonic in x with constant y', () => {
    const items = [sq('a', 50), sq('b', 80), sq('c', 30)];
    const out = arrangeWith('row', items, { gap: 24, originY: 7 });
    expect(out.map((p) => p.y)).toEqual([7, 7, 7]);
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i].x).toBeGreaterThan(out[i - 1].x);
    }
    // x advances by prior item.w + gap
    expect(out[0].x).toBe(0);
    expect(out[1].x).toBe(50 + 24);
    expect(out[2].x).toBe(50 + 24 + 80 + 24);
  });

  it('column is strictly monotonic in y with constant x', () => {
    const items = [sq('a', 100, 40), sq('b', 100, 90), sq('c', 100, 20)];
    const out = arrangeWith('column', items, { gap: 24, originX: 5 });
    expect(out.map((p) => p.x)).toEqual([5, 5, 5]);
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i].y).toBeGreaterThan(out[i - 1].y);
    }
    expect(out[0].y).toBe(0);
    expect(out[1].y).toBe(40 + 24);
    expect(out[2].y).toBe(40 + 24 + 90 + 24);
  });

  it('circle places distinct items each ~radius from the center', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => sq(id, 40, 40));
    const radius = 200;
    const originX = 500;
    const originY = 300;
    const out = arrangeWith('circle', items, { radius, originX, originY });
    expect(out).toHaveLength(6);
    // all placements distinct (no two items share the same slot)
    const keys = out.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`);
    expect(new Set(keys).size).toBe(6);
    // each item's CENTER is ~radius from the circle center
    for (const p of out) {
      const cx = p.x + 40 / 2;
      const cy = p.y + 40 / 2;
      expect(dist({ ...p, x: cx, y: cy }, originX, originY)).toBeCloseTo(
        radius,
        6,
      );
    }
  });

  it('masonry distributes across columns, shortest-first (3rd item lands under the 1st)', () => {
    // 2 cols. Item widths equal (colW uniform). Heights chosen so after placing
    // the first two (one per column), column 0 is the shorter -> 3rd item goes
    // into column 0, directly below item 0.
    const items = [
      sq('a', 100, 20), // -> col 0, y=0 ; col0 height becomes 20+gap
      sq('b', 100, 80), // -> col 1, y=0 ; col1 height becomes 80+gap
      sq('c', 100, 30), // -> shortest is col 0 -> under item 'a'
    ];
    const gap = 24;
    const out = arrangeWith('masonry', items, { cols: 2, gap });
    const a = out.find((p) => p.memberId === 'a')!;
    const b = out.find((p) => p.memberId === 'b')!;
    const c = out.find((p) => p.memberId === 'c')!;
    // a and b occupy different columns
    expect(a.x).not.toBe(b.x);
    // c lands in the same column as a (shortest), stacked below it
    expect(c.x).toBe(a.x);
    expect(c.y).toBe(a.y + 20 + gap);
    // and c is NOT in b's column
    expect(c.x).not.toBe(b.x);
  });

  it('spiral places item 0 at the centre and pushes later items monotonically outward (phyllotaxis)', () => {
    const items = Array.from({ length: 12 }, (_, i) => sq(`s${i}`, 80, 60));
    const out = arrangeWith('spiral', items, { originX: 0, originY: 0, gap: 24 });
    // item 0 sits at the centre (radius 0) → offset only by its own half-size.
    expect(out[0]).toEqual({ memberId: 's0', x: -40, y: -30 });
    // centre distance from the origin = c·√i, monotonically non-decreasing in the index.
    const dist = (p: { x: number; y: number }, it: { w: number; h: number }) => Math.hypot(p.x + it.w / 2, p.y + it.h / 2);
    for (let i = 1; i < out.length; i += 1) {
      expect(dist(out[i], items[i])).toBeGreaterThan(dist(out[i - 1], items[i - 1]) - 1e-9);
    }
    // strictly outward past the centre (item 4 is farther than item 1).
    expect(dist(out[4], items[4])).toBeGreaterThan(dist(out[1], items[1]));
    for (const p of out) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('spiral spreads items to DISTINCT positions (no two seeds coincide)', () => {
    const items = Array.from({ length: 10 }, (_, i) => sq(`d${i}`, 60, 60));
    const out = arrangeWith('spiral', items, { gap: 20 });
    const keys = new Set(out.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`));
    expect(keys.size).toBe(items.length);
  });

  it('pack shelves varied-width items into rows, wrapping below the tallest of the previous row', () => {
    // 6 items 80 wide → targetW ≈ √(padded area) ≈ 187, so two fit per row (80+10+80=170 ≤ 187) and the
    // third wraps to a new shelf whose top sits below the TALLEST item of the previous row (item b = 90).
    const items = [sq('a', 80, 40), sq('b', 80, 90), sq('c', 80, 30), sq('d', 80, 50), sq('e', 80, 60), sq('f', 80, 60)];
    const out = arrangeWith('pack', items, { gap: 10, originX: 0, originY: 0 });
    const at = (id: string) => out.find((p) => p.memberId === id)!;
    expect(at('a').y).toBe(at('b').y); // a and b share the first shelf (same top)
    expect(at('a').x).toBeLessThan(at('b').x); // packed left-to-right
    expect(at('c').y).toBeGreaterThan(at('a').y); // c wrapped to a new shelf below
    expect(at('c').y).toBe(at('a').y + 90 + 10); // shelf height = the TALLEST of row 1 (b=90) + gap
    expect(at('c').x).toBe(at('a').x); // new shelf restarts at the left origin
  });

  it('pack never places a row narrower than the widest single item (no orphan overflow)', () => {
    // one very wide item + small ones: the wide item still starts at the origin, nothing negative.
    const out = arrangeWith('pack', [sq('wide', 400, 60), sq('s1', 40, 40), sq('s2', 40, 40)], { gap: 12 });
    for (const p of out) { expect(Number.isFinite(p.x)).toBe(true); expect(p.x).toBeGreaterThanOrEqual(0); }
    expect(out.find((p) => p.memberId === 'wide')!.x).toBe(0);
  });

  it('concentric places item 0 at the centre and the rest on discrete rings (radius k·pitch)', () => {
    // 8 same-size items (w=h=80, gap=20 → pitch=100): item0 centre, items 1-6 on ring 1 (r≈100),
    // items 7-8 on ring 2 (r≈200) — capacity ⌊2π·1⌋=6 on ring 1.
    const items = Array.from({ length: 8 }, (_, i) => sq(`n${i}`, 80, 80));
    const out = arrangeWith('concentric', items, { gap: 20, originX: 0, originY: 0 });
    expect(out).toHaveLength(8);
    const radius = (p: { x: number; y: number }) => Math.hypot(p.x + 40, p.y + 40); // centre = topleft + w/2,h/2
    expect(radius(out[0])).toBeLessThan(1); // item 0 at the centre
    for (let i = 1; i <= 6; i += 1) expect(Math.abs(radius(out[i]) - 100)).toBeLessThan(1); // ring 1
    for (let i = 7; i <= 7; i += 1) expect(Math.abs(radius(out[i]) - 200)).toBeLessThan(1); // ring 2
    // all positions distinct
    expect(new Set(out.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)).size).toBe(8);
  });

  it('concentric with a single item places it at the centre', () => {
    const out = arrangeWith('concentric', [sq('solo', 60, 40)], { originX: 10, originY: 20 });
    expect(out).toEqual([{ memberId: 'solo', x: 10 - 30, y: 20 - 20 }]); // origin − half size
  });

  it('unknown strategyId returns []', () => {
    expect(arrangeWith('spiral-galaxy', [sq('a')])).toEqual([]);
  });

  it('empty items returns []', () => {
    for (const id of Object.keys(ARRANGE_STRATEGIES)) {
      expect(arrangeWith(id, [])).toEqual([]);
    }
    expect(arrangeWith('grid', [])).toEqual([]);
  });

  it('a custom injected strategy map adds a new id with zero change to arrangeWith', () => {
    // A brand-new "stack everything at the origin" strategy, supplied purely as
    // DATA via the injected map -- arrangeWith dispatches through it unchanged.
    const stackAtOrigin: ArrangeStrategy = (items, opts) =>
      items.map((it) => ({
        memberId: it.memberId,
        x: opts?.originX ?? 0,
        y: opts?.originY ?? 0,
      }));
    const customMap: Readonly<Record<string, ArrangeStrategy>> = {
      ...ARRANGE_STRATEGIES,
      stack: stackAtOrigin,
    };
    const items = [sq('a'), sq('b'), sq('c')];
    const out = arrangeWith('stack', items, { originX: 9, originY: 4 }, customMap);
    expect(out).toEqual([
      { memberId: 'a', x: 9, y: 4 },
      { memberId: 'b', x: 9, y: 4 },
      { memberId: 'c', x: 9, y: 4 },
    ]);
    // the new id exists ONLY in the injected map, not the default registry
    expect('stack' in ARRANGE_STRATEGIES).toBe(false);
    // and the default registry still dispatches normally through the same fn
    expect(arrangeWith('grid', items).length).toBe(3);
  });
});

describe('arrange-strategies red-team — untrusted strategy id + geometry (cont.98 batch-35)', () => {
  const items = [sq('a'), sq('b'), sq('c')];

  it('a prototype-key strategy id fails closed to [] (no crash, no inherited function call)', () => {
    for (const bad of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(arrangeWith(bad, items)).toEqual([]);
    }
    // a normal id still dispatches (zero regression)
    expect(arrangeWith('grid', items).length).toBe(3);
  });

  it('a NaN / MAX_VALUE item dimension yields finite positions across every strategy', () => {
    const hostile: StrategyItem[] = [
      { memberId: 'a', w: Number.NaN, h: 100 },
      { memberId: 'b', w: Number.MAX_VALUE, h: Number.NaN },
      { memberId: 'c', w: 100, h: Number.POSITIVE_INFINITY },
    ];
    for (const id of Object.keys(ARRANGE_STRATEGIES)) {
      for (const p of arrangeWith(id, hostile)) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
  });
});
