/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../ui/show/media-bytes/read-guarded-artifact-blob', () => ({
  readGuardedArtifactObjectUrl: vi.fn(),
}));

import { boardMediaSource, rendererForKind } from './item-renderers';
import { readGuardedArtifactObjectUrl } from '../../ui/show/media-bytes/read-guarded-artifact-blob';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const Media = rendererForKind('media');
const mediaItem = (src: string, extra: Record<string, unknown> = {}): BoardItem => (
  { kind: 'media', memberId: 'media:1', x: 0, y: 0, w: 240, h: 160, text: 'Proof', src, extra } as unknown as BoardItem
);
const delivery = (url = 'blob:verified') => ({
  bytes: new Uint8Array([1]), blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
  url, mediaType: 'image/png', displayName: 'proof.png', revoke: vi.fn(),
});

describe('board media source boundary', () => {
  it('accepts only opaque relation identities or ordinary public/blob browser URLs', () => {
    expect(boardMediaSource('package::content-media-evidence::relation::scope::proof')).toEqual({ kind: 'guarded-relation', relationRef: 'package::content-media-evidence::relation::scope::proof' });
    expect(boardMediaSource('https://media.example/proof.png')).toEqual({ kind: 'public-url', url: 'https://media.example/proof.png' });
    expect(boardMediaSource('blob:session-proof')).toEqual({ kind: 'public-url', url: 'blob:session-proof' });
    expect(boardMediaSource('cas:raw-coordinate')).toEqual({ kind: 'unavailable' });
    expect(boardMediaSource('artifact::raw-coordinate')).toEqual({ kind: 'unavailable' });
    expect(boardMediaSource('legacy-opaque-value')).toEqual({ kind: 'unavailable' });
  });
});

describe('relation-backed board media', () => {
  it('reads a relation through the shared guard before passing its ephemeral URL to MediaFrame', async () => {
    const opened = delivery();
    vi.mocked(readGuardedArtifactObjectUrl).mockResolvedValue(opened);
    const { container } = render(<Media item={mediaItem('package::content-media-evidence::relation::scope::proof')} selected={false} />);
    expect(screen.getByText('Loading media…')).toBeTruthy();
    await waitFor(() => expect(container.querySelector('img[src="blob:verified"]')).toBeTruthy());
    expect(readGuardedArtifactObjectUrl).toHaveBeenCalledWith('package::content-media-evidence::relation::scope::proof', expect.any(Function));
  });

  it.each(['denied access', 'stale access decision', 'tampered delivery'])('fails closed when the guarded read rejects for %s', async (reason) => {
    vi.mocked(readGuardedArtifactObjectUrl).mockRejectedValue(new Error(reason));
    const { container } = render(<Media item={mediaItem('package::content-media-evidence::relation::scope::proof')} selected={false} />);
    await waitFor(() => expect(screen.getByText('Media could not be safely displayed.')).toBeTruthy());
    expect(container.querySelector('img, video, audio')).toBeNull();
  });

  it('revokes a guarded object URL when the relation-backed media unmounts', async () => {
    const opened = delivery('blob:revoke-me');
    vi.mocked(readGuardedArtifactObjectUrl).mockResolvedValue(opened);
    const mounted = render(<Media item={mediaItem('package::content-media-evidence::relation::scope::proof')} selected={false} />);
    await waitFor(() => expect(screen.getByRole('img')).toBeTruthy());
    mounted.unmount();
    expect(opened.revoke).toHaveBeenCalledTimes(1);
  });

  it('revokes the prior guarded object URL before reading a replacement relation', async () => {
    const first = delivery('blob:first');
    const second = delivery('blob:second');
    vi.mocked(readGuardedArtifactObjectUrl)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const mounted = render(<Media item={mediaItem('package::content-media-evidence::relation::scope::first')} selected={false} />);
    await waitFor(() => expect(screen.getByRole('img')).toBeTruthy());
    mounted.rerender(<Media item={mediaItem('package::content-media-evidence::relation::scope::second')} selected={false} />);
    await waitFor(() => expect(first.revoke).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:second'));
  });

  it('keeps ordinary public media on the direct safe-media path', () => {
    const { container } = render(<Media item={mediaItem('https://media.example/proof.png')} selected={false} />);
    expect(readGuardedArtifactObjectUrl).not.toHaveBeenCalled();
    expect(container.querySelector('img[src="https://media.example/proof.png"]')).toBeTruthy();
  });

  it('never presents a raw CAS-looking coordinate', () => {
    const { container } = render(<Media item={mediaItem('cas:raw-coordinate')} selected={false} />);
    expect(readGuardedArtifactObjectUrl).not.toHaveBeenCalled();
    expect(screen.getByText('Media could not be safely displayed.')).toBeTruthy();
    expect(container.querySelector('img, video, audio')).toBeNull();
  });

  it('does not reinterpret arbitrary non-URL source text as a guarded-storage request', () => {
    render(<Media item={mediaItem('legacy-opaque-value')} selected={false} />);
    expect(readGuardedArtifactObjectUrl).not.toHaveBeenCalled();
    expect(screen.getByText('Media could not be safely displayed.')).toBeTruthy();
  });
});
