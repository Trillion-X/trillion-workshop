// packages/group/do-work/connector-geometry.test.ts
//
// Pure proof of the connector geometry (#2 fixed ports). anchorPoint resolves a
// normalized DATA port to a fixed box point; connectorPath honors anchors when
// present and reproduces the pre-#2 auto-routing byte-for-byte when absent.

import { describe, expect, it } from 'vitest';
import {
  anchorPoint,
  center,
  edgePoint,
  connectorPath,
  readWaypoints,
  insertBendAt,
  moveWaypoint,
  removeWaypoint,
  ROUTING_ALGORITHMS,
  type ConnectorRect,
  type RoutingAlgorithm,
  type Pt,
} from './connector-geometry';

const A: ConnectorRect = { x: 0, y: 0, w: 100, h: 40 };     // center (50,20)
const B: ConnectorRect = { x: 300, y: 0, w: 100, h: 40 };   // center (350,20), to the right

describe('anchorPoint — normalized DATA port resolver', () => {
  it('resolves the four cardinal ports as fractions of the box', () => {
    expect(anchorPoint(A, { nx: 0.5, ny: 0 })).toEqual({ x: 50, y: 0 });   // top-center
    expect(anchorPoint(A, { nx: 1, ny: 0.5 })).toEqual({ x: 100, y: 20 }); // right-center
    expect(anchorPoint(A, { nx: 0.5, ny: 1 })).toEqual({ x: 50, y: 40 });  // bottom-center
    expect(anchorPoint(A, { nx: 0, ny: 0.5 })).toEqual({ x: 0, y: 20 });   // left-center
  });

  it('resolves an arbitrary fractional port (ports are not limited to 4 sides)', () => {
    expect(anchorPoint(A, { nx: 0.25, ny: 0.75 })).toEqual({ x: 25, y: 30 });
  });

  it('clamps out-of-range / non-finite anchors into the box', () => {
    expect(anchorPoint(A, { nx: 2, ny: -1 })).toEqual({ x: 100, y: 0 });
    expect(anchorPoint(A, { nx: Number.NaN, ny: 0.5 })).toEqual({ x: 0, y: 20 });
  });
});

describe('connectorPath — no anchors reproduces the auto-routing exactly', () => {
  it('straight: endpoints are the auto border crossings (right edge of A → left edge of B)', () => {
    const g = connectorPath('straight', A, B);
    // A→B is horizontal: edgePoint(A toward B) = right-center (100,20); edgePoint(B toward A) = left-center (300,20).
    expect(g.p1).toEqual(edgePoint(A, center(B).x, center(B).y));
    expect(g.p2).toEqual(edgePoint(B, center(A).x, center(A).y));
    expect(g.p1).toEqual({ x: 100, y: 20 });
    expect(g.p2).toEqual({ x: 300, y: 20 });
    expect(g.d).toBe('M 100 20 L 300 20');
  });

  it('elbow: horizontal-first route between the box edges (unchanged from #102)', () => {
    const g = connectorPath('elbow', A, B);
    expect(g.p1).toEqual({ x: 100, y: 20 });
    expect(g.p2).toEqual({ x: 300, y: 20 });
    expect(g.d).toBe('M 100 20 L 200 20 L 200 20 L 300 20');
  });

  it('routing is INJECTABLE: a composition root passes its own algorithm map (Codex F7)', () => {
    // A brand-new routing algorithm registered as DATA — the dispatcher never learns its name.
    const custom = {
      ...ROUTING_ALGORITHMS,
      zigzag: (a: typeof A) => ({ d: 'CUSTOM', p1: { x: a.x, y: a.y }, p2: { x: a.x, y: a.y }, mid: { x: a.x, y: a.y } }),
    };
    expect(connectorPath('zigzag', A, B, undefined, undefined, undefined, custom).d).toBe('CUSTOM');
    // Default (no map passed) still resolves the built-ins — zero regression for every caller.
    expect(connectorPath('straight', A, B).d).toBe('M 100 20 L 300 20');
    // An unknown key falls back to the injected map's straight, not a source edit.
    expect(connectorPath('nope', A, B, undefined, undefined, undefined, custom).d).toBe('M 100 20 L 300 20');
  });
});

