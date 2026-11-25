import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAView } from './render-a-view.ts';

const entry = new URL('../show/PairShowcase.tsx', import.meta.url).pathname;
const whole = (id: string, place: number, featured = false) => ({ id, place, title: `Pair ${id}`, caption: '', featured, video: { label: '', video: `${id}.mp4`, start_s: 0 } });
const five = ['a', 'b', 'c', 'd', 'e'].map((id, index) => whole(id, index, id === 'c'));

test('the featured pair is large and every other pair is in the carousel: all five are drawn once', async () => {
  const html = await renderAView(entry, { pairs: five, filesBase: '/files/', carouselLabel: 'More pairs' });
  for (const id of ['a', 'b', 'c', 'd', 'e']) assert.equal((html.match(new RegExp(`data-landing-media-card="${id}"`, 'g')) ?? []).length, 1, id);
  assert.match(html, /data-landing-media-card="c"[^>]*>|data-featured="true"[^>]*data-landing-media-card="c"/);
  assert.match(html, /src="\/files\/c\.mp4"/);
});

test('the carousel has its arrows and dots', async () => {
  const html = await renderAView(entry, { pairs: five });
  assert.match(html, /data-direction="previous"/);
  assert.match(html, /data-direction="next"/);
  assert.match(html, /bf-media-carousel__dots/);
});

test('with no marked pair the first is featured; with one pair there is no carousel; with none nothing is drawn', async () => {
  const html = await renderAView(entry, { pairs: five.map(pair => ({ ...pair, featured: false })) });
  assert.match(html, /data-featured="true"[^>]*data-landing-media-card="a"|data-landing-media-card="a"[^>]*data-featured="true"/);
  assert.doesNotMatch(await renderAView(entry, { pairs: [five[0]] }), /bf-media-carousel__dots/);
  assert.equal(await renderAView(entry, { pairs: [] }), '');
});

test('a pair of two clips plays its left clip here', async () => {
  const pair = { id: 'p', place: 0, title: 'Pair', caption: '', featured: false, left: { label: 'A', video: 'l.mp4', start_s: 0 }, right: { label: 'B', video: 'r.mp4', start_s: 0 } };
  assert.match(await renderAView(entry, { pairs: [pair], filesBase: '/f/' }), /src="\/f\/l\.mp4"/);
});
