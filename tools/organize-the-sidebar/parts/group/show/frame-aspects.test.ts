// packages/group/show/frame-aspects.test.ts
//
// Pure proof for the frame-aspect catalog (#177) — the DATA the blind picker renders.
// Guards the invariants the picker + `resizeToAspect` rely on: unique ids, positive
// ratio terms, and a working id → entry lookup.

import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { FRAME_ASPECTS, frameAspectById } from '../../../show/frame-aspects.ts';

describe('FRAME_ASPECTS catalog', () => {
  it('has unique ids', () => {
    const ids = FRAME_ASPECTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a non-blank label and strictly-positive ratio terms for every entry', () => {
    for (const a of FRAME_ASPECTS) {
      expect(a.label.trim().length).toBeGreaterThan(0);
      expect(a.w).toBeGreaterThan(0);
      expect(a.h).toBeGreaterThan(0);
    }
  });

  it('includes the core slide/print ratios', () => {
    const ids = new Set(FRAME_ASPECTS.map((a) => a.id));
    for (const want of ['16:9', '4:3', '1:1', 'a4']) expect(ids.has(want)).toBe(true);
  });
});

describe('frameAspectById', () => {
  it('resolves a known id to its entry', () => {
    expect(frameAspectById('16:9')?.w).toBe(16);
    expect(frameAspectById('a4')?.h).toBe(297);
  });

  it('returns null for an unknown or empty id', () => {
    expect(frameAspectById('nope')).toBeNull();
    expect(frameAspectById(undefined)).toBeNull();
    expect(frameAspectById('')).toBeNull();
  });
});
