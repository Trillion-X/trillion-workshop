import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from '../../compare-two-movements-side-by-side/tests/render-a-view.ts';

const entry = new URL('./site-nav-as-view.tsx', import.meta.url).pathname;
const nav = { label: 'Main', items: [{ label: 'Articles', href: '/articles' }], actions: [] };
const brand_image = { src: '/assets/mark.png', alt: 'The school', width: 44, height: 44 };

test('a brand given as plain data is drawn as a linked image at its own width and height', async () => {
  const html = await renderAView(entry, { nav, icons: {}, brand_image });
  assert.match(html, /<a class="site-nav__brand" href="\/"><img class="site-nav__brand-image" src="\/assets\/mark\.png" alt="The school" width="44" height="44"\/><\/a>/);
});

test('without a brand image the brand the caller gives is drawn', async () => {
  const html = await renderAView(entry, { nav, icons: {} });
  assert.match(html, /<a class="site-nav__brand" href="\/"><\/a>/);
  assert.doesNotMatch(html, /site-nav__brand-image"/);
});
