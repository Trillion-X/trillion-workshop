// packages/group/show/rotated-transform.test.ts
//
// Proof of the rotated-resize geometry. The two invariants that make it correct:
//   (1) θ=0 reduces to the plain axis-aligned resize.
//   (2) the OPPOSITE handle stays fixed in world space at ANY angle (pin-invariance).
// Pure math — no DOM, no engine.

import { describe, it, expect } from 'vitest';
import { applyResizeGeom, type ResizeEdge } from '../../ui';
import { rotateVec, resizeRotated, handleWorldPos, oppositeEdge, constrainAspectDelta, orbitPoint, type Rect, type Vec } from './rotated-transform';

const R: Rect = { x: 100, y: 100, w: 200, h: 120 };
const MIN = 20;
const near = (a: Vec, b: Vec, eps = 1e-6) => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;

describe('rotateVec', () => {
  it('rotates +90° turning (1,0) into (0,1)', () => {
    const r = rotateVec({ x: 1, y: 0 }, Math.PI / 2);
    expect(r.x).toBeCloseTo(0, 9);
    expect(r.y).toBeCloseTo(1, 9);
  });
  it('is the inverse for ±θ', () => {
    const v = { x: 3, y: -7 };
    const back = rotateVec(rotateVec(v, 0.9), -0.9);
    expect(near(back, v)).toBe(true);
  });
});

describe('resizeRotated', () => {
  it('θ=0 is identical to applyResizeGeom for every edge', () => {
    const edges: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    for (const edge of edges) {
      const d = { x: 17, y: -11 };
      const rotated = resizeRotated(R, 0, edge, d, MIN, MIN);
      const plain = applyResizeGeom(edge, R, d.x, d.y, MIN, MIN);
      expect(rotated.x).toBeCloseTo(plain.x, 9);
      expect(rotated.y).toBeCloseTo(plain.y, 9);
      expect(rotated.w).toBeCloseTo(plain.w, 9);
      expect(rotated.h).toBeCloseTo(plain.h, 9);
    }
  });

  it('keeps the OPPOSITE handle pinned in world for every edge at θ=90 and θ=45', () => {
    const edges: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    for (const theta of [90, 45, 30, 180]) {
      for (const edge of edges) {
        const opp = oppositeEdge(edge);
        const anchorBefore = handleWorldPos(R, theta, opp);
        // A delta that grows the box (along the dragged handle direction); the exact
        // value doesn't matter for the invariant — the opposite handle must not move.
        const d = { x: 25, y: 18 };
        const next = resizeRotated(R, theta, edge, d, MIN, MIN);
        const anchorAfter = handleWorldPos(next, theta, opp);
        expect(near(anchorAfter, anchorBefore, 1e-6)).toBe(true);
      }
    }
  });

  it('grows width when dragging the e edge outward along the local x (θ=90)', () => {
    // At θ=90 the local +x points to world +y; dragging the handle in world +y grows w.
    const next = resizeRotated(R, 90, 'e', { x: 0, y: 40 }, MIN, MIN);
    expect(next.w).toBeCloseTo(R.w + 40, 6);
    expect(next.h).toBeCloseTo(R.h, 6);
  });

  it('clamps to the minimum size without flipping', () => {
    const next = resizeRotated({ x: 0, y: 0, w: 40, h: 40 }, 35, 'w', { x: 1000, y: 1000 }, MIN, MIN);
    expect(next.w).toBeGreaterThanOrEqual(MIN);
    expect(next.h).toBeGreaterThanOrEqual(MIN);
  });
});