describe('connectorPath — fixed-port anchors pin the endpoints', () => {
  it('straight: a from-anchor pins p1 to the exact port, to-anchor pins p2', () => {
    const g = connectorPath('straight', A, B, { nx: 0.5, ny: 0 }, { nx: 0.5, ny: 1 });
    expect(g.p1).toEqual({ x: 50, y: 0 });   // A top-center
    expect(g.p2).toEqual({ x: 350, y: 40 }); // B bottom-center
    expect(g.d).toBe('M 50 0 L 350 40');
  });

  it('only one anchored endpoint: the other still auto-routes', () => {
    const g = connectorPath('straight', A, B, { nx: 1, ny: 0 }); // A top-right pinned; B auto
    expect(g.p1).toEqual({ x: 100, y: 0 });
    expect(g.p2).toEqual(edgePoint(B, center(A).x, center(A).y)); // unchanged auto
  });

  it('elbow: anchored endpoints become the route corners', () => {
    const g = connectorPath('elbow', A, B, { nx: 1, ny: 0 }, { nx: 0, ny: 1 });
    expect(g.p1).toEqual({ x: 100, y: 0 });
    expect(g.p2).toEqual({ x: 300, y: 40 });
    expect(g.d).toBe('M 100 0 L 200 0 L 200 40 L 300 40');
  });
});

describe('diagonal routing (b106) — octilinear: a 45° leg then an axis-aligned run', () => {
  // a diagonally-offset pair (A top-left, C bottom-right) so both a 45° leg and a straight run exist.
  const C: ConnectorRect = { x: 260, y: 200, w: 100, h: 40 }; // center (310,220)
  const seg = (p: Pt, q: Pt) => ({ dx: Math.abs(q.x - p.x), dy: Math.abs(q.y - p.y) });
  const pointsOf = (d: string): Pt[] => {
    const t = d.replace(/[ML]/g, ' ').trim().split(/\s+/).map(Number);
    const pts: Pt[] = [];
    for (let i = 0; i + 1 < t.length; i += 2) pts.push({ x: t[i], y: t[i + 1] });
    return pts;
  };

  it('the first segment is a true 45° diagonal and the second is axis-aligned', () => {
    const g = connectorPath('diagonal', A, C);
    const pts = pointsOf(g.d);
    expect(pts).toHaveLength(3); // start, corner, end
    const s1 = seg(pts[0], pts[1]);
    const s2 = seg(pts[1], pts[2]);
    expect(Math.abs(s1.dx - s1.dy)).toBeLessThan(0.001); // 45° leg (|Δx| == |Δy|)
    expect(Math.min(s2.dx, s2.dy)).toBeLessThan(0.001); // axis-aligned run (one delta is 0)
    expect(g.p1).toEqual(connectorPath('straight', A, C).p1); // same auto border endpoints as straight
  });

  it('honours fixed-port anchors at the endpoints', () => {
    const g = connectorPath('diagonal', A, C, { nx: 0.5, ny: 1 }, { nx: 0, ny: 0.5 });
    const pts = pointsOf(g.d);
    expect(pts[0]).toEqual({ x: 50, y: 40 }); // A bottom-centre
    expect(pts[pts.length - 1]).toEqual({ x: 260, y: 220 }); // C left-centre
    const s1 = seg(pts[0], pts[1]);
    expect(Math.abs(s1.dx - s1.dy)).toBeLessThan(0.001); // still a 45° first leg
  });
});

