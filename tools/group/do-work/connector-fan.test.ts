// Proof for parallel multi-edge fan-out: coincident-endpoint bundles fan into symmetric signed lanes
// (direction-agnostic pairing), singletons and self-loops stay at lane 0, and a nonzero lane bows the
// chord into a quadratic whose peak sits on the correct side while a zero lane stays a straight segment.
import { describe, expect, it } from 'vitest';
import { pairKey, fanLaneMultipliers, bowedChord, FAN_SPACING, type FanEdge } from 'trillion-workshop/tools/organize-the-sidebar/do-work/connector-fan.ts';
import type { Pt } from './connector-geometry';

const P = (x: number, y: number): Pt => ({ x, y });
const e = (id: string, from: string, to: string): FanEdge => ({ id, from, to });

describe('connector-fan — pairKey', () => {
  it('is direction-agnostic: A→B and B→A share a key', () => {
    expect(pairKey('a', 'b')).toBe(pairKey('b', 'a'));
    expect(pairKey('a', 'b')).not.toBe(pairKey('a', 'c'));
  });
});

describe('connector-fan — fanLaneMultipliers', () => {
  it('leaves a lone edge on its pair at lane 0 (absent → caller reads 0)', () => {
    const m = fanLaneMultipliers([e('x', 'a', 'b')]);
    expect(m.has('x')).toBe(false);
  });

  it('fans a pair symmetrically to [-0.5, +0.5], ordered by id', () => {
    const m = fanLaneMultipliers([e('e2', 'a', 'b'), e('e1', 'a', 'b')]);
    expect(m.get('e1')).toBe(-0.5); // e1 sorts first → the negative lane
    expect(m.get('e2')).toBe(0.5);
  });

  it('fans a triple to [-1, 0, +1] (the middle edge stays straight)', () => {
    const m = fanLaneMultipliers([e('c', 'a', 'b'), e('a', 'a', 'b'), e('b', 'a', 'b')]);
    expect(m.get('a')).toBe(-1);
    expect(m.get('b')).toBe(0);
    expect(m.get('c')).toBe(1);
  });

  it('pairs regardless of stored direction (a→b and b→a are ONE bundle of two)', () => {
    const m = fanLaneMultipliers([e('e1', 'a', 'b'), e('e2', 'b', 'a')]);
    expect(m.get('e1')).toBe(-0.5);
    expect(m.get('e2')).toBe(0.5);
  });

  it('keeps separate pairs independent (a-b bundle does not fan the a-c singleton)', () => {
    const m = fanLaneMultipliers([e('e1', 'a', 'b'), e('e2', 'a', 'b'), e('solo', 'a', 'c')]);
    expect(m.get('e1')).toBe(-0.5);
    expect(m.get('e2')).toBe(0.5);
    expect(m.has('solo')).toBe(false);
  });

  it('never fans a self-loop (from === to is not a parallel bundle)', () => {
    const m = fanLaneMultipliers([e('loop1', 'a', 'a'), e('loop2', 'a', 'a')]);
    expect(m.has('loop1')).toBe(false);
    expect(m.has('loop2')).toBe(false);
  });
});

describe('connector-fan — bowedChord', () => {
  it('lane 0 → a straight segment (byte-identical to straight routing)', () => {
    const { d, mid } = bowedChord(P(0, 0), P(100, 0), 0);
    expect(d).toBe('M 0 0 L 100 0');
    expect(mid).toEqual(P(50, 0));
  });

  it('a positive offset bows a horizontal chord (a quadratic whose peak is offset off the line)', () => {
    const { d, mid } = bowedChord(P(0, 0), P(100, 0), FAN_SPACING * 0.5); // +13px
    expect(d.includes(' Q ')).toBe(true);
    expect(d.startsWith('M 0 0')).toBe(true);
    expect(d.endsWith('100 0')).toBe(true);
    // perpendicular of a left→right chord points +y; peak ≈ offset below the line.
    expect(mid.x).toBe(50);
    expect(mid.y).toBeCloseTo(13, 5);
  });

  it('flips the bow side with the sign of the offset', () => {
    const up = bowedChord(P(0, 0), P(100, 0), -13);
    const down = bowedChord(P(0, 0), P(100, 0), 13);
    expect(up.mid.y).toBeCloseTo(-13, 5);
    expect(down.mid.y).toBeCloseTo(13, 5);
  });
});
