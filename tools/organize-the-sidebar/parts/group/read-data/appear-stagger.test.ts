// packages/group/read-data/appear-stagger.test.ts
//
// Proves the live piece-by-piece entrance logic: items present on first paint do NOT
// cascade; only genuinely-new ids (a producer landing many at once, a paste) get an
// increasing delay in board order, capped so a huge batch never drags on forever.

import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { APPEAR_MAX_STEPS, APPEAR_STEP_MS, computeAppearDelays } from '../../../read-data/appear-stagger.ts';

describe('computeAppearDelays — live piece-by-piece entrance', () => {
  it('first paint (no previous set) → NOTHING cascades (board opens instant)', () => {
    const delays = computeAppearDelays(['a', 'b', 'c'], null);
    expect(delays.size).toBe(0);
  });

  it('no new ids since last commit → empty (a re-render that added nothing is silent)', () => {
    const prev = new Set(['a', 'b', 'c']);
    expect(computeAppearDelays(['a', 'b', 'c'], prev).size).toBe(0);
  });

  it('a batch of new ids cascades in board order (0, step, 2·step …)', () => {
    const prev = new Set(['a']); // only "a" was here; a producer just landed 3 notes
    const delays = computeAppearDelays(['a', 'n1', 'n2', 'n3'], prev);
    expect(delays.get('a')).toBeUndefined(); // already present → no entrance
    expect(delays.get('n1')).toBe(0);
    expect(delays.get('n2')).toBe(APPEAR_STEP_MS);
    expect(delays.get('n3')).toBe(APPEAR_STEP_MS * 2);
  });

  it('only the NEW ids get a delay; pre-existing ones are skipped in the ordering', () => {
    const prev = new Set(['a', 'b']);
    // new items interleaved among old → order counts only the new ones
    const delays = computeAppearDelays(['a', 'x', 'b', 'y'], prev);
    expect(delays.get('a')).toBeUndefined();
    expect(delays.get('b')).toBeUndefined();
    expect(delays.get('x')).toBe(0);
    expect(delays.get('y')).toBe(APPEAR_STEP_MS);
  });

  it('the cascade tail is capped so a giant batch never delays the last item for seconds', () => {
    const prev = new Set<string>();
    const ids = Array.from({ length: 30 }, (_, i) => `id${i}`);
    const delays = computeAppearDelays(ids, prev);
    const maxDelay = Math.max(...[...delays.values()]);
    expect(maxDelay).toBe(APPEAR_MAX_STEPS * APPEAR_STEP_MS);
    // every id past the cap shares the max delay (they appear together, not later)
    expect(delays.get('id29')).toBe(APPEAR_MAX_STEPS * APPEAR_STEP_MS);
    expect(delays.get(`id${APPEAR_MAX_STEPS}`)).toBe(APPEAR_MAX_STEPS * APPEAR_STEP_MS);
  });
});
