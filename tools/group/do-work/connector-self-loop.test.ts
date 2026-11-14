// Proof for self-loop connectors: only same-node edges get a nesting index (numbered per node, by id),
// a self-loop renders as a cubic teardrop leaving and returning to the top edge with the mouth straddling
// centre, the loop bulges above the box, and a higher nesting index reaches further out (concentric).
import { describe, expect, it } from 'vitest';
import { selfLoopIndices, selfLoopPath } from 'trillion-workshop/tools/organize-the-sidebar/do-work/connector-self-loop.ts';
import type { FanEdge } from 'trillion-workshop/tools/organize-the-sidebar/do-work/connector-fan.ts';
import type { ConnectorRect } from './connector-geometry';

const e = (id: string, from: string, to: string): FanEdge => ({ id, from, to });
const R: ConnectorRect = { x: 100, y: 200, w: 120, h: 60 }; // top edge y=200, centre x=160

describe('connector-self-loop — selfLoopIndices', () => {
  it('ignores a normal edge (from !== to → absent)', () => {
    const m = selfLoopIndices([e('x', 'a', 'b')]);
    expect(m.has('x')).toBe(false);
  });

  it('numbers self-loops on one node 0,1,2 ordered by id', () => {
    const m = selfLoopIndices([e('c', 'a', 'a'), e('a', 'a', 'a'), e('b', 'a', 'a')]);
    expect(m.get('a')).toBe(0);
    expect(m.get('b')).toBe(1);
    expect(m.get('c')).toBe(2);
  });

  it('numbers each node independently', () => {
    const m = selfLoopIndices([e('l1', 'a', 'a'), e('l2', 'b', 'b')]);
    expect(m.get('l1')).toBe(0);
    expect(m.get('l2')).toBe(0);
  });
});

describe('connector-self-loop — selfLoopPath', () => {
  it('is a cubic (C) leaving and returning to the top edge, mouth straddling centre', () => {
    const g = selfLoopPath(R, 0);
    expect(g.d.includes(' C ')).toBe(true);
    expect(g.p1.y).toBe(200); // both ends on the top edge
    expect(g.p2.y).toBe(200);
    expect(g.p1.x).toBeLessThan(160); // left of centre
    expect(g.p2.x).toBeGreaterThan(160); // right of centre
    expect(g.p1.x).toBeCloseTo(320 - g.p2.x, 5); // symmetric about centre x=160 (p1 = 2*160 - p2)
  });

  it('bulges ABOVE the box (loop apex has a smaller y than the top edge)', () => {
    const g = selfLoopPath(R, 0);
    expect(g.mid.y).toBeLessThan(200);
  });

  it('nests: a higher index reaches further out and widens the mouth', () => {
    const inner = selfLoopPath(R, 0);
    const outer = selfLoopPath(R, 1);
    expect(outer.mid.y).toBeLessThan(inner.mid.y); // further above the box
    expect(outer.p2.x - 160).toBeGreaterThan(inner.p2.x - 160); // wider mouth (p2 further right of centre)
  });
});
