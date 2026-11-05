// packages/group/show/write-focus-view-live.test.ts
import { describe, expect, it, vi } from '../../../../../test-helpers/vitest-shim.mjs';
import { writeFocusViewLive, buildFocusViewWriteItem } from '../../../show/write-focus-view-live.ts';
import { makeFocusView, readFocusViews } from '../../../show/focus-view.ts';

const view = makeFocusView('vid', 'Blue ideas', 'B1', { tag: ['idea'], colorFamily: ['Blue'] }, 'plan');

describe('writeFocusViewLive', () => {
  it('sends ONE write-batch and returns the written address on success (write_count 1)', async () => {
    const sender = vi.fn().mockResolvedValue(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0])); // u64 LE = 1
    const address = await writeFocusViewLive(view, 'part', sender);
    expect(address).toBe(buildFocusViewWriteItem(view).address);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('throws when the engine writes 0 records', async () => {
    const sender = vi.fn().mockResolvedValue(new Uint8Array(8)); // count 0
    await expect(writeFocusViewLive(view, 'part', sender)).rejects.toThrow(/could not be saved/);
  });

  it('the written payload round-trips into readFocusViews (scoped to its board)', () => {
    const item = buildFocusViewWriteItem(view);
    expect(readFocusViews([{ payload: item.payload }], 'B1')).toEqual([view]);
    expect(readFocusViews([{ payload: item.payload }], 'B2')).toEqual([]); // wrong board → not shown
  });
});
