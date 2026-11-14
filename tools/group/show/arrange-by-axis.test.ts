// Proof for the CONTINUOUS-scale placement primitive (R8 emergent — the continuous sibling of
// arrange-by-field's discrete clusters). Pins: (a) the linear scale is correct and monotonic, (b)
// 1-D timeline mode (constant lane Y, X ordered by value), (c) 2-D scatter mode with invertY
// (larger value sits HIGHER), (d) fail-closed geometry — null/NaN/degenerate never yield a NaN
// coordinate and park in the no-value pile, (e) the "nice" axisTicks ladder + monotonic positions.

import { describe, expect, it } from 'vitest';
import { arrangeByAxis, axisTicks, axisTickLabels, arrangeTimelineLanes, type AxisItem } from './arrange-by-axis';

const box = (id: string, valueX: number | null, valueY?: number | null): AxisItem => ({
  memberId: id,
  w: 100,
  h: 40,
  valueX,
  ...(valueY === undefined ? {} : { valueY }),
});

const centreX = (p: { x: number }): number => p.x + 50; // + w/2
const centreY = (p: { y: number }): number => p.y + 20; // + h/2

describe('arrangeByAxis — 1-D timeline / number-line', () => {
  const items = [box('a', 0), box('b', 50), box('c', 100)];

  it('maps value→pixel linearly across the span, boxes centred on their value', () => {
    const placed = arrangeByAxis(items, { originX: 0, spanX: 1000, laneY: 300 });
    const by = Object.fromEntries(placed.map((p) => [p.memberId, p]));
    expect(centreX(by.a)).toBeCloseTo(0, 6); // min → origin
    expect(centreX(by.b)).toBeCloseTo(500, 6); // midpoint → half the span
    expect(centreX(by.c)).toBeCloseTo(1000, 6); // max → full span
  });

  it('every item sits on the fixed lane Y (a horizontal timeline), all onAxis', () => {
    const placed = arrangeByAxis(items, { spanX: 1000, laneY: 300 });
    for (const p of placed) {
      expect(centreY(p)).toBeCloseTo(300, 6);
      expect(p.onAxis).toBe(true);
    }
  });

  it('X position is strictly monotonic in the value (a real ordering, not a pile)', () => {
    const placed = arrangeByAxis(items, { spanX: 1000 });
    const xs = ['a', 'b', 'c'].map((id) => placed.find((p) => p.memberId === id)!.x);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
  });
});

describe('arrangeByAxis — 2-D scatter with invertY', () => {
  // A Y value present on any item switches the DATA-decided mode to scatter (L090 — no flag).
  const items = [box('lo', 0, 0), box('hi', 100, 100)];

  it('larger Y value sits HIGHER on screen (smaller y) when invertY (default)', () => {
    const placed = arrangeByAxis(items, { originY: 0, spanY: 400 });
    const lo = placed.find((p) => p.memberId === 'lo')!;
    const hi = placed.find((p) => p.memberId === 'hi')!;
    expect(centreY(hi)).toBeLessThan(centreY(lo)); // hi value → top
    expect(centreY(hi)).toBeCloseTo(0, 6); // max Y → origin (top)
    expect(centreY(lo)).toBeCloseTo(400, 6); // min Y → bottom of the span
  });

  it('invertY:false keeps screen-natural mapping (larger value = lower)', () => {
    const placed = arrangeByAxis(items, { spanY: 400, invertY: false });
    const lo = placed.find((p) => p.memberId === 'lo')!;
    const hi = placed.find((p) => p.memberId === 'hi')!;
    expect(centreY(hi)).toBeGreaterThan(centreY(lo));
  });

  it('X and Y both scale independently (a true plane)', () => {
    const placed = arrangeByAxis([box('p', 25, 75)], { spanX: 400, spanY: 400, domainX: { min: 0, max: 100 }, domainY: { min: 0, max: 100 } });
    const p = placed[0];
    expect(centreX(p)).toBeCloseTo(100, 6); // 25% of 400
    expect(centreY(p)).toBeCloseTo(100, 6); // 75% of 400, inverted → 25% from top
  });
});

