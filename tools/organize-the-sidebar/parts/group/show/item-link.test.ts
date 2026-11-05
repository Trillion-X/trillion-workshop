import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { normalizeHref, itemHref, linkHost } from '../../../show/item-link.ts';

describe('item-link', () => {
  it('normalizeHref passes through already-schemed URLs', () => {
    expect(normalizeHref('https://example.com')).toBe('https://example.com');
    expect(normalizeHref('http://foo.bar/x')).toBe('http://foo.bar/x');
    expect(normalizeHref('mailto:user-fb98d44a@example.com')).toBe('mailto:user-fb98d44a@example.com');
    expect(normalizeHref('tel:+15551234')).toBe('tel:+15551234');
  });

  it('normalizeHref prefixes a bare host with https://', () => {
    expect(normalizeHref('example.com')).toBe('https://example.com');
    expect(normalizeHref('foo.co/bar?x=1')).toBe('https://foo.co/bar?x=1');
    expect(normalizeHref('  spaced.com  ')).toBe('https://spaced.com');
  });

  it('normalizeHref returns null for empty / non-URL input', () => {
    expect(normalizeHref('')).toBeNull();
    expect(normalizeHref('   ')).toBeNull();
    expect(normalizeHref('just a note')).toBeNull(); // whitespace → not a URL
    expect(normalizeHref('nodot')).toBeNull(); // no dot → not a host
  });

  it('normalizeHref rejects dangerous / non-allowlisted schemes (allowlist, not blocklist)', () => {
    expect(normalizeHref('javascript:alert(1)')).toBeNull();
    expect(normalizeHref('javascript:alert(1).com')).toBeNull(); // dot, but unsafe scheme survives parse → rejected
    expect(normalizeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(normalizeHref('vbscript:msgbox(1)')).toBeNull();
    expect(normalizeHref('file:///etc/passwd')).toBeNull();
    expect(normalizeHref('ftp://files.example.com')).toBeNull(); // valid URL but not an allowlisted scheme
  });

  it('itemHref reads a non-empty string href, else undefined', () => {
    expect(itemHref({ extra: { href: 'https://x.com' } })).toBe('https://x.com');
    expect(itemHref({ extra: { href: '' } })).toBeUndefined();
    expect(itemHref({ extra: { href: '   ' } })).toBeUndefined();
    expect(itemHref({ extra: {} })).toBeUndefined();
    expect(itemHref({})).toBeUndefined();
    expect(itemHref(undefined)).toBeUndefined();
    expect(itemHref({ extra: { href: 42 as unknown as string } })).toBeUndefined();
  });

  it('linkHost strips scheme + www for web URLs', () => {
    expect(linkHost('https://www.example.com/path')).toBe('example.com');
    expect(linkHost('http://foo.bar')).toBe('foo.bar');
    expect(linkHost('https://sub.site.co/a/b')).toBe('sub.site.co');
  });

  it('linkHost returns the address for mailto/tel', () => {
    expect(linkHost('mailto:user-fb98d44a@example.com')).toBe('user-fb98d44a@example.com');
    expect(linkHost('tel:+15551234')).toBe('+15551234');
  });
});
