import { test } from 'node:test';
import assert from 'node:assert/strict';
import looks from '../../choose-and-publish-screen-looks/src/workspace/looks.json' with { type: 'json' };
import { assetForBrand, backgroundTone, fallbackBrandAssetPath, fallbackBrandPalette, presentationFromBrand } from '../read-data/brand-asset-actions.mjs';

const look = id => looks.themes.find(row => row.payload.id === id).payload;
const rows = family => [
  { id: 'brand', values: { role: 'selection', family } },
  ...['old', 'new'].flatMap(name => ['black', 'white'].flatMap(colour => ['svg', 'png'].map(format => ({
    id: `${name}-${colour}-${format}`, values: { family: name, role: 'wordmark', format,
      background: `${colour} on transparent`, url: `https://example.com/${name}-${colour}.${format}` },
  })))),
];

test('one family row changes light share and dark email wordmarks in both formats', () => {
  const before = rows('old');
  const after = rows('new');
  assert.equal(backgroundTone(presentationFromBrand(before, look('trillion')).palette), 'light');
  assert.equal(backgroundTone(presentationFromBrand(before, look('trillion-black')).palette), 'dark');
  assert.equal(presentationFromBrand(before, look('trillion')).wordmark_svg.url, 'https://example.com/old-black.svg');
  assert.equal(presentationFromBrand(before, look('trillion-black')).wordmark_png.url, 'https://example.com/old-white.png');
  assert.equal(presentationFromBrand(after, look('trillion')).wordmark_svg.url, 'https://example.com/new-black.svg');
  assert.equal(presentationFromBrand(after, look('trillion-black')).wordmark_png.url, 'https://example.com/new-white.png');
  assert.equal(assetForBrand([{ id: 'brand', values: { role: 'selection', family: 'old' } },
    { id: 'unsafe', values: { family: 'old', role: 'wordmark', format: 'svg', background: 'black on transparent', url: 'javascript:alert(1)' } }],
  { role: 'wordmark', format: 'svg' }), null);
});

test('a transient public brand read uses the approved bundled role, format and tone', () => {
  assert.equal(backgroundTone(fallbackBrandPalette), 'dark', 'the fallback wordmark and stylesheet share a dark look');
  assert.equal(fallbackBrandAssetPath('wordmark', 'svg'), '/brand/wordmark-white-transparent.svg');
  assert.equal(fallbackBrandAssetPath('wordmark', 'svg', null), '/brand/wordmark-white-transparent.svg', 'a share-page request has no tone query');
  assert.equal(fallbackBrandAssetPath('wordmark', 'svg', 'light'), '/brand/wordmark-black-transparent.svg');
  assert.equal(fallbackBrandAssetPath('wordmark', 'png', 'dark'), '/brand/wordmark-white-transparent.png');
  assert.equal(fallbackBrandAssetPath('mark', 'svg'), '/brand/mark-white-black.svg');
  assert.equal(fallbackBrandAssetPath('mark', 'svg', 'light'), '/brand/mark-black-white.svg');
  assert.equal(fallbackBrandAssetPath('mark', 'png', 'dark'), '/brand/mark-white-black.png');
  assert.equal(fallbackBrandAssetPath('unknown', 'svg'), null);
  assert.equal(fallbackBrandAssetPath('mark', 'html'), null);
});
