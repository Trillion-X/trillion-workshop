// @vitest-environment jsdom
// packages/public-scene-share/show/share-surface-scope.test.tsx
//
// Proves the Share surface's SCOPE picker is DATA-driven and wired:
// • it lists the live scene's top-level roots (read via the injected io) plus an
//   always-present "Everything" — never a hardcoded node id;
// • choosing a root carries that root's id into the mint as `rootNodeId` (the
//   presentation `root` — freeze JUST that view), and "Everything" carries none.
// This is the surfacing proof for the prune-scene primitive (anti-primitive: a
// scoping mechanism with no user control isn't a feature).

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const createCapsuleTarget = vi.fn();
// Mock the target module: capture the mint request, and stub sdkEngineIo (imported
// by the surface) so the surface never reaches the real SDK protocol in the test.
vi.mock('@/packages/public-scene-share/do-work/create-capsule-target', () => ({
  createCapsuleTarget: (...args: unknown[]) => createCapsuleTarget(...args),
  sdkEngineIo: { readCurrent: vi.fn(), writeBytes: vi.fn() },
}));

const { ShareSurface } = await import('@/packages/public-scene-share/show/share-surface');

const SCENE = {
  id: 'scene',
  children: [
    { id: 'scene-root:bitfield-studio-sidebar', kind: 'Component' },
    { id: 'scene-root:bitfield-studio-main-workspace', kind: 'Component' },
  ],
};

function sceneIo() {
  const payload = new TextEncoder().encode(JSON.stringify(SCENE));
  return {
    readCurrent: vi.fn().mockResolvedValue({ found: true, payload }),
    writeBytes: vi.fn(),
  } as never;
}

beforeEach(() => {
  createCapsuleTarget.mockReset();
  createCapsuleTarget.mockResolvedValue({ ok: true, capsuleHash: '1f:cafe', contentPath: '/cas/1f:cafe', byteLength: 9 });
});
afterEach(() => cleanup());

describe('ShareSurface — DATA-driven scope picker', () => {
  it('lists "Everything" + each live scene root with a humanized label (no hardcoded id)', async () => {
    render(<ShareSurface partitionLabel="bitfield-studio" io={sceneIo()} />);
    expect(await screen.findByText('Everything')).toBeTruthy();
    // ids humanized for display, value stays the raw id
    expect(await screen.findByText('Bitfield Studio Sidebar')).toBeTruthy();
    expect(await screen.findByText('Bitfield Studio Main Workspace')).toBeTruthy();
  });

  it('choosing a root carries its id into the mint as rootNodeId', async () => {
    // Explicit reachable origin: this test proves scope-picker wiring, not reachability
    // gating (L114/L116) — a real deploy target's reported public URL would be injected
    // here in production; the ambient jsdom origin (loopback) is honestly unreachable.
    render(<ShareSurface partitionLabel="bitfield-studio" publicShareOrigin="https://share.bitfield.so" io={sceneIo()} />);
    fireEvent.click(await screen.findByText('Bitfield Studio Main Workspace'));
    // fire the share button (the affordance primary action)
    fireEvent.click(screen.getByText(/share/i));
    await waitFor(() =>
      expect(createCapsuleTarget).toHaveBeenCalledWith(
        expect.objectContaining({ rootNodeId: 'scene-root:bitfield-studio-main-workspace' }),
        undefined,
        expect.anything(),
      ),
    );
  });

  it('"Everything" mints with NO rootNodeId (whole scene)', async () => {
    render(<ShareSurface partitionLabel="bitfield-studio" publicShareOrigin="https://share.bitfield.so" io={sceneIo()} />);
    await screen.findByText('Everything'); // ensure picker hydrated
    fireEvent.click(screen.getByText(/share/i));
    await waitFor(() => expect(createCapsuleTarget).toHaveBeenCalled());
    const req = createCapsuleTarget.mock.calls[0][0] as { rootNodeId?: string };
    expect(req.rootNodeId).toBeUndefined();
  });
});
