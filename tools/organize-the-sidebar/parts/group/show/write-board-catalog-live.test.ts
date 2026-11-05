// packages/group/show/write-board-catalog-live.test.ts
// R44 add-your-own: the generic catalog-item writer. Verifies the published-record shape
// round-trips into the matching mergeCatalog reader (a custom stamp appears in the stamp
// picker), and the live write is one write-batch (injectable sender, studio-independent).
import { describe, it, expect, vi } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  buildBoardCatalogWriteItem,
  writeBoardCatalogItemLive,
  type BoardCatalogDescriptor,
} from '../../../show/write-board-catalog-live.ts';
import { readStampCatalog, BOARD_STAMPS, STAMP_CATALOG_KIND } from '../../../show/board-stamps.ts';

const STAMP_DESC: BoardCatalogDescriptor = {
  kind: STAMP_CATALOG_KIND,
  arrayKey: 'stamps',
  addressPrefix: 'package::group::published-record::stamp::',
};
const customStamp = { id: 'cat-1', label: '🦄', emoji: '🦄' };

describe('buildBoardCatalogWriteItem — the published-record shape', () => {
  it('writes a one-row {kind, [arrayKey]:[item]} record at a per-item address', () => {
    const item = buildBoardCatalogWriteItem(STAMP_DESC, customStamp);
    expect(item.address).toBe('package::group::published-record::stamp::cat-1');
    expect(item.path).toEqual(['current-item', 'published-record']);
    expect(item.payload).toEqual({ kind: STAMP_CATALOG_KIND, stamps: [customStamp] });
  });

  it('ROUND-TRIPS: the written stamp merges back into the stamp picker (add → appears)', () => {
    const item = buildBoardCatalogWriteItem(STAMP_DESC, customStamp);
    const catalog = readStampCatalog([{ payload: item.payload }]);
    expect(catalog).toHaveLength(BOARD_STAMPS.length + 1);
    const added = catalog.find((s) => s.id === 'cat-1');
    expect(added).toBeTruthy();
    expect(added!.emoji).toBe('🦄');
  });
});

describe('writeBoardCatalogItemLive — the live write (injectable sender)', () => {
  it('sends ONE write-batch and returns the address when the engine accepts it', async () => {
    const sender = vi.fn().mockResolvedValue({ write_count: 1 });
    const address = await writeBoardCatalogItemLive(STAMP_DESC, customStamp, 'runtime-partition', sender);
    expect(address).toBe('package::group::published-record::stamp::cat-1');
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('throws when the engine rejects the write (write count !== 1)', async () => {
    const sender = vi.fn().mockResolvedValue({ write_count: 0 });
    await expect(writeBoardCatalogItemLive(STAMP_DESC, customStamp, 'runtime-partition', sender)).rejects.toThrow(/could not be saved/);
  });
});
