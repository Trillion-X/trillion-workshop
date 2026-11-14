// Proof for arrowhead-shape-as-DATA: the triangle default is byte-identical to the old hardcoded marker,
// every shape carries a renderable path (except the `none` sentinel), unknown/absent ids fall back to
// triangle, and the picker options derive from the catalog SSOT with '' meaning the triangle default.
import { describe, expect, it } from 'vitest';
import { CONNECTOR_ARROWHEADS, arrowheadById, CONNECTOR_ARROWHEAD_OPTIONS } from './arrowhead-catalog';

describe('arrowhead-catalog', () => {
  it('triangle is the default and is byte-identical to the pre-b94 hardcoded marker', () => {
    const t = arrowheadById('triangle');
    expect(t.id).toBe('triangle');
    expect(t.path).toBe('M 0 0 L 10 5 L 0 10 z'); // exact old marker path
    expect(t.refX).toBe(8.5);
    expect(t.filled).toBe(true);
    // triangle is the FIRST row, so it is also the fallback.
    expect(CONNECTOR_ARROWHEADS[0].id).toBe('triangle');
  });

  it('falls back to triangle for an unknown or absent id', () => {
    expect(arrowheadById('galaxy').id).toBe('triangle');
    expect(arrowheadById(undefined).id).toBe('triangle');
  });

  it('every shape except `none` carries a renderable path; none is the empty sentinel', () => {
    for (const s of CONNECTOR_ARROWHEADS) {
      if (s.id === 'none') expect(s.path).toBe('');
      else expect(s.path.length).toBeGreaterThan(0);
    }
    expect(CONNECTOR_ARROWHEADS.some((s) => s.id === 'none')).toBe(true);
  });

  it('a filled shape is not stroked and vice-versa (the paint model is unambiguous)', () => {
    const open = arrowheadById('open');
    const diamond = arrowheadById('diamond');
    expect(open.stroked && !open.filled).toBe(true); // open chevron = outline
    expect(diamond.filled && !diamond.stroked).toBe(true); // diamond = solid
  });

  it('picker options derive from the catalog SSOT, with the triangle default as the blank value', () => {
    expect(CONNECTOR_ARROWHEAD_OPTIONS.length).toBe(CONNECTOR_ARROWHEADS.length);
    expect(CONNECTOR_ARROWHEAD_OPTIONS[0]).toEqual({ value: '', label: 'Triangle' });
    expect(CONNECTOR_ARROWHEAD_OPTIONS.some((o) => o.value === 'diamond')).toBe(true);
  });
});
