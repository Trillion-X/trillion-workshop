// Proof for the ONE circle-layout radius SSOT + the drift fix (Codex arrange-audit F6): the
// selected-item Arrange menu (arrange-strategies `circle`) and the bulk-bar / ⌘K circle
// (batch-actions `radialPlacement`) must produce the SAME circle for the same selection. Both now
// derive their radius from circleLayoutRadius, so this pins (a) the formula and (b) that the menu
// circle's measured radius equals the SSOT for the pitch the bulk bar also uses.

import { describe, expect, it } from 'vitest';
import { circleLayoutRadius } from './circle-layout';
import { arrangeWith, type StrategyItem } from '../show/arrange-strategies';

describe('circleLayoutRadius — the shared radius SSOT', () => {
  it('radius = max(pitch, count*pitch/2π) — grows with the item count, floored at one pitch', () => {
    expect(circleLayoutRadius(1, 70)).toBe(70); // 1 item: floored to a single pitch
    expect(circleLayoutRadius(3, 70)).toBe(70); // 3*70/2π ≈ 33 < 70 → floored
    // a large ring is pitch-derived: 40 boxes of pitch 70 → circumference 2800 → r ≈ 445
    expect(circleLayoutRadius(40, 70)).toBeCloseTo((40 * 70) / (2 * Math.PI), 6);
    expect(circleLayoutRadius(40, 70)).toBeGreaterThan(70);
  });

  it('fail-safe on degenerate input (never NaN / never a point)', () => {
    expect(circleLayoutRadius(0, 70)).toBe(70); // count floored to 1 → one pitch
    expect(circleLayoutRadius(5, 0)).toBeGreaterThan(0); // pitch → 1
    expect(Number.isFinite(circleLayoutRadius(NaN, NaN))).toBe(true);
  });
});

describe('drift fix (F6): the Arrange-menu circle uses the SAME radius as the bulk-bar circle', () => {
  // Uniform boxes so pitch is unambiguous. Menu default (no explicit radius) must land every box
  // centre on a ring of radius circleLayoutRadius(n, maxDim+gap) — the exact pitch the bulk bar's
  // radialPlacement uses (pitch = max(colPitch,rowPitch) = maxDim+gap), so the two circles agree.
  const gap = 24;
  const items: StrategyItem[] = Array.from({ length: 12 }, (_, i) => ({ memberId: `m${i}`, w: 80, h: 50 }));
  const expectedRadius = circleLayoutRadius(items.length, 80 + gap); // maxDim=80, pitch=104

  it('every menu-circle box centre sits on the shared-SSOT ring (origin 0,0)', () => {
    const placed = arrangeWith('circle', items, { gap, originX: 0, originY: 0 });
    for (const p of placed) {
      const cx = p.x + 80 / 2;
      const cy = p.y + 50 / 2;
      expect(Math.hypot(cx, cy)).toBeCloseTo(expectedRadius, 6); // on the ring, radius = SSOT
    }
    // it's a real ring (not collapsed): distinct positions, radius well above a single pitch
    expect(expectedRadius).toBeGreaterThan(104);
    expect(new Set(placed.map((p) => p.x)).size).toBeGreaterThan(1);
  });

  it('an explicit radius override still wins (the SSOT is the DEFAULT, not a lock)', () => {
    const placed = arrangeWith('circle', items, { gap, originX: 0, originY: 0, radius: 500 });
    const cx = placed[0].x + 40;
    const cy = placed[0].y + 25;
    expect(Math.hypot(cx, cy)).toBeCloseTo(500, 6);
  });
});
