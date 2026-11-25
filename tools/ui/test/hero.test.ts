import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from '../../compare-two-movements-side-by-side/tests/render-a-view.ts';

// renderAView draws an entry's `View`; the Hero part is exported as `Hero`, so a one-line entry names it as View.
const entry = new URL('./hero-as-view.tsx', import.meta.url).pathname;

test('the hero draws its heading with the last word solid, its lead, and one action with its note', async () => {
  const html = await renderAView(entry, { heading: 'Learn tennis from first principles', lead: 'One lesson at a time.', cta: { label: 'Start', href: '/start' }, note: 'Cancel any time.' });
  assert.match(html, /Learn tennis from first/);
  assert.match(html, /principles/);
  assert.match(html, /One lesson at a time\./);
  assert.match(html, /href="\/start"/);
  assert.match(html, /Cancel any time\./);
});

test('no action is drawn unless both its words and its address are given', async () => {
  assert.doesNotMatch(await renderAView(entry, { heading: 'Two words', cta: { label: 'Start', href: '' } }), /data-cta-block/);
  assert.doesNotMatch(await renderAView(entry, { heading: 'Two words' }), /data-cta-block/);
});

test('the hero is pure: no script', async () => {
  assert.doesNotMatch(await renderAView(entry, { heading: 'Two words' }), /<script/);
});

test('the heading is the page\'s one h1, and the words `highlight` names are the ones drawn solid', async () => {
  const html = await renderAView(entry, { heading: 'Master tennis as fast as humanly possible.', highlight: 'as fast as humanly possible' });
  assert.equal((html.match(/<h1/g) ?? []).length, 1);
  assert.match(html, /<h1[^>]*>.*Master tennis.*<\/h1>/s);
  // The solid part holds the whole phrase and the sentence's full stop stays outside it as plain words.
  assert.match(html, /as fast as humanly possible<[^>]*>[^<]*<\/[^>]*>\s*<[^>]*>?\.?/s);
});

test('the lead can draw named words solid, and a section Heading is an h2 with its highlight', async () => {
  const html = await renderAView(entry, { heading: 'Two words', lead: 'Better, fastest. You do it.', lead_highlight: 'fastest' });
  assert.match(html, /Better, <span[^>]*>fastest<\/span>\. You do it\./);
  const heading = await renderAView(new URL('./heading-as-view.tsx', import.meta.url).pathname, { text: 'Train with us.', highlight: 'us.' });
  assert.match(heading, /<h2[^>]*>.*Train with .*<span[^>]*>us\.<\/span>/s);
  assert.doesNotMatch(heading, /<h1/);
});
