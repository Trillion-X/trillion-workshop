import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  isSingleUrl,
  hostFromHref,
  faviconUrl,
  readLinkPreview,
  linkPreviewImages,
  linkCardDraft,
  mergeLinkPreviewEdit,
} from '../../../do-work/link-preview.ts';

describe('readLinkPreview + linkPreviewImages — the gallery DATA path (b196)', () => {
  it('readLinkPreview parses an images array (filters non-strings/empties; absent → undefined)', () => {
    const p = readLinkPreview({ linkPreview: { image: 'a.jpg', images: ['a.jpg', 'b.jpg', '', 3, 'c.jpg'] } });
    expect(p?.images).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(readLinkPreview({ linkPreview: { image: 'a.jpg' } })?.images).toBeUndefined();
    // an images-only preview is NOT all-empty → not nulled
    expect(readLinkPreview({ linkPreview: { images: ['x.jpg'] } })?.images).toEqual(['x.jpg']);
  });
  it('linkPreviewImages is the read SSOT: gallery, else single-hero fallback, else []', () => {
    expect(linkPreviewImages({ image: 'hero.jpg', images: ['1.jpg', '2.jpg'] })).toEqual(['1.jpg', '2.jpg']);
    expect(linkPreviewImages({ image: 'hero.jpg' })).toEqual(['hero.jpg']); // single-image link → one-element list
    expect(linkPreviewImages({})).toEqual([]);
    expect(linkPreviewImages(null)).toEqual([]);
  });
});

describe('isSingleUrl', () => {
  it('accepts a lone http(s) URL', () => {
    expect(isSingleUrl('https://milanote.com/board/abc')).toBe(true);
    expect(isSingleUrl('http://example.org')).toBe(true);
    expect(isSingleUrl('  https://example.org/x  ')).toBe(true); // trimmed
  });
  it('rejects text that is not a lone URL', () => {
    expect(isSingleUrl('check https://example.org out')).toBe(false); // has words
    expect(isSingleUrl('just some note text')).toBe(false);
    expect(isSingleUrl('ftp://example.org')).toBe(false); // not http(s)
    expect(isSingleUrl('')).toBe(false);
    expect(isSingleUrl(null)).toBe(false);
    expect(isSingleUrl(undefined)).toBe(false);
  });
});

describe('hostFromHref', () => {
  it('strips www and returns the hostname', () => {
    expect(hostFromHref('https://www.figma.com/file/x')).toBe('figma.com');
    expect(hostFromHref('https://blog.bento.me/a/b?c=1')).toBe('blog.bento.me');
  });
  it('returns the fallback for a non-URL', () => {
    expect(hostFromHref('not a url', 'Link')).toBe('Link');
    expect(hostFromHref(undefined, 'Link')).toBe('Link');
    expect(hostFromHref('')).toBe(''); // default fallback
  });
});

describe('faviconUrl', () => {
  it('derives a favicon service URL from the host (no fetch)', () => {
    expect(faviconUrl('https://www.pinterest.com/pin/1')).toBe(
      'https://www.google.com/s2/favicons?domain=pinterest.com&sz=64',
    );
    expect(faviconUrl('https://x.com', 32)).toBe('https://www.google.com/s2/favicons?domain=x.com&sz=32');
  });
  it('returns null when there is no parseable host', () => {
    expect(faviconUrl('garbage')).toBeNull();
    expect(faviconUrl(undefined)).toBeNull();
  });
});

describe('readLinkPreview', () => {
  it('reads the self-describing extra.linkPreview DATA', () => {
    const p = readLinkPreview({
      linkPreview: { title: 'Hello', description: 'World', image: 'https://x/i.png', favicon: 'https://x/f.ico' },
    });
    expect(p).toEqual({ title: 'Hello', description: 'World', image: 'https://x/i.png', favicon: 'https://x/f.ico' });
  });
  it('drops empty/whitespace fields and returns null when nothing enriched (no fake)', () => {
    expect(readLinkPreview({ linkPreview: { title: '   ', description: '' } })).toBeNull();
    expect(readLinkPreview({})).toBeNull();
    expect(readLinkPreview(undefined)).toBeNull();
    expect(readLinkPreview({ linkPreview: 'nope' })).toBeNull();
  });
  it('keeps only the present fields', () => {
    expect(readLinkPreview({ linkPreview: { image: 'https://x/i.png' } })).toEqual({ image: 'https://x/i.png' });
  });
});

describe('mergeLinkPreviewEdit', () => {
  it('writes a manual title + description over the current preview', () => {
    expect(mergeLinkPreviewEdit(null, { title: 'My Ref', description: 'notes' })).toEqual({
      title: 'My Ref',
      description: 'notes',
    });
  });
  it('preserves untouched enrichment fields (image/favicon)', () => {
    expect(
      mergeLinkPreviewEdit({ image: 'https://x/i.png', favicon: 'https://x/f.ico', title: 'old' }, { title: 'new' }),
    ).toEqual({ title: 'new', image: 'https://x/i.png', favicon: 'https://x/f.ico', description: undefined });
  });
  it('drops whitespace-only fields (clearing a field removes it, no fake)', () => {
    expect(mergeLinkPreviewEdit({ title: 'old' }, { title: '   ', description: '' })).toBeUndefined();
  });
  it('returns undefined when the whole preview becomes empty', () => {
    expect(mergeLinkPreviewEdit(null, {})).toBeUndefined();
    expect(mergeLinkPreviewEdit({ title: 'old' }, { title: '' })).toBeUndefined();
  });
  it('keeps the preview when only an untouched field survives', () => {
    expect(mergeLinkPreviewEdit({ image: 'https://x/i.png' }, {})).toEqual({ image: 'https://x/i.png' });
  });
  it('keeps a video/siteName-only preview when title+description are cleared (Codex F5 regression)', () => {
    // Clearing the title must NOT delete a preview whose only content is the enrichment video
    // (or siteName) — the survive-guard now covers every populated field, not just image/favicon.
    expect(mergeLinkPreviewEdit({ video: 'https://x/reel.mp4' }, { title: '' }))
      .toEqual({ video: 'https://x/reel.mp4', title: undefined, description: undefined });
    expect(mergeLinkPreviewEdit({ siteName: 'Instagram' }, { title: '', description: '' }))
      .toEqual({ siteName: 'Instagram', title: undefined, description: undefined });
  });
});

describe('linkCardDraft', () => {
  it('builds a link-kind draft carrying the href as src and the domain as text', () => {
    expect(linkCardDraft('https://www.milanote.com/  ')).toEqual({
      kind: 'link',
      src: 'https://www.milanote.com/',
      text: 'milanote.com',
    });
  });
});
