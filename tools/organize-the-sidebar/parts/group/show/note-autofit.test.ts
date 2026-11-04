// packages/group/show/note-autofit.test.ts
// #217 — the note-height derivation math.

import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { fitNoteHeight, noteHeightChanged } from '../../../show/note-autofit.ts';

describe('fitNoteHeight', () => {
  it('grows to the content height plus chrome', () => {
    expect(fitNoteHeight(1328, { minH: 64, chrome: 24 })).toBe(1352);
  });

  it('floors at minH for short content', () => {
    expect(fitNoteHeight(20, { minH: 64 })).toBe(64);
  });

  it('caps at maxH for a runaway paste', () => {
    expect(fitNoteHeight(9000, { minH: 64, maxH: 2000 })).toBe(2000);
  });

  it('rounds a fractional measurement', () => {
    expect(fitNoteHeight(160.4, { minH: 64 })).toBe(160);
    expect(fitNoteHeight(160.6, { minH: 64 })).toBe(161);
  });

  it('returns null for a non-positive / non-finite measurement (keep current size)', () => {
    expect(fitNoteHeight(0)).toBeNull();
    expect(fitNoteHeight(-10)).toBeNull();
    expect(fitNoteHeight(NaN)).toBeNull();
    expect(fitNoteHeight(Infinity)).toBeNull();
  });

  it('uses sane defaults (minH 64, no chrome, no cap)', () => {
    expect(fitNoteHeight(500)).toBe(500);
    expect(fitNoteHeight(10)).toBe(64);
  });

  it('a non-finite minH (from a malformed item.h) falls back to the default — never emits NaN (cont.98 batch-10)', () => {
    // The call site passes `{ minH: item.h }`; a malformed item with a NaN height would make
    // Math.max(NaN, …) NaN → the leaf emits a NaN height. `?? 64` does NOT catch NaN; the finite guard does.
    expect(fitNoteHeight(500, { minH: NaN })).toBe(500); // content taller than the 64 default → content wins
    expect(fitNoteHeight(10, { minH: NaN })).toBe(64); // short content → floored at the 64 default
    expect(Number.isFinite(fitNoteHeight(500, { minH: Infinity }) as number)).toBe(true);
  });
});

describe('noteHeightChanged', () => {
  it('true when the derived height differs beyond the threshold', () => {
    expect(noteHeightChanged(160, 1352)).toBe(true);
  });

  it('false for sub-threshold jitter (converged — no re-write)', () => {
    expect(noteHeightChanged(200, 201)).toBe(false); // 1px < 2px threshold
    expect(noteHeightChanged(200, 200)).toBe(false);
  });

  it('false when the fit is null (nothing measured)', () => {
    expect(noteHeightChanged(160, null)).toBe(false);
  });

  it('respects a custom threshold', () => {
    expect(noteHeightChanged(200, 205, 10)).toBe(false);
    expect(noteHeightChanged(200, 215, 10)).toBe(true);
  });
});
