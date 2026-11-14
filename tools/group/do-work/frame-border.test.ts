// packages/group/do-work/frame-border.test.ts
//
// Pure proof of the ONE canonical frame-border reader. The whole point is that the
// live card render and the SVG export can no longer parse `frame.border` with two
// different schemas — both go through readFrameBorder, so these cases fix the wire
// contract for every surface at once.

import { describe, expect, it } from 'vitest';
import { readFrameBorder } from './frame-border';

describe('readFrameBorder — canonical border normalizer (SSOT)', () => {
  it('boolean false → hidden (the #90 show/hide toggle)', () => {
    expect(readFrameBorder(false)).toEqual({ show: false });
  });

  it('true / undefined / stray scalar → shown default chrome (no custom stroke)', () => {
    expect(readFrameBorder(true)).toEqual({ show: true });
    expect(readFrameBorder(undefined)).toEqual({ show: true });
    expect(readFrameBorder(1)).toEqual({ show: true });
    expect(readFrameBorder('solid')).toEqual({ show: true });
  });

  it('object {color,width} → shown custom stroke (the export form, now honored live too)', () => {
    expect(readFrameBorder({ color: '#ef4444', width: 3 })).toEqual({ show: true, color: '#ef4444', width: 3 });
    expect(readFrameBorder({ color: '#000' })).toEqual({ show: true, color: '#000' });
    expect(readFrameBorder({ width: 2 })).toEqual({ show: true, width: 2 });
  });

  it('explicit {show:false, …} → hidden but carries any data (future explicit hide)', () => {
    expect(readFrameBorder({ show: false, color: '#000', width: 4 })).toEqual({ show: false, color: '#000', width: 4 });
  });

  it('fail-soft: invalid color/width in the object are dropped, never a partial or throw', () => {
    expect(readFrameBorder({ color: 42, width: '3' })).toEqual({ show: true });
    expect(readFrameBorder({ color: '', width: 0 })).toEqual({ show: true });
    expect(readFrameBorder({ color: '#fff', width: Number.NaN })).toEqual({ show: true, color: '#fff' });
    expect(readFrameBorder({ width: -5 })).toEqual({ show: true });
    expect(readFrameBorder(null)).toEqual({ show: true });
  });
});