describe('constrainAspectDelta (Shift aspect-lock)', () => {
  const ratio = (r: { w: number; h: number }) => r.w / r.h;
  it('preserves Δw/Δh == w/h for every corner', () => {
    const corners: ResizeEdge[] = ['se', 'ne', 'nw', 'sw'];
    for (const edge of corners) {
      // a delta whose width-push dominates → height follows to keep ratio 2:1
      const d = constrainAspectDelta(edge, { x: 40, y: 3 }, 200, 100);
      const gw = edge.includes('e') ? d.x : -d.x;
      const gh = edge.includes('s') ? d.y : -d.y;
      expect(gw / 200).toBeCloseTo(gh / 100, 9); // proportional growth
    }
  });
  it('leaves a side edge unchanged (aspect-lock is corner-only)', () => {
    for (const edge of ['n', 's', 'e', 'w'] as ResizeEdge[]) {
      const d = { x: 17, y: -11 };
      expect(constrainAspectDelta(edge, d, 200, 100)).toEqual(d);
    }
  });
  it('lets the dominant axis drive (small off-axis delta snaps to the diagonal)', () => {
    // height-push dominates relative to size → width follows
    const d = constrainAspectDelta('se', { x: 2, y: 50 }, 200, 100);
    expect(d.x / 200).toBeCloseTo(d.y / 100, 9);
  });
  it('resizeRotated(lockAspect) keeps the rect ratio for a corner at θ=0 and θ=90', () => {
    for (const theta of [0, 90]) {
      const next = resizeRotated(R, theta, 'se', { x: 60, y: 4 }, MIN, MIN, true);
      expect(ratio(next)).toBeCloseTo(ratio(R), 6);
    }
  });
  it('resizeRotated without lockAspect is unchanged (default false)', () => {
    const a = resizeRotated(R, 0, 'se', { x: 30, y: 5 }, MIN, MIN);
    const b = resizeRotated(R, 0, 'se', { x: 30, y: 5 }, MIN, MIN, false);
    expect(a).toEqual(b);
  });
});

describe('orbitPoint (group rotation)', () => {
  it('orbits a point +90° about the origin', () => {
    const r = orbitPoint({ x: 10, y: 0 }, { x: 0, y: 0 }, Math.PI / 2);
    expect(r.x).toBeCloseTo(0, 9);
    expect(r.y).toBeCloseTo(10, 9);
  });
  it('orbits about an arbitrary pivot', () => {
    // a point 10 to the right of pivot (100,100), rotated +90° → 10 below pivot
    const r = orbitPoint({ x: 110, y: 100 }, { x: 100, y: 100 }, Math.PI / 2);
    expect(r.x).toBeCloseTo(100, 9);
    expect(r.y).toBeCloseTo(110, 9);
  });
  it('rad=0 is the identity', () => {
    const p = { x: 37, y: -12 };
    expect(near(orbitPoint(p, { x: 5, y: 5 }, 0), p)).toBe(true);
  });
  it('round-trips for +θ then −θ', () => {
    const p = { x: 3, y: 9 };
    const pivot = { x: -4, y: 2 };
    expect(near(orbitPoint(orbitPoint(p, pivot, 0.7), pivot, -0.7), p)).toBe(true);
  });
});

describe('handleWorldPos / oppositeEdge', () => {
  it('opposite of corners/edges', () => {
    expect(oppositeEdge('e')).toBe('w');
    expect(oppositeEdge('n')).toBe('s');
    expect(oppositeEdge('se')).toBe('nw');
    expect(oppositeEdge('ne')).toBe('sw');
  });
  it('handle of an unrotated rect is the literal edge midpoint', () => {
    const e = handleWorldPos(R, 0, 'e');
    expect(e.x).toBeCloseTo(R.x + R.w, 9); // right edge mid
    expect(e.y).toBeCloseTo(R.y + R.h / 2, 9);
  });

  describe('rotated-transform red-team — untrusted rotation/geometry never persists a non-finite rect (cont.98 batch-37)', () => {
    it('a NaN rotation yields a finite persisted rect (Math.cos(NaN) trap closed)', () => {
      const out = resizeRotated(R, Number.NaN, 'se', { x: 10, y: 10 }, 20, 20);
      expect([out.x, out.y, out.w, out.h].every(Number.isFinite)).toBe(true);
    });

    it('a MAX_VALUE rect coord or Infinity rotation still yields a finite rect', () => {
      const wild = resizeRotated({ x: Number.MAX_VALUE, y: 0, w: 200, h: 120 }, Number.POSITIVE_INFINITY, 'nw', { x: -5, y: -5 }, 20, 20);
      expect([wild.x, wild.y, wild.w, wild.h].every(Number.isFinite)).toBe(true);
    });

    it('constrainAspectDelta fails closed (returns the raw delta) for a NaN size', () => {
      const d = { x: 7, y: 3 };
      expect(constrainAspectDelta('se', d, Number.NaN, 120)).toEqual(d);
      expect(constrainAspectDelta('se', d, 200, 0)).toEqual(d);
    });
  });
});
