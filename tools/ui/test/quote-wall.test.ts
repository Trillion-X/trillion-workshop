import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from '../../compare-two-movements-side-by-side/tests/render-a-view.ts';

const entry = new URL('./quote-wall-as-view.tsx', import.meta.url).pathname;
const items = [
  { kind: 'quote', text: 'I won the tournament.', attribution: 'Sam' },
  { kind: 'media', mediaKind: 'image', src: '/clips/a.jpg', alt: 'A clip' },
  { kind: 'quote', text: 'It was a game-changer.' },
  { kind: 'media', mediaKind: 'video', src: '/clips/b.mp4', alt: 'Another clip' },
];

test('quotes and clip stills are woven into rows, each item drawn', async () => {
  const html = await renderAView(entry, { items, label: 'What players say', rows: 2 });
  assert.match(html, /aria-label="What players say"/);
  assert.match(html, /I won the tournament\./);
  assert.match(html, /It was a game-changer\./);
  assert.match(html, /src="\/clips\/a\.jpg"/);
  assert.match(html, /data-proof-kind="media"/);
  assert.match(html, /data-proof-kind="quote"/);
});

test('an attribution is drawn only when given, and no items draws nothing', async () => {
  const html = await renderAView(entry, { items: [items[0], items[2]] });
  assert.equal((html.match(/Sam/g) ?? []).length >= 1, true);
  assert.equal(await renderAView(entry, { items: [] }), '');
});

test('the wall is pure: no script', async () => {
  assert.doesNotMatch(await renderAView(entry, { items }), /<script/);
});