describe('routing is an OPEN capability map, not a closed enum (L069/L090)', () => {
  it('ships exactly the seven built-in algorithms, each a function', () => {
    expect(Object.keys(ROUTING_ALGORITHMS).sort()).toEqual(['avoid', 'curved', 'diagonal', 'elbow', 'smooth', 'straight', 'waypoints']);
    for (const fn of Object.values(ROUTING_ALGORITHMS)) expect(typeof fn).toBe('function');
  });

  it('an unknown / absent routing key falls back to straight (never throws)', () => {
    const straight = connectorPath('straight', A, B);
    expect(connectorPath('does-not-exist', A, B)).toEqual(straight);
    // ConnectorLayer passes `c.routing ?? 'straight'`, but the dispatcher is itself
    // total: any string a member carries resolves, unknown → straight.
    expect(connectorPath('', A, B)).toEqual(straight);
  });

  it('EMERGENCE (L069): a routing the core never knew works when injected as DATA — zero dispatcher edit', () => {
    // A composition root spreads its own algorithm over the built-ins. connectorPath
    // dispatches it through the SAME generic lookup — proving the routing name is DATA
    // and the handler is generic. If routing were a closed `if/switch` ladder this
    // could not resolve without editing connectorPath. The deletion test passes.
    const midpointDot: RoutingAlgorithm = (a, b) => {
      const ca = center(a);
      const cb = center(b);
      const mid = { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2 };
      return { d: `M ${mid.x} ${mid.y} L ${mid.x} ${mid.y}`, p1: ca, p2: cb, mid };
    };
    const catalog: Record<string, RoutingAlgorithm> = { ...ROUTING_ALGORITHMS, 'midpoint-dot': midpointDot };
    // Simulate the injected dispatch the same way connectorPath does internally.
    const fn = catalog['midpoint-dot'] ?? catalog.straight;
    const g = fn(A, B);
    expect(g.mid).toEqual({ x: 200, y: 20 });
    expect(g.d).toBe('M 200 20 L 200 20');
    // …and the core dispatcher, unaware of 'midpoint-dot', cleanly yields straight —
    // no crash, no special case: the new mode simply isn't in the shipped map.
    expect(connectorPath('midpoint-dot', A, B)).toEqual(connectorPath('straight', A, B));
  });
});

describe('waypoints routing (#194) — the L069 generalization of straight/curved/elbow', () => {
  it('with NO waypoints, waypoints routing is byte-identical to straight', () => {
    expect(connectorPath('waypoints', A, B)).toEqual(connectorPath('straight', A, B));
    expect(connectorPath('waypoints', A, B, undefined, undefined, [])).toEqual(connectorPath('straight', A, B));
  });

  it('threads the polyline through each bend point, endpoints aiming at the first/last bend', () => {
    const g = connectorPath('waypoints', A, B, undefined, undefined, [{ x: 200, y: 120 }]);
    // p1 leaves A's box aimed at the bend (200,120): edgePoint(A → 200,120) = (80,40).
    expect(g.p1).toEqual({ x: 80, y: 40 });
    // p2 leaves B's box aimed at the same bend: edgePoint(B → 200,120) = (320,40).
    expect(g.p2).toEqual({ x: 320, y: 40 });
    expect(g.d).toBe('M 80 40 L 200 120 L 320 40');
    // Label anchor = midpoint of the central chain segment (here (200,120)→(320,40)).
    expect(g.mid).toEqual({ x: 260, y: 80 });
  });

  it('multiple bends produce a multi-segment path in order', () => {
    const g = connectorPath('waypoints', A, B, undefined, undefined, [
      { x: 150, y: 200 },
      { x: 250, y: 200 },
    ]);
    expect(g.d).toBe(`M ${g.p1.x} ${g.p1.y} L 150 200 L 250 200 L ${g.p2.x} ${g.p2.y}`);
  });

  it('fixed-port anchors still pin the endpoints; bends fill the middle', () => {
    const g = connectorPath('waypoints', A, B, { nx: 0.5, ny: 1 }, { nx: 0.5, ny: 1 }, [{ x: 200, y: 200 }]);
    expect(g.p1).toEqual({ x: 50, y: 40 });   // A bottom-center pinned
    expect(g.p2).toEqual({ x: 350, y: 40 });  // B bottom-center pinned
    expect(g.d).toBe('M 50 40 L 200 200 L 350 40');
  });
});

