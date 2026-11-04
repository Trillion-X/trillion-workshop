// Proof for item content placement: a normalized anchor buckets each axis to start/center/end, the nine
// corners/edges/centre map to the right justify/align/text-align triples, a malformed coord falls back to
// start, and the DATA resolver accepts both a preset id and a raw {nx,ny} (anything else → null).
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { bucket, contentPlacement, contentAnchorFrom, CONTENT_ANCHORS } from '../../../do-work/content-placement.ts';

describe('content-placement — bucket', () => {
  it('buckets a normalized coordinate into three positions (0/1/2)', () => {
    expect(bucket(0)).toBe(0);
    expect(bucket(0.2)).toBe(0);
    expect(bucket(0.5)).toBe(1);
    expect(bucket(0.9)).toBe(2);
    expect(bucket(1)).toBe(2);
  });
  it('falls back to start for a non-finite coordinate (never NaN CSS)', () => {
    expect(bucket(NaN)).toBe(0);
    expect(bucket(Infinity)).toBe(0);
  });
});

describe('content-placement — contentPlacement', () => {
  it('top-left → start / start / left', () => {
    expect(contentPlacement(0, 0)).toEqual({ justifyContent: 'flex-start', alignItems: 'flex-start', textAlign: 'left' });
  });
  it('centre → center / center / center', () => {
    expect(contentPlacement(0.5, 0.5)).toEqual({ justifyContent: 'center', alignItems: 'center', textAlign: 'center' });
  });
  it('bottom-right → end / end / right', () => {
    expect(contentPlacement(1, 1)).toEqual({ justifyContent: 'flex-end', alignItems: 'flex-end', textAlign: 'right' });
  });
  it('top-right mixes the axes: vertical start, horizontal end', () => {
    // nx=1 → horizontal end (alignItems flex-end, text right); ny=0 → vertical start (justifyContent flex-start)
    expect(contentPlacement(1, 0)).toEqual({ justifyContent: 'flex-start', alignItems: 'flex-end', textAlign: 'right' });
  });
});

describe('content-placement — contentAnchorFrom', () => {
  it('resolves a preset id to its {nx,ny}', () => {
    expect(contentAnchorFrom('bottom-right')).toEqual({ nx: 1, ny: 1 });
    expect(contentAnchorFrom('center')).toEqual({ nx: 0.5, ny: 0.5 });
  });
  it('accepts a raw {nx,ny} anchor (a custom placement outside the nine presets)', () => {
    expect(contentAnchorFrom({ nx: 0.25, ny: 0.8 })).toEqual({ nx: 0.25, ny: 0.8 });
  });
  it('returns null for an unknown id, a non-object, or a missing coordinate', () => {
    expect(contentAnchorFrom('nope')).toBeNull();
    expect(contentAnchorFrom(undefined)).toBeNull();
    expect(contentAnchorFrom({ nx: 0.5 })).toBeNull();
  });
  it('ships exactly the nine grid presets, each resolving through the same primitive', () => {
    expect(CONTENT_ANCHORS).toHaveLength(9);
    for (const a of CONTENT_ANCHORS) {
      expect(contentPlacement(a.nx, a.ny)).toBeTruthy();
    }
  });
});
