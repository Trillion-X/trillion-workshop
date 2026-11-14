// Proof for the obstacle-avoiding orthogonal router: the returned polyline is always axis-aligned, starts
// on `from` and ends on `to`, and no segment crosses the interior of any obstacle (inflated by the margin)
// — for zero, one, and many staggered obstacles — with a fail-open L-elbow when the target is boxed in.
import { describe, expect, it } from 'vitest';
import { orthogonalAvoidRoute } from './orthogonal-route';
import type { Pt, ConnectorRect } from './connector-geometry';

const R = (x: number, y: number, w: number, h: number): ConnectorRect => ({ x, y, w, h });
const MARGIN = 12;

// Every consecutive pair shares an x or a y (no diagonal segment).
const isOrthogonal = (pts: readonly Pt[]): boolean =>
  pts.every((p, i) => i === 0 || p.x === pts[i - 1].x || p.y === pts[i - 1].y);

// Does an axis-aligned segment p→q pass through the strict interior of r?
function crosses(p: Pt, q: Pt, r: ConnectorRect): boolean {
  if (p.x === q.x) {
    if (p.x <= r.x || p.x >= r.x + r.w) return false;
    return Math.min(p.y, q.y) < r.y + r.h && Math.max(p.y, q.y) > r.y;
  }
  if (p.y <= r.y || p.y >= r.y + r.h) return false;
  return Math.min(p.x, q.x) < r.x + r.w && Math.max(p.x, q.x) > r.x;
}
const pathAvoids = (pts: readonly Pt[], obstacles: readonly ConnectorRect[], m = MARGIN): boolean =>
  pts.every((p, i) => i === 0 || obstacles.every((o) => !crosses(pts[i - 1], p, { x: o.x - m, y: o.y - m, w: o.w + 2 * m, h: o.h + 2 * m })));

const onEdge = (p: Pt, r: ConnectorRect): boolean =>
  ((p.x === r.x || p.x === r.x + r.w) && p.y >= r.y && p.y <= r.y + r.h) ||
  ((p.y === r.y || p.y === r.y + r.h) && p.x >= r.x && p.x <= r.x + r.w);

describe('orthogonal-route — orthogonalAvoidRoute', () => {
  it('with no obstacles returns an orthogonal route anchored on both boxes', () => {
    const from = R(0, 100, 60, 60);
    const to = R(400, 100, 60, 60);
    const path = orthogonalAvoidRoute(from, to, []);
    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(isOrthogonal(path)).toBe(true);
    expect(onEdge(path[0], from)).toBe(true);
    expect(onEdge(path[path.length - 1], to)).toBe(true);
  });

  it('routes AROUND a single box sitting on the straight line', () => {
    const from = R(0, 100, 60, 60);
    const to = R(400, 100, 60, 60);
    const wall = R(200, 80, 60, 100); // straddles y≈130, the from→to eye-line
    const path = orthogonalAvoidRoute(from, to, [wall]);
    expect(isOrthogonal(path)).toBe(true);
    expect(pathAvoids(path, [wall])).toBe(true); // no segment cuts through the (inflated) wall
    expect(path.length).toBeGreaterThan(2); // it had to bend
  });

  it('routes around MANY staggered obstacles (the general case, not a one-box hack)', () => {
    const from = R(0, 200, 60, 60);
    const to = R(600, 200, 60, 60);
    const walls = [R(150, 120, 50, 200), R(300, 150, 50, 220), R(450, 100, 50, 200)];
    const path = orthogonalAvoidRoute(from, to, walls);
    expect(isOrthogonal(path)).toBe(true);
    expect(pathAvoids(path, walls)).toBe(true); // avoids EVERY wall at once
    expect(onEdge(path[0], from)).toBe(true);
    expect(onEdge(path[path.length - 1], to)).toBe(true);
  });

  it('keeps the configured clearance margin (route does not grip the box)', () => {
    const from = R(0, 100, 60, 60);
    const to = R(400, 100, 60, 60);
    const wall = R(200, 80, 60, 100);
    const path = orthogonalAvoidRoute(from, to, [wall], { margin: 24 });
    expect(pathAvoids(path, [wall], 24)).toBe(true); // clears the larger inflated box too
  });

  it('is deterministic — identical inputs give identical output', () => {
    const from = R(0, 0, 40, 40);
    const to = R(300, 220, 40, 40);
    const walls = [R(120, 60, 60, 120), R(200, 20, 50, 100)];
    expect(orthogonalAvoidRoute(from, to, walls)).toEqual(orthogonalAvoidRoute(from, to, walls));
  });

  it('fails open (never throws, returns ≥2 points) when the target is fully boxed in', () => {
    const from = R(0, 100, 40, 40);
    const to = R(300, 100, 40, 40);
    // A ring of walls hugging `to` on all sides.
    const walls = [R(250, 40, 140, 20), R(250, 180, 140, 20), R(250, 40, 20, 160), R(370, 40, 20, 160)];
    const path = orthogonalAvoidRoute(from, to, walls);
    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(isOrthogonal(path)).toBe(true);
  });
});
