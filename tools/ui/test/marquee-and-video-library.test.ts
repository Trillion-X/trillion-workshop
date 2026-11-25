import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from '../../compare-two-movements-side-by-side/tests/render-a-view.ts';

const marquee = new URL('./quote-marquee-as-view.tsx', import.meta.url).pathname;
const library = new URL('./video-library-as-view.tsx', import.meta.url).pathname;
const items = [
  { kind: 'quote', text: 'First quote', attribution: 'A' },
  { kind: 'quote', text: 'Second quote', attribution: 'B' },
  { kind: 'media', src: '/a.mp4', alt: 'A clip' },
  { kind: 'quote', text: 'Third quote' },
];

test('the marquee takes plain JSON, deals the items into the rows in the order given, and draws a media item as a video', async () => {
  const props = JSON.parse(JSON.stringify({ rows: 2, pixels_per_second: 52, label: 'What players say', items }));
  const html = await renderAView(marquee, props);
  assert.match(html, /aria-label="What players say"/);
  assert.ok(html.indexOf('First quote') < html.indexOf('Third quote'), 'rail 1 holds items 1 and 3 in the given order');
  assert.match(html, /<video[^>]*src="\/a\.mp4"/);
  assert.match(html, /loop/);
  assert.match(html, /muted/);
});

test('with no items the marquee draws nothing', async () => {
  assert.equal(await renderAView(marquee, { items: [] }), '');
});

const libraries = [
  { name: 'Master Class', entries: [{ id: 'a', title: 'Nine steps', duration: '38 minutes', image: '/a.jpg', image_large: '/a-large.jpg' }, { id: 'b', title: 'Breakdown', duration: '12 minutes', image: '/b.jpg', image_large: '/b-large.jpg' }] },
  { name: 'Diagnostic Library', entries: [{ id: 'c', title: 'Diagnose', duration: '5 minutes', image: '/c.jpg', image_large: '/c-large.jpg' }] },
];

test('the library draws its picker with the first library chosen, its count, a large preview and the entry list', async () => {
  const html = await renderAView(library, { intro: 'Everything you learn', title: 'Video library', count_words: '{count} entries', libraries });
  assert.match(html, /Master Class/);
  assert.match(html, /Diagnostic Library/);
  assert.match(html, /2 entries/);
  assert.match(html, /data-library-preview="a"/);
  assert.match(html, /src="\/a-large\.jpg"/);
  assert.match(html, /Master Class · 38 minutes/);
  assert.match(html, /Master Class · 12 minutes/);
  assert.doesNotMatch(html, /data-library-entry="c"/);
});

test('plain JSON in: a library with no entries draws its picker and an empty frame', async () => {
  const html = await renderAView(library, JSON.parse(JSON.stringify({ libraries: [{ name: 'Empty', entries: [] }] })));
  assert.match(html, /Empty/);
  assert.match(html, /data-library-browser/);
});
