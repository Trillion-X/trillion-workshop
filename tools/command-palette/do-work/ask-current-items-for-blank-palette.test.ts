import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  askCurrentItemsForBlankPalette,
  makeListCurrentItemsRequest,
} from './ask-current-items-ranked-by-text';

vi.mock('#workspace-records', () => ({ sendRequestToBitfieldTarget: vi.fn() }));
import { sendRequestToBitfieldTarget } from '#workspace-records';

describe('blank command palette listing', () => {
  beforeEach(() => vi.mocked(sendRequestToBitfieldTarget).mockReset());

  it('asks only the bounded current-item listing owner', async () => {
    vi.mocked(sendRequestToBitfieldTarget).mockResolvedValueOnce({ items: [] });
    await askCurrentItemsForBlankPalette(12);
    expect(sendRequestToBitfieldTarget).toHaveBeenCalledWith({
      target: 'slot::find-current-items',
      payload: { operation: 'find-current-items', in: 'published-record', limit: 12 },
    }, undefined);
  });

  it('has no text parameter and cannot become a nonblank fetch-all path', () => {
    expect(makeListCurrentItemsRequest(7)).toEqual({
      operation: 'find-current-items', in: 'published-record', limit: 7,
    });
    expect(Object.keys(makeListCurrentItemsRequest(7))).not.toContain('query');
  });
});
