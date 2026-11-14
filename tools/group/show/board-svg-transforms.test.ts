import { describe, it, expect } from 'vitest';
import { svgItemTransform, svgCropImageRect, svgImageFilter } from './board-svg-transforms';

const box = (extra?: Record<string, unknown>) => ({ x: 100, y: 200, w: 80, h: 40, extra });
// center of the box above = (140, 220)

describe('svgItemTransform', () => {
  it('returns identity ("") when there is no rotation and no flip (zero-diff guarantee)', () => {
    expect(svgItemTransform(box())).toBe('');
    expect(svgItemTransform(box({ href: 'x' }))).toBe('');
    expect(svgItemTransform(box({ rotation: 0, flipX: false, flipY: false }))).toBe('');
  });

  it('emits rotate about the item center for a rotation', () => {
    expect(svgItemTransform(box({ rotation: 30 }))).toBe('rotate(30 140 220)');
  });

  it('emits a center-scale for flipX / flipY / both', () => {
    expect(svgItemTransform(box({ flipX: true }))).toBe('translate(140 220) scale(-1 1) translate(-140 -220)');
    expect(svgItemTransform(box({ flipY: true }))).toBe('translate(140 220) scale(1 -1) translate(-140 -220)');
    expect(svgItemTransform(box({ flipX: true, flipY: true }))).toBe('translate(140 220) scale(-1 -1) translate(-140 -220)');
  });

  it('composes rotate THEN flip (rotate outer, scale inner — matches live right-to-left)', () => {
    expect(svgItemTransform(box({ rotation: 45, flipX: true }))).toBe(
      'rotate(45 140 220) translate(140 220) scale(-1 1) translate(-140 -220)',
    );
  });

  it('ignores a non-finite / non-number rotation', () => {
    expect(svgItemTransform(box({ rotation: Number.NaN }))).toBe('');
    expect(svgItemTransform(box({ rotation: '30' as unknown as number }))).toBe('');
  });

  it('treats only strict boolean true as a flip (not truthy)', () => {
    expect(svgItemTransform(box({ flipX: 1 as unknown as boolean }))).toBe('');
  });
});

describe('svgCropImageRect', () => {
  it('returns the plain item rect when there is no crop', () => {
    expect(svgCropImageRect(undefined, 100, 200, 80, 40)).toEqual({ x: 100, y: 200, w: 80, h: 40 });
  });

  it('returns the plain item rect for a full crop (render as if uncropped)', () => {
    expect(svgCropImageRect({ x: 0, y: 0, w: 1, h: 1 }, 100, 200, 80, 40)).toEqual({ x: 100, y: 200, w: 80, h: 40 });
  });

  it('enlarges + offsets the image so only the crop window shows through the clip', () => {
    // crop the middle half {0.25,0.25,0.5,0.5}: image is 2x the frame, shifted up-left by half a frame.
    expect(svgCropImageRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 100, 200, 80, 40)).toEqual({
      x: 100 - 0.5 * 80, // 60
      y: 200 - 0.5 * 40, // 180
      w: 160,
      h: 80,
    });
  });

  it('is byte-identical to the plain rect at the {0,0,1,1} boundary (matches svgItemTransform identity contract)', () => {
    expect(svgCropImageRect({ x: 0, y: 0, w: 1, h: 1 }, 0, 0, 300, 300)).toEqual({ x: 0, y: 0, w: 300, h: 300 });
  });

  it('rejects an invalid (zero/negative-size) crop → plain rect', () => {
    expect(svgCropImageRect({ x: 0, y: 0, w: 0, h: 1 }, 10, 10, 50, 50)).toEqual({ x: 10, y: 10, w: 50, h: 50 });
  });
});

describe('svgImageFilter', () => {
  it('reads a non-empty CSS filter string', () => {
    expect(svgImageFilter(box({ imageFilter: 'saturate(1.4) contrast(1.1)' }))).toBe('saturate(1.4) contrast(1.1)');
  });

  it('is empty for absent / blank / non-string filters', () => {
    expect(svgImageFilter(box())).toBe('');
    expect(svgImageFilter(box({ imageFilter: '   ' }))).toBe('');
    expect(svgImageFilter(box({ imageFilter: 42 as unknown as string }))).toBe('');
  });
});

describe('geometry sanitization — a malformed rect never serializes Infinity/NaN into SVG (cont.98 batch-12)', () => {
  const hasNonFinite = (s: string) => /Infinity|NaN/.test(s);

  it('svgItemTransform: a finite-HUGE rect stays a valid finite rotate (no Infinity in the transform)', () => {
    // x + w with Number.MAX_VALUE overflowed cx to Infinity -> `rotate(30 Infinity Infinity)` = invalid SVG
    // that breaks the ENTIRE export. finiteCoord clamps the rect first.
    const t = svgItemTransform({ x: Number.MAX_VALUE, y: 0, w: Number.MAX_VALUE, h: 10, extra: { rotation: 30 } });
    expect(hasNonFinite(t)).toBe(false);
    expect(t.startsWith('rotate(30 ')).toBe(true);
  });

  it('svgItemTransform: a NaN rect coordinate does not poison the transform', () => {
    const t = svgItemTransform({ x: NaN, y: 0, w: 80, h: 40, extra: { flipX: true } });
    expect(hasNonFinite(t)).toBe(false);
  });

  it('svgItemTransform: a normal rect is BYTE-IDENTICAL (zero regression)', () => {
    expect(svgItemTransform(box({ rotation: 30 }))).toBe('rotate(30 140 220)');
  });

  it('svgCropImageRect: a finite-huge item rect yields a finite <image> rect', () => {
    const r = svgCropImageRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 0, 0, Number.MAX_VALUE, 10);
    expect(Number.isFinite(r.x)).toBe(true);
    expect(Number.isFinite(r.y)).toBe(true);
    expect(Number.isFinite(r.w)).toBe(true);
    expect(Number.isFinite(r.h)).toBe(true);
  });

  it('svgCropImageRect: a normal uncropped rect is byte-identical (full/absent crop -> plain rect)', () => {
    expect(svgCropImageRect(undefined, 100, 200, 80, 40)).toEqual({ x: 100, y: 200, w: 80, h: 40 });
  });
});