describe('arrangeByAxis — fail-closed (SP5): never NaN, nothing dropped', () => {
  it('null / NaN X values park in the no-value pile (onAxis:false), keeping their box', () => {
    const items = [box('ok', 10), box('nullx', null), box('nanx', NaN)];
    const placed = arrangeByAxis(items, { spanX: 500, laneY: 100, noValueGap: 40 });
    expect(placed).toHaveLength(3); // nothing dropped — same memberId set
    const ok = placed.find((p) => p.memberId === 'ok')!;
    const parked = placed.filter((p) => !p.onAxis);
    expect(ok.onAxis).toBe(true);
    expect(parked.map((p) => p.memberId).sort()).toEqual(['nanx', 'nullx']);
    for (const p of placed) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    // The pile sits BELOW the lane (lane 100 + gap 40 = 140), laid left→right.
    for (const p of parked) expect(p.y).toBeCloseTo(140, 6);
  });

  it('in 2-D scatter, an item missing its Y value parks (X alone is not enough)', () => {
    const items = [box('full', 5, 5), box('noy', 9, null)];
    const placed = arrangeByAxis(items, { spanX: 400, spanY: 400 });
    expect(placed.find((p) => p.memberId === 'full')!.onAxis).toBe(true);
    expect(placed.find((p) => p.memberId === 'noy')!.onAxis).toBe(false);
  });

  it('degenerate domain (all values equal) pins to the axis start — no divide-by-zero', () => {
    const items = [box('x', 7), box('y', 7), box('z', 7)];
    const placed = arrangeByAxis(items, { originX: 30, spanX: 500 });
    for (const p of placed) {
      expect(centreX(p)).toBeCloseTo(30, 6); // pinned to origin, not NaN
      expect(Number.isFinite(p.x)).toBe(true);
    }
  });

  it('empty input → [] and every-value-missing → all parked, still total', () => {
    expect(arrangeByAxis([])).toEqual([]);
    const allBad = arrangeByAxis([box('a', null), box('b', NaN)], { spanX: 300 });
    expect(allBad).toHaveLength(2);
    expect(allBad.every((p) => !p.onAxis)).toBe(true);
    for (const p of allBad) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });

  it('bad option values (NaN span) fall back to defaults, never propagate NaN', () => {
    const placed = arrangeByAxis([box('a', 0), box('b', 1)], { spanX: NaN, originX: NaN });
    for (const p of placed) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
});

describe('axisTicks — nice, labelled, monotonic', () => {
  it('produces round 1/2/5×10ⁿ steps spanning the domain', () => {
    const ticks = axisTicks({ min: 0, max: 100 }, 1000, 0, { count: 5 });
    const values = ticks.map((t) => t.value);
    // step for 100/5=20 → nice 20: 0,20,40,60,80,100
    expect(values).toEqual([0, 20, 40, 60, 80, 100]);
    // positions are monotonic increasing along the axis and within [0,1000]
    for (let i = 1; i < ticks.length; i += 1) expect(ticks[i].pos).toBeGreaterThan(ticks[i - 1].pos);
    expect(ticks[0].pos).toBeCloseTo(0, 6);
    expect(ticks[ticks.length - 1].pos).toBeCloseTo(1000, 6);
  });

  it('cleans floating-point noise on fractional steps', () => {
    const ticks = axisTicks({ min: 0, max: 1 }, 500, 0, { count: 5 });
    // step ≈ 0.2 → 0,0.2,0.4,0.6,0.8,1 with no 0.30000000004 noise
    expect(ticks.map((t) => t.value)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it('invert flips tick positions (Y axis: min value at the bottom)', () => {
    const ticks = axisTicks({ min: 0, max: 100 }, 400, 0, { count: 5, invert: true });
    // value 0 → bottom (pos 400), value 100 → top (pos 0)
    expect(ticks.find((t) => t.value === 0)!.pos).toBeCloseTo(400, 6);
    expect(ticks.find((t) => t.value === 100)!.pos).toBeCloseTo(0, 6);
  });

  it('degenerate domain → a single tick at the start, never NaN', () => {
    const ticks = axisTicks({ min: 5, max: 5 }, 300, 10);
    expect(ticks).toHaveLength(1);
    expect(ticks[0].value).toBe(5);
    expect(ticks[0].pos).toBe(10);
  });

  it('handles negative domains (deltas / temperatures)', () => {
    const ticks = axisTicks({ min: -30, max: 30 }, 600, 0, { count: 6 });
    expect(ticks.every((t) => Number.isFinite(t.value) && Number.isFinite(t.pos))).toBe(true);
    expect(ticks.some((t) => t.value < 0)).toBe(true);
    expect(ticks.some((t) => t.value > 0)).toBe(true);
  });

  // Convergence audit batch-7 (self + Codex GPT-5.5): a NON-FINITE domain must not HANG. With
  // max=Infinity, range=Infinity and step is finite (niceStep guards to 1), so the tick loop
  // `v <= hi` (Infinity) never terminates → infinite loop. Guarded to the single-tick degenerate
  // result. The 1500ms timeout FAILS (rather than hangs the suite) if the guard regresses.
  it('a non-finite domain (max=Infinity) returns a single finite tick, never hangs', () => {
    const ticks = axisTicks({ min: 0, max: Infinity }, 300, 10);
    expect(ticks).toHaveLength(1);
    expect(Number.isFinite(ticks[0].value)).toBe(true);
    expect(ticks[0].pos).toBe(10);
  }, 1500);

  it('a fully-infinite domain (min=-Infinity, max=Infinity) does not hang', () => {
    const ticks = axisTicks({ min: -Infinity, max: Infinity }, 300, 0);
    expect(ticks).toHaveLength(1);
    expect(Number.isFinite(ticks[0].value)).toBe(true);
  }, 1500);

  it('a NaN domain returns a single FINITE tick (never a NaN tick value)', () => {
    const ticks = axisTicks({ min: NaN, max: 100 }, 300, 5);
    expect(ticks).toHaveLength(1);
    expect(Number.isFinite(ticks[0].value)).toBe(true); // was value: NaN before the guard
  }, 1500);
});

describe('axisTickLabels — placeable labels (the labelled-axis half)', () => {
  it('X orientation: labels centred under each tick at the edge Y, formatted', () => {
    const ticks = axisTicks({ min: 0, max: 100 }, 1000, 0, { count: 5 });
    const labels = axisTickLabels(ticks, { orientation: 'x', edge: 420, labelW: 48, labelH: 20 });
    expect(labels).toHaveLength(ticks.length);
    for (let i = 0; i < ticks.length; i += 1) {
      expect(labels[i].x).toBeCloseTo(ticks[i].pos - 24, 6); // centred (w/2)
      expect(labels[i].y).toBe(420); // on the edge row
      expect(labels[i].text).toBe(String(ticks[i].value));
    }
  });

  it('Y orientation: labels stacked at the edge X, vertically centred on each tick', () => {
    const ticks = axisTicks({ min: 0, max: 100 }, 400, 0, { count: 5, invert: true });
    const labels = axisTickLabels(ticks, { orientation: 'y', edge: -60, labelH: 20 });
    for (let i = 0; i < ticks.length; i += 1) {
      expect(labels[i].x).toBe(-60);
      expect(labels[i].y).toBeCloseTo(ticks[i].pos - 10, 6); // centred (h/2)
    }
  });

  it('custom format maps the raw number to a human label (date / $ / %)', () => {
    const ticks = axisTicks({ min: 0, max: 100 }, 500, 0, { count: 5 });
    const labels = axisTickLabels(ticks, { orientation: 'x', edge: 0, format: (v) => `${v}%` });
    expect(labels.map((l) => l.text)).toEqual(['0%', '20%', '40%', '60%', '80%', '100%']);
  });

  it('degenerate / bad options never produce NaN positions', () => {
    const ticks = axisTicks({ min: 5, max: 5 }, 300, 10); // single tick
    const labels = axisTickLabels(ticks, { orientation: 'x', edge: NaN, labelW: NaN });
    expect(labels).toHaveLength(1);
    expect(Number.isFinite(labels[0].x) && Number.isFinite(labels[0].y)).toBe(true);
  });
});

describe('arrangeTimelineLanes — continuous X × discrete lanes (Gantt / roadmap)', () => {
  const item = (id: string, valueX: number | null, laneKey: string) => ({ memberId: id, w: 80, h: 40, valueX, laneKey });

  it('X scales with the value; Y is the centre of the item lane band', () => {
    const items = [item('a', 0, 'todo'), item('b', 100, 'todo'), item('c', 50, 'doing')];
    const { positions, lanes } = arrangeTimelineLanes(items, { originX: 0, originY: 0, spanX: 1000, laneHeight: 100, laneGap: 0 });
    const by = Object.fromEntries(positions.map((p) => [p.memberId, p]));
    // lanes ordered sorted: 'doing' < 'todo' → doing = lane 0 (y band 0..100), todo = lane 1 (100..200)
    expect(lanes.map((l) => l.key)).toEqual(['doing', 'todo']);
    // X: a(0)→left, b(100)→right edge, centred (−w/2)
    expect(by.a.x + 40).toBeCloseTo(0, 6);
    expect(by.b.x + 40).toBeCloseTo(1000, 6);
    expect(by.c.x + 40).toBeCloseTo(500, 6);
    // Y: c in 'doing' (lane 0) band-centre 50; a,b in 'todo' (lane 1) band-centre 150
    expect(by.c.y + 20).toBeCloseTo(50, 6);
    expect(by.a.y + 20).toBeCloseTo(150, 6);
    expect(by.b.y + 20).toBeCloseTo(150, 6);
  });

  it('laneKeys forces order AND keeps empty lanes visible (a persisted swimlane board)', () => {
    const items = [item('a', 10, 'done')]; // only 'done' has items
    const { lanes } = arrangeTimelineLanes(items, { laneKeys: ['todo', 'doing', 'done'], laneHeight: 60, laneGap: 10 });
    expect(lanes.map((l) => l.key)).toEqual(['todo', 'doing', 'done']); // all three, in order
    expect(lanes.find((l) => l.key === 'todo')!.count).toBe(0); // empty lane still present
    expect(lanes.find((l) => l.key === 'done')!.count).toBe(1);
    // bands stack: todo y=0, doing y=70, done y=140 (h60 + gap10)
    expect(lanes.map((l) => l.y)).toEqual([0, 70, 140]);
  });

  it('fail-closed: null/NaN X pins to the lane start; degenerate domain never NaN', () => {
    const items = [item('a', null, 'x'), item('b', NaN, 'x'), item('c', 5, 'x')];
    const { positions } = arrangeTimelineLanes(items, { originX: 30, spanX: 500 });
    const by = Object.fromEntries(positions.map((p) => [p.memberId, p]));
    expect(by.a.x + 40).toBeCloseTo(30, 6); // null → lane start (originX)
    expect(by.b.x + 40).toBeCloseTo(30, 6); // NaN → lane start
    for (const p of positions) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });

  it('all-equal X domain pins every card to the origin (no divide-by-zero)', () => {
    const items = [item('a', 7, 'l'), item('b', 7, 'l')];
    const { positions } = arrangeTimelineLanes(items, { originX: 12, spanX: 400 });
    for (const p of positions) expect(p.x + 40).toBeCloseTo(12, 6);
  });

  it('empty input → empty layout; exposes domainX for a matching axis-ticks pass', () => {
    expect(arrangeTimelineLanes([]).positions).toEqual([]);
    const out = arrangeTimelineLanes([item('a', 0, 'l'), item('b', 100, 'l')], { spanX: 200 });
    expect(out.domainX).toEqual({ min: 0, max: 100 });
    expect(out.spanX).toBe(200);
  });
});

describe('arrange-by-axis red-team — untrusted geometry hardening (cont.98 batch-31)', () => {
  // #2: a persisted Number.MAX_VALUE / NaN item dimension yields FINITE placements (never NaN/Infinity).
  it('clamps MAX_VALUE / NaN item dimensions to finite positions (on-axis)', () => {
    const items: AxisItem[] = [
      { memberId: 'huge', w: Number.MAX_VALUE, h: Number.NaN, valueX: 5 },
      { memberId: 'ok', w: 100, h: 40, valueX: 10 },
    ];
    for (const p of arrangeByAxis(items, { spanX: 800 })) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  // #2 (pile): a MAX_VALUE-width parked item doesn't overflow the no-value pile accumulation.
  it('keeps the no-value pile finite with a MAX_VALUE-width parked item', () => {
    const items: AxisItem[] = [
      { memberId: 'p', w: Number.MAX_VALUE, h: 40, valueX: null },
      { memberId: 'q', w: 100, h: 40, valueX: null },
    ];
    for (const p of arrangeByAxis(items, { spanX: 800 })) expect(Number.isFinite(p.x)).toBe(true);
  });

  // #4: a finite-huge axis value against a small EXPLICIT domain no longer overflows the scaled position.
  it('clamps a finite-huge axis value against a small explicit domain (no Infinity coord)', () => {
    const items: AxisItem[] = [{ memberId: 'x', w: 100, h: 40, valueX: Number.MAX_VALUE }];
    const placed = arrangeByAxis(items, { spanX: 800, domainX: { min: 0, max: 10 } });
    expect(placed).toHaveLength(1);
    expect(Number.isFinite(placed[0].x)).toBe(true);
    expect(Math.abs(placed[0].x)).toBeLessThanOrEqual(1e7);
  });
});
