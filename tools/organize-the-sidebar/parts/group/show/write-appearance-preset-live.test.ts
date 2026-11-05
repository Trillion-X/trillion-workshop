// packages/group/show/write-appearance-preset-live.test.ts
import { describe, it, expect, vi } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  buildAppearancePresetWriteItem,
  writeAppearancePresetLive,
  APPEARANCE_PRESET_ADDRESS_PREFIX,
} from '../../../show/write-appearance-preset-live.ts';
import { makeAppearancePreset } from '../../../show/appearance-presets.ts';
import { readAppearancePresetCatalog, BUILT_IN_APPEARANCE_PRESETS } from '../../../show/appearance-preset-catalog.ts';

const look = makeAppearancePreset('look-1', 'My Flow', { containerVariant: 'elevated', connectorRouting: 'elbow' });

describe('buildAppearancePresetWriteItem — the published-record shape', () => {
  it('writes a one-preset appearance-preset-catalog record at a per-record address', () => {
    const item = buildAppearancePresetWriteItem(look);
    expect(item.address).toBe(`${APPEARANCE_PRESET_ADDRESS_PREFIX}my-flow-look-1`); // slug + id
    expect(item.path).toEqual(['current-item', 'published-record']);
    expect(item.payload).toEqual({ kind: 'appearance-preset-catalog', presets: [look] });
  });

  it('ROUND-TRIPS: the written record merges back into the picker catalog (save → appears in Board look)', () => {
    const item = buildAppearancePresetWriteItem(look);
    // The catalog reads published-records by KIND (any address) → the saved look joins the built-ins.
    const catalog = readAppearancePresetCatalog([{ payload: item.payload }]);
    expect(catalog).toHaveLength(BUILT_IN_APPEARANCE_PRESETS.length + 1);
    const saved = catalog.find((p) => p.id === 'look-1');
    expect(saved).toBeTruthy();
    expect(saved!.name).toBe('My Flow');
    expect(saved!.profile).toEqual({ containerVariant: 'elevated', connectorRouting: 'elbow' });
  });
});

describe('writeAppearancePresetLive — the live write (injectable sender, studio-independent)', () => {
  it('sends ONE write-batch and returns the address when the engine accepts it', async () => {
    const sender = vi.fn().mockResolvedValue({ write_count: 1 });
    const address = await writeAppearancePresetLive(look, 'runtime-partition', sender);
    expect(address).toBe(buildAppearancePresetWriteItem(look).address); // uses the right per-record address
    expect(sender).toHaveBeenCalledTimes(1);
    // The request targets the engine write-batch (address hashed + payload encoded to bytes by the
    // protocol builder — the address correctness is covered by the buildAppearancePresetWriteItem test).
    const req = sender.mock.calls[0][0] as { target: string; payload: unknown };
    expect(typeof req.target).toBe('string');
    expect(req.payload).toBeDefined();
  });

  it('throws when the engine rejects the write (write count ≠ 1)', async () => {
    const sender = vi.fn().mockResolvedValue({ write_count: 0 });
    await expect(writeAppearancePresetLive(look, 'runtime-partition', sender)).rejects.toThrow(/could not be saved/);
  });

  it('decodes the raw 8-byte u64 little-endian reply the live engine returns', async () => {
    const one = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]); // write_count = 1, LE
    const sender = vi.fn().mockResolvedValue(one);
    await expect(writeAppearancePresetLive(look, 'runtime-partition', sender)).resolves.toContain('look-1');
  });
});
