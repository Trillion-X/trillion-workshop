import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/packages/ui', async () => {
  const ReactModule = await import('react');
  const passthrough = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => ReactModule.createElement('div', props, children);
  return {
    Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => ReactModule.createElement('button', props, children),
    Card: passthrough,
    Container: passthrough,
    PlaceableSurfaceHost: vi.fn(() => ReactModule.createElement('div', null, 'Composer')),
    ScrollableSurface: passthrough,
    Text: passthrough,
  };
});

vi.mock('@/packages/item-record/do-work/read-item-record-feed', () => ({
  ITEM_RECORD_FEED_REFRESH_EVENT: 'item-record:changed',
  readItemRecordFeed: vi.fn(),
}));

import { readItemRecordFeed } from '@/packages/item-record/do-work/read-item-record-feed';
import { ItemFeed } from './ItemFeed';

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const surfaceInput = {
  scope_ref: 'community:one',
  empty_state: { title: 'No posts yet', body: 'Share the first court note.' },
  scene: {
    package_entry: { package_name: 'item-record', entry_name: 'item-composer' },
    surface_input: { scope_ref: 'community:one', target_ref: 'community:one', kind: 'post' },
  },
};

describe('ItemFeed', () => {
  it('renders DATA-authored empty copy when no scene is configured', () => {
    render(<ItemFeed surfaceInput={{ empty_state: { title: 'No posts yet', body: 'Share the first court note.' } }} />);
    expect(screen.getByText('No posts yet')).toBeTruthy();
    expect(screen.getByText('Share the first court note.')).toBeTruthy();
    expect(screen.queryByText('This view is not available right now.')).toBeNull();
  });

  it('renders durable subject posts from the shared feed reader', async () => {
    vi.mocked(readItemRecordFeed).mockResolvedValueOnce([
      { id: 'post-1', author: 'Julien', title: null, body: 'First practice note', when: '2026-09-24T10:00:00.000Z', role: 'primary', roleKey: 'post', kind: 'post', parentRef: null, categoryRef: null, targetRef: 'community:one', scopeRef: 'community:one', actorRef: 'private-actor-ref', revision: 1, idempotencyRef: 'one', fields: {}, pinned: false, imageUrl: null },
    ]);

    render(<ItemFeed surfaceInput={surfaceInput} />);

    expect(await screen.findByText('First practice note')).toBeTruthy();
    expect(screen.getByText('Julien')).toBeTruthy();
    expect(screen.getByText('1 post')).toBeTruthy();
    expect(readItemRecordFeed).toHaveBeenCalledWith('community:one');
    expect(screen.queryByText('private-actor-ref')).toBeNull();
  });

  it('rereads after another package entry announces a successful item write', async () => {
    vi.mocked(readItemRecordFeed).mockResolvedValue([]);
    render(<ItemFeed surfaceInput={surfaceInput} />);
    await screen.findByText('Share the first court note.');
    expect(readItemRecordFeed).toHaveBeenCalledTimes(1);

    await act(async () => { globalThis.dispatchEvent(new Event('item-record:changed')); });
    expect(readItemRecordFeed).toHaveBeenCalledTimes(2);
  });
});
