// packages/public-scene-share/show/share-surface.test.ts
//
// Proves the Share surface's keystone composition: `buildShareMint` invokes the
// `create-capsule` target and ADAPTS its machine reply to the presenter's
// `CapsuleReply` (failureReason → reason) — and `resolveShareOrigin` prefers
// explicit DATA over the ambient page origin.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const createCapsuleTarget = vi.fn();
vi.mock('@/packages/public-scene-share/do-work/create-capsule-target', () => ({
  createCapsuleTarget: (...args: unknown[]) => createCapsuleTarget(...args),
}));

const { buildShareMint, resolveShareOrigin } = await import('@/packages/public-scene-share/show/share-surface');
const { isPubliclyReachableOrigin } = await import('@/packages/public-scene-share/show/share-scene-presenter');

beforeEach(() => createCapsuleTarget.mockReset());

describe('buildShareMint — reply adaptation', () => {
  it('maps a successful target reply to a presenter CapsuleReply', async () => {
    createCapsuleTarget.mockResolvedValue({ ok: true, capsuleHash: '1f:cafe', contentPath: '/cas/1f:cafe', byteLength: 42 });
    const reply = await buildShareMint({ partitionLabel: 'bitfield-studio', tier: 'public' })();
    expect(reply).toEqual({ ok: true, capsuleHash: '1f:cafe', contentPath: '/cas/1f:cafe' });
  });

  it('maps a failure (failureReason) to { ok:false, reason } — never a silent success', async () => {
    createCapsuleTarget.mockResolvedValue({ ok: false, failureReason: 'scene sink not found' });
    const reply = await buildShareMint({ partitionLabel: 'bitfield-studio' })();
    expect(reply).toEqual({ ok: false, reason: 'scene sink not found' });
  });

  it('passes the request + injected io straight through to the target', async () => {
    createCapsuleTarget.mockResolvedValue({ ok: true, capsuleHash: '1f:x', contentPath: '/cas/1f:x', byteLength: 1 });
    const io = { readCurrent: vi.fn(), writeBytes: vi.fn() } as never;
    const req = { partitionLabel: 'p', sceneAddressLabel: 'scene', tier: 'public' as const };
    await buildShareMint(req, io)();
    expect(createCapsuleTarget).toHaveBeenCalledWith(req, undefined, io);
  });

  it('carries the chosen frozenChrome (bare = subtractive root-off) into the mint request', async () => {
    createCapsuleTarget.mockResolvedValue({ ok: true, capsuleHash: '1f:y', contentPath: '/cas/1f:y', byteLength: 1 });
    const io = { readCurrent: vi.fn(), writeBytes: vi.fn() } as never;
    await buildShareMint({ partitionLabel: 'p', tier: 'public', frozenChrome: { '': false } }, io)();
    expect(createCapsuleTarget).toHaveBeenCalledWith(
      expect.objectContaining({ frozenChrome: { '': false } }),
      undefined,
      io,
    );
  });
});

describe('resolveShareOrigin', () => {
  it('prefers explicit DATA origin', () => {
    expect(resolveShareOrigin('https://share.bitfield.so')).toBe('https://share.bitfield.so');
  });
  it('falls back to the ambient origin (or "") when no explicit DATA is given', () => {
    const expected = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
    expect(resolveShareOrigin()).toBe(expected);
    expect(resolveShareOrigin('')).toBe(expected); // empty string is treated as "no explicit"
  });
});

// ShareSurface composes resolveShareOrigin(publicShareOrigin) -> isPubliclyReachableOrigin(origin)
// to build ShareConfig.isPubliclyReachable (see share-surface.tsx). These prove that exact
// composition without needing a full component render: no deploy target connected (the
// jsdom ambient origin is loopback) -> honestly unreachable; a real deploy-target origin
// passed explicitly -> reachable. L114/L116.
describe('ShareSurface origin reachability wiring (no deploy target -> honest, never a fake link)', () => {
  it('the ambient fallback origin (no deploy target connected) is NOT publicly reachable', () => {
    expect(isPubliclyReachableOrigin(resolveShareOrigin())).toBe(false);
  });

  it('an explicit deploy-target public origin IS publicly reachable', () => {
    expect(isPubliclyReachableOrigin(resolveShareOrigin('https://my-app.up.railway.app'))).toBe(true);
  });
});