describe('readWaypoints (#194) — parse self-describing bend DATA, malformed → dropped', () => {
  it('returns [] for non-arrays / absent DATA (clean "no bends")', () => {
    expect(readWaypoints(undefined)).toEqual([]);
    expect(readWaypoints(null)).toEqual([]);
    expect(readWaypoints('nope')).toEqual([]);
    expect(readWaypoints({ x: 1, y: 2 })).toEqual([]);
  });

  it('keeps only finite {x,y} pairs, dropping malformed entries', () => {
    const parsed = readWaypoints([
      { x: 1, y: 2 },
      { x: 'a', y: 3 },
      { x: Number.NaN, y: 0 },
      null,
      { x: 5 },
      { x: 5, y: 6 },
    ]);
    expect(parsed).toEqual([
      { x: 1, y: 2 },
      { x: 5, y: 6 },
    ]);
  });
});

describe('insertBendAt (#194) — a new bend orders into the nearest segment', () => {
  it('with no existing bends, inserts the sole bend', () => {
    expect(insertBendAt({ x: 0, y: 0 }, [], { x: 100, y: 0 }, { x: 50, y: 50 })).toEqual([{ x: 50, y: 50 }]);
  });

  it('inserts into the segment the click is nearest to (keeps left-to-right order)', () => {
    const wps: Pt[] = [{ x: 50, y: 0 }];
    // Click near the SECOND segment (50,0)→(100,0) → append after the existing bend.
    expect(insertBendAt({ x: 0, y: 0 }, wps, { x: 100, y: 0 }, { x: 75, y: 10 })).toEqual([
      { x: 50, y: 0 },
      { x: 75, y: 10 },
    ]);
    // Click near the FIRST segment (0,0)→(50,0) → insert before the existing bend.
    expect(insertBendAt({ x: 0, y: 0 }, wps, { x: 100, y: 0 }, { x: 25, y: 10 })).toEqual([
      { x: 25, y: 10 },
      { x: 50, y: 0 },
    ]);
  });

  it('is pure — the input array is never mutated', () => {
    const wps: Pt[] = [{ x: 50, y: 0 }];
    insertBendAt({ x: 0, y: 0 }, wps, { x: 100, y: 0 }, { x: 25, y: 10 });
    expect(wps).toEqual([{ x: 50, y: 0 }]);
  });
});

describe('moveWaypoint / removeWaypoint (#194) — pure bend edits', () => {
  it('moveWaypoint repositions one bend, out-of-range is a no-op copy', () => {
    const wps: Pt[] = [{ x: 1, y: 1 }, { x: 2, y: 2 }];
    expect(moveWaypoint(wps, 1, { x: 9, y: 9 })).toEqual([{ x: 1, y: 1 }, { x: 9, y: 9 }]);
    expect(moveWaypoint(wps, 5, { x: 9, y: 9 })).toEqual(wps);
    expect(moveWaypoint(wps, -1, { x: 9, y: 9 })).toEqual(wps);
    expect(wps).toEqual([{ x: 1, y: 1 }, { x: 2, y: 2 }]); // unmutated
  });

  it('removeWaypoint deletes one bend, out-of-range is a no-op copy', () => {
    const wps: Pt[] = [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }];
    expect(removeWaypoint(wps, 1)).toEqual([{ x: 1, y: 1 }, { x: 3, y: 3 }]);
    expect(removeWaypoint(wps, 9)).toEqual(wps);
    expect(wps).toEqual([{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]); // unmutated
  });
});

