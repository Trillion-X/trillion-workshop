// packages/public-scene-share/show/share-scene-presenter.test.ts
//
// Proves the Share view-model translation boundary: machine capsule reply -> human
// copy + the exact shareable URL the shipped viewer reads (`/c/<hash>`). Pure, no
// engine I/O. Run: npx vitest run packages/public-scene-share/show

import { describe, it, expect } from 'vitest';
import {
  idleShareView,
  mintingShareView,
  unreachableShareView,
  shareViewFromReply,
  shareUrlFromHash,
  isPubliclyReachableOrigin,
  type ShareConfig,
} from './share-scene-presenter';

const CONFIG: ShareConfig = { publicShareOrigin: 'https://share.bitfield.so' };

describe('share-scene-presenter', () => {
  it('idle view offers Share, no link, not busy', () => {
    const v = idleShareView();
    expect(v.status).toBe('idle');
    expect(v.primaryLabel).toBe('Share this view');
    expect(v.shareUrl).toBeNull();
    expect(v.canCopy).toBe(false);
    expect(v.busy).toBe(false);
  });

  it('minting view is busy with no link', () => {
    const v = mintingShareView();
    expect(v.status).toBe('minting');
    expect(v.busy).toBe(true);
    expect(v.shareUrl).toBeNull();
    expect(v.canCopy).toBe(false);
  });

  it('builds the shareable URL in the SAME /c/<hash> shape the viewer reads', () => {
    expect(shareUrlFromHash('https://share.bitfield.so', '1f:abc')).toBe('https://share.bitfield.so/c/1f:abc');
  });

  it('tolerates a trailing slash on the configured origin', () => {
    expect(shareUrlFromHash('https://share.bitfield.so/', '1f:abc')).toBe('https://share.bitfield.so/c/1f:abc');
  });

  it('ok reply with a hash -> shared view with Copy link + the live URL', () => {
    const v = shareViewFromReply({ ok: true, capsuleHash: '1f:deadbeef', contentPath: '/c/1f:deadbeef' }, CONFIG);
    expect(v.status).toBe('shared');
    expect(v.primaryLabel).toBe('Copy link');
    expect(v.shareUrl).toBe('https://share.bitfield.so/c/1f:deadbeef');
    expect(v.canCopy).toBe(true);
    expect(v.busy).toBe(false);
    expect(v.helpText).toMatch(/frozen copy/i);
  });

  it('ok reply WITHOUT a hash is an error, never a silent success', () => {
    const v = shareViewFromReply({ ok: true }, CONFIG);
    expect(v.status).toBe('error');
    expect(v.shareUrl).toBeNull();
    expect(v.canCopy).toBe(false);
  });

  it('failed reply -> error view surfaces the reason', () => {
    const v = shareViewFromReply({ ok: false, reason: 'CAS write rejected' }, CONFIG);
    expect(v.status).toBe('error');
    expect(v.primaryLabel).toBe('Try again');
    expect(v.helpText).toBe('CAS write rejected');
    expect(v.canCopy).toBe(false);
  });

  it('failed reply with no reason -> generic error help', () => {
    const v = shareViewFromReply({ ok: false }, CONFIG);
    expect(v.status).toBe('error');
    expect(v.helpText).toMatch(/could not create a share link/i);
  });

  it('uses the injected origin (local/preview proof), not a hardcoded one', () => {
    const v = shareViewFromReply({ ok: true, capsuleHash: '1f:x' }, { publicShareOrigin: 'http://127.0.0.1:8899' });
    expect(v.shareUrl).toBe('http://127.0.0.1:8899/c/1f:x');
  });
});

describe('isPubliclyReachableOrigin — the ONLY "not actually public" definition', () => {
  it('rejects loopback, RFC1918 private ranges, link-local, and mDNS hostnames', () => {
    expect(isPubliclyReachableOrigin('http://localhost:3000')).toBe(false);
    expect(isPubliclyReachableOrigin('http://127.0.0.1:8899')).toBe(false);
    expect(isPubliclyReachableOrigin('http://studio.local')).toBe(false);
    expect(isPubliclyReachableOrigin('http://10.0.0.5:3012')).toBe(false);
    expect(isPubliclyReachableOrigin('http://172.16.4.1')).toBe(false);
    expect(isPubliclyReachableOrigin('http://192.168.1.20')).toBe(false);
    expect(isPubliclyReachableOrigin('http://169.254.1.1')).toBe(false);
    expect(isPubliclyReachableOrigin('http://0.0.0.0')).toBe(false);
    expect(isPubliclyReachableOrigin('http://[::1]')).toBe(false);
  });

  it('fails CLOSED on empty or unparsable input', () => {
    expect(isPubliclyReachableOrigin('')).toBe(false);
    expect(isPubliclyReachableOrigin('not a url')).toBe(false);
  });

  it('accepts a real public origin, including a deploy target outside the private ranges', () => {
    expect(isPubliclyReachableOrigin('https://share.bitfield.so')).toBe(true);
    expect(isPubliclyReachableOrigin('https://my-app.up.railway.app')).toBe(true);
    expect(isPubliclyReachableOrigin('http://172.32.0.1')).toBe(true); // just outside 172.16-31/12
  });
});

describe('unreachableShareView + shareViewFromReply gating (L114/L116 — never a fake link)', () => {
  it('unreachable view offers no link, no copy, and a "connect a deploy target" action', () => {
    const v = unreachableShareView();
    expect(v.status).toBe('unreachable');
    expect(v.shareUrl).toBeNull();
    expect(v.canCopy).toBe(false);
    expect(v.busy).toBe(false);
    expect(v.primaryLabel).toMatch(/connect a deploy target/i);
  });

  it('config.isPubliclyReachable === false wins EVEN over a successful mint reply', () => {
    const v = shareViewFromReply(
      { ok: true, capsuleHash: '1f:x' },
      { publicShareOrigin: 'http://localhost:3000', isPubliclyReachable: false },
    );
    expect(v.status).toBe('unreachable');
    expect(v.shareUrl).toBeNull();
  });

  it('omitting isPubliclyReachable still trusts the given origin (explicit DATA wins, no regression)', () => {
    const v = shareViewFromReply({ ok: true, capsuleHash: '1f:x' }, { publicShareOrigin: 'http://127.0.0.1:8899' });
    expect(v.status).toBe('shared');
    expect(v.shareUrl).toBe('http://127.0.0.1:8899/c/1f:x');
  });
});
