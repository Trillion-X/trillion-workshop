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

test('the nav folds under 1400px unless the page names a width: a short nav stays on the bar at a smaller one', async () => {
  const withActions = { ...nav, actions: [{ label: 'Log in', href: '/in' }, { label: 'Pricing', href: '#pricing', primary: true }] };
  assert.match(await renderAView(entry, { nav: withActions, icons: {} }), /\(max-width:1400px\)/);
  const short = await renderAView(entry, { nav: withActions, icons: {}, foldBelow: 760 });
  assert.match(short, /\(max-width:760px\)/);
  assert.doesNotMatch(short, /\(max-width:1400px\)/);
});

test('the nav\'s bar and actions read the site\'s tokens, and without them draw as they always did', async () => {
  const html = await renderAView(entry, { nav: { ...nav, actions: [{ label: 'Log in', href: '/in' }, { label: 'Go', href: '#p', primary: true }] }, icons: {} });
  for (const token of ['--site-nav-bar-bg', '--site-nav-bar-border', '--site-nav-bar-radius', '--site-nav-bar-padding', '--site-nav-padding', '--site-nav-action-border', '--site-nav-action-radius', '--site-nav-action-height', '--site-nav-action-padding', '--site-nav-action-size', '--site-nav-action-weight', '--site-nav-primary-radius', '--site-nav-primary-weight']) assert.ok(html.includes(`var(${token},`), token);
});