describe('edgePoint — degenerate (zero-size) rects never emit a NaN endpoint', () => {
  // Convergence audit cont.98 (independent self-review + Codex GPT-5.5 both reproduced the
  // {NaN,NaN} endpoint): a zero-WIDTH rect whose partner sits on its vertical axis gave
  // `Math.abs(0) / 0` = 0/0 = NaN, `Math.max(NaN, …)` = NaN, and a broken `M NaN NaN` path.
  const finite = (p: Pt) => Number.isFinite(p.x) && Number.isFinite(p.y);

  it('zero-WIDTH rect, target aligned on its vertical axis → finite point (was NaN)', () => {
    const zeroW: ConnectorRect = { x: 0, y: 0, w: 0, h: 10 }; // center (0,5)
    const p = edgePoint(zeroW, 0, 100); // dx=0, dy=95, hw=0 → old code: 0/0 = NaN
    expect(finite(p)).toBe(true);
    expect(p).toEqual({ x: 0, y: 10 }); // collapsed x-axis does not constrain → exits at bottom edge (y=5+5)
  });

  it('zero-HEIGHT rect, target aligned on its horizontal axis → finite point', () => {
    const zeroH: ConnectorRect = { x: 0, y: 0, w: 10, h: 0 }; // center (5,0)
    const p = edgePoint(zeroH, 100, 0); // dy=0, dx=95, hh=0 → old code: 0/0 = NaN
    expect(finite(p)).toBe(true);
    expect(p).toEqual({ x: 10, y: 0 });
  });

  it('fully zero-size rect (w=0,h=0) → the center is the only sane crossing', () => {
    const zero: ConnectorRect = { x: 5, y: 7, w: 0, h: 0 }; // center (5,7)
    const p = edgePoint(zero, 999, -999);
    expect(finite(p)).toBe(true);
    expect(p).toEqual({ x: 5, y: 7 });
  });

  it('normal positive rect is unchanged (zero-regression on the real path)', () => {
    // A→B horizontal: right-center of A toward B's center; left-center of B toward A.
    expect(edgePoint(A, center(B).x, center(B).y)).toEqual({ x: 100, y: 20 });
    expect(edgePoint(B, center(A).x, center(A).y)).toEqual({ x: 300, y: 20 });
  });
});

describe('connectorPath — hostile routing key resolves to the straight fallback, never crashes', () => {
  // Convergence audit cont.98 batch-17 (self-review + Codex GPT-5.5, both reached it): `routing` is
  // untrusted `extra.routing` DATA, and the routing capability map is a plain object. A bare
  // `algorithms[routing]` lookup let a prototype-chain key escape the map: '__proto__' → Object.prototype
  // (truthy, so it also SKIPPED the `?? straight` fallback) → not callable → CRASH; 'constructor' → Object
  // (callable) → returned `a` (a rect, not a ConnectorGeometry) → a broken downstream `.d`. hasOwn + a
  // function check now route any inherited/garbage key to `straight`.
  const finite = (p: Pt) => Number.isFinite(p.x) && Number.isFinite(p.y);
  const straight = connectorPath('straight', A, B);

  for (const hostile of ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf', 'nope']) {
    it(`routing '${hostile}' → identical to the straight fallback, no throw`, () => {
      let g: ReturnType<typeof connectorPath> | undefined;
      expect(() => { g = connectorPath(hostile, A, B); }).not.toThrow();
      expect(g).toBeDefined();
      expect(typeof g!.d).toBe('string');
      expect(finite(g!.p1) && finite(g!.p2) && finite(g!.mid)).toBe(true);
      expect(g!.d).toBe(straight.d); // unknown routing degrades to straight, byte-identical
    });
  }

  it('a genuinely-registered routing still dispatches (zero regression on the real path)', () => {
    // The built-in 'elbow' is a real own key → must NOT be captured by the guard.
    const elbow = connectorPath('elbow', A, B);
    expect(finite(elbow.p1) && finite(elbow.p2)).toBe(true);
  });
});

