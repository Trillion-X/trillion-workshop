// Proof for the board-geometry sanitization SSOT. A real coordinate passes through
// byte-identical (no-op); a non-finite one falls back; a finite-huge one is clamped so
// downstream sums can never overflow to Infinity.
import { describe, expect, it } from 'vitest';
import { BOARD_COORD_LIMIT, finiteCoord } from './finite-coord';

describe('finiteCoord — board-geometry sanitization SSOT', () => {
  it('is a NO-OP for a real coordinate (within the sanity bound)', () => {
    expect(finiteCoord(0)).toBe(0);
    expect(finiteCoord(-500)).toBe(-500);
    expect(finiteCoord(1328.6)).toBe(1328.6);
    expect(finiteCoord(BOARD_COORD_LIMIT)).toBe(BOARD_COORD_LIMIT);
    expect(finiteCoord(-BOARD_COORD_LIMIT)).toBe(-BOARD_COORD_LIMIT);
  });

  it('falls back for a non-finite input (NaN / ±Infinity)', () => {
    expect(finiteCoord(NaN)).toBe(0);
    expect(finiteCoord(Infinity)).toBe(0);
    expect(finiteCoord(-Infinity)).toBe(0);
    expect(finiteCoord(NaN, 64)).toBe(64); // custom fallback
  });

  it('clamps a finite-but-HUGE input so downstream arithmetic cannot overflow', () => {
    expect(finiteCoord(Number.MAX_VALUE)).toBe(BOARD_COORD_LIMIT);
    expect(finiteCoord(-Number.MAX_VALUE)).toBe(-BOARD_COORD_LIMIT);
    expect(finiteCoord(1e300)).toBe(BOARD_COORD_LIMIT);
    // the key property: a clamped coord + a clamped coord is FINITE (the overflow this exists to stop).
    expect(Number.isFinite(finiteCoord(Number.MAX_VALUE) + finiteCoord(Number.MAX_VALUE))).toBe(true);
  });
});
