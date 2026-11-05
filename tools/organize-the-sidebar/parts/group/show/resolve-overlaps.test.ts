import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { resolveOverlaps } from '../../../show/resolve-overlaps.ts';
import type { OverlapBox } from '../../../show/resolve-overlaps.ts';

const box = (memberId: string, x: number, y: number, w = 100, h = 60, pinned = false): OverlapBox => ({ memberId, x, y, w, h, pinned });

/** True if two boxes (top-left x/y + w/h) overlap given a gap. */
function overlaps(a: { x: number; y: number }, b: { x: number; y: number }, w: number, h: number, gap: number): boolean {
  const sepX = Math.abs(a.x + w / 2 - (b.x + w / 2)) >= w + gap - 1e-6;
  const sepY = Math.abs(a.y + h / 2 - (b.y + h / 2)) >= h + gap - 1e-6;
  return !(sepX || sepY);
}

describe('resolveOverlaps (cont.22 — nudge a pile apart, preserve the rough layout)', () => {
  it('separates two fully-overlapping boxes symmetrically (centroid preserved)', () => {
    const out = resolveOverlaps([box('a', 0, 0), box('b', 10, 0)], { gap: 10 });
    const p = Object.fromEntries(out.map((o) => [o.memberId, o]));
    // They were stacked (10px apart, need 110) → pushed apart along x, symmetric about the shared centre.
    expect(overlaps(p.a, p.b, 100, 60, 10)).toBe(false);
    // Centroid of the two centres is preserved: (cx_a+cx_b)/2 unchanged = (50 + 60)/2 = 55.
    expect((p.a.x + 50 + p.b.x + 50) / 2).toBeCloseTo(55, 4);
  });

  it('leaves already-separated boxes exactly where they are (minimal movement)', () => {
    const input = [box('a', 0, 0), box('b', 300, 0), box('c', 0, 300)];
    const out = resolveOverlaps(input, { gap: 12 });
    const p = Object.fromEntries(out.map((o) => [o.memberId, o]));
    expect(p.a).toMatchObject({ x: 0, y: 0 });
    expect(p.b).toMatchObject({ x: 300, y: 0 });
    expect(p.c).toMatchObject({ x: 0, y: 300 });
  });

  it('resolves a whole PILE (5 identical stacked boxes) to zero collisions', () => {
    const input = Array.from({ length: 5 }, (_, i) => box(`n${i}`, 0, 0, 80, 50)); // all on top of each other
    const out = resolveOverlaps(input, { gap: 8 });
    // Every pair must be separated.
    for (let i = 0; i < out.length; i += 1)
      for (let j = i + 1; j < out.length; j += 1)
        expect(overlaps(out[i], out[j], 80, 50, 8)).toBe(false);
    // Same member set, one position each.
    expect(out.map((o) => o.memberId).sort()).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
  });

  it('pushes along the axis of LEAST penetration (a small x-overlap resolves on x, not y)', () => {
    // Two wide-but-short boxes overlapping by a sliver horizontally, aligned vertically.
    const out = resolveOverlaps([box('a', 0, 0, 100, 40), box('b', 90, 0, 100, 40)], { gap: 6 });
    const p = Object.fromEntries(out.map((o) => [o.memberId, o]));
    // Should separate horizontally (y unchanged), because x-overlap (16) < y-overlap (46).
    expect(p.a.y).toBe(0);
    expect(p.b.y).toBe(0);
    expect(overlaps(p.a, p.b, 100, 40, 6)).toBe(false);
  });

  it('a PINNED box holds its position; the other takes the whole push', () => {
    const out = resolveOverlaps([box('anchor', 0, 0, 100, 60, true), box('mover', 20, 0, 100, 60)], { gap: 10 });
    const p = Object.fromEntries(out.map((o) => [o.memberId, o]));
    expect(p.anchor).toMatchObject({ x: 0, y: 0 }); // pinned → unmoved
    // The mover takes the FULL separation (here along the least-penetration axis, y — 70 < 90).
    const moverMoved = p.mover.x !== 20 || p.mover.y !== 0;
    expect(moverMoved).toBe(true);
    expect(overlaps(p.anchor, p.mover, 100, 60, 10)).toBe(false);
  });

  it('is deterministic — identical input yields identical output (index tie-break on exact stacks)', () => {
    const mk = () => [box('a', 0, 0), box('b', 0, 0), box('c', 0, 0)];
    expect(resolveOverlaps(mk())).toEqual(resolveOverlaps(mk()));
  });

  it('degenerate: empty and single-box inputs are returned unchanged', () => {
    expect(resolveOverlaps([])).toEqual([]);
    expect(resolveOverlaps([box('solo', 7, 9)])).toEqual([{ memberId: 'solo', x: 7, y: 9 }]);
  });

  it('terminates and fully separates a dense cluster of 20 boxes within the pass cap', () => {
    const input = Array.from({ length: 20 }, (_, i) => box(`n${i}`, (i % 4) * 10, Math.floor(i / 4) * 10, 90, 60));
    const out = resolveOverlaps(input, { gap: 6 });
    let collisions = 0;
    for (let i = 0; i < out.length; i += 1)
      for (let j = i + 1; j < out.length; j += 1)
        if (overlaps(out[i], out[j], 90, 60, 6)) collisions += 1;
    expect(collisions).toBe(0);
  });
});

describe('resolveOverlaps — sanitizes numeric options (cont.98 batch-7, no NaN positions)', () => {
  // `gap ?? 12` only catches null/undefined: a NaN gap would poison overlapX/overlapY into NaN,
  // `NaN <= EPS` is false, so the separation runs on NaN and every position becomes {NaN,NaN}.
  it('a NaN gap falls back to the default — positions stay finite', () => {
    const out = resolveOverlaps([box('a', 0, 0), box('b', 0, 0)], { gap: NaN as unknown as number, maxPasses: 50 });
    expect(out.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
});