describe('readWaypoints — a paste-bombed extra.waypoints is capped, not walked whole', () => {
  // cont.98 batch-17 (Codex HIGH DoS, reachable): a corrupted/persisted extra.waypoints of millions
  // of points would be fully parsed then emitted as a giant SVG path string. The read now caps at
  // MAX_WAYPOINTS (256) — a real hand-routed line has a handful of bends.
  it('a million-entry array is capped to 256 finite points', () => {
    const bomb = new Array(1_000_000).fill({ x: 1, y: 2 });
    const out = readWaypoints(bomb);
    expect(out.length).toBe(256);
    expect(out.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });

  it('a normal short waypoint list is unchanged (zero regression)', () => {
    const wps = [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }];
    expect(readWaypoints(wps)).toEqual(wps);
  });

  it('the cap counts KEPT points only — garbage entries do not consume the budget', () => {
    // 300 junk entries (dropped) followed by 5 valid points → all 5 valid points survive.
    const mixed = [...new Array(300).fill(null), ...[1, 2, 3, 4, 5].map((n) => ({ x: n, y: n }))];
    expect(readWaypoints(mixed)).toEqual([1, 2, 3, 4, 5].map((n) => ({ x: n, y: n })));
  });
});

describe('connector-geometry red-team — untrusted geometry hardening (cont.98 batch-29)', () => {
  const A: ConnectorRect = { x: 0, y: 0, w: 100, h: 50 };
  const B: ConnectorRect = { x: 500, y: 0, w: 100, h: 50 };

  // F4: readWaypoints bounds the SCAN, not just the kept count — a million all-garbage entries would
  // otherwise loop a million times before the keep-budget (which never fills) lets it break.
  it('does not walk a multi-million-entry all-garbage waypoint array (scan cap)', () => {
    const bomb = new Array(5_000_000).fill(null);
    expect(() => readWaypoints(bomb)).not.toThrow();
    expect(readWaypoints(bomb)).toEqual([]);
  });

  // F5: a finite-huge MAX_VALUE rect coord is clamped at the connectorPath seam → every routing emits a
  // finite path (center/midpoint math would otherwise overflow `x+w` to Infinity in the SVG `d`).
  it('connectorPath emits a finite path for a Number.MAX_VALUE rect across every routing', () => {
    const huge: ConnectorRect = { x: Number.MAX_VALUE, y: 0, w: Number.MAX_VALUE, h: 50 };
    for (const routing of ['straight', 'curved', 'elbow', 'waypoints']) {
      const g = connectorPath(routing, huge, A);
      expect(g.d).not.toMatch(/Infinity|NaN/);
      expect(Number.isFinite(g.p1.x) && Number.isFinite(g.p1.y)).toBe(true);
      expect(Number.isFinite(g.p2.x) && Number.isFinite(g.p2.y)).toBe(true);
      expect(Number.isFinite(g.mid.x) && Number.isFinite(g.mid.y)).toBe(true);
    }
  });

  // F5: a finite-huge bend coord is clamped by readWaypoints (no MAX_VALUE bend into the path math).
  it('readWaypoints clamps a finite-huge bend coordinate', () => {
    const out = readWaypoints([{ x: Number.MAX_VALUE, y: -Number.MAX_VALUE }]);
    expect(out.length).toBe(1);
    expect(Math.abs(out[0].x)).toBeLessThanOrEqual(1e7);
    expect(Math.abs(out[0].y)).toBeLessThanOrEqual(1e7);
  });

  // F6: a caller that BYPASSED readWaypoints and passes a huge Pt[] directly is still bounded at the
  // connectorPath seam (defense-in-depth) → the emitted path threads at most MAX_WAYPOINTS bends.
  it('connectorPath bounds a bypassed huge waypoint array (defense-in-depth)', () => {
    const many: Pt[] = new Array(1_000_000).fill({ x: 1, y: 1 });
    expect(() => connectorPath('waypoints', A, B, undefined, undefined, many)).not.toThrow();
    const g = connectorPath('waypoints', A, B, undefined, undefined, many);
    const segs = (g.d.match(/L /g) ?? []).length; // chain = [p1, ...≤256 bends, p2] → ≤257 segments
    expect(segs).toBeLessThanOrEqual(257);
  });
});
