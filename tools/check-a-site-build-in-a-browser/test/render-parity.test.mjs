// The element-level comparison of two renders (do-work/render-parity.mjs) on made-up collected pages: equal pages are 0
// differences; a missing text, a moved highlight, a size, a weight, a missing h1 and a page running past the window are each
// one difference with both values; texts are matched by reading order so one missing text does not shift the rest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { alignBy, differences } from '../do-work/render-parity.mjs';

const text = (words, extra = {}) => ({ text: words, tag: 'p', heading: null, fontSize: 16, fontWeight: '400', color: 'rgb(0, 0, 0)', accent: false, lineHeight: 24, textAlign: 'start', fontFamily: 'Inter', left: 10, width: 300, right: 310, top: 0, gap: 8, ...extra });
const page = (texts, extra = {}) => ({ texts, pictures: [], headings: [], h1: 1, scrollWidth: 390, clientWidth: 390, scrollHeight: 2000, over: [], ...extra });

test('equal pages have no differences', () => {
  const a = page([text('one'), text('two')]);
  assert.deepEqual(differences(a, structuredClone(a), 390), []);
});

test('each kind of difference is one entry with both values, and a missing text does not shift the rest', () => {
  const old = page([text('Heading', { tag: 'h1', fontSize: 64, accent: true }), text('Lead', { fontWeight: '500' }), text('Last')]);
  const now = page([text('Lead', { fontWeight: '400' }), text('Last', { fontSize: 18 })], { h1: 0, scrollWidth: 500 });
  const found = differences(old, now, 1280);
  const by = Object.fromEntries(found.map(item => [`${item.kind}:${item.where}`, item]));
  assert.deepEqual(by['text missing:Heading'].was, 'h1 64px');
  assert.deepEqual([by['font weight:Lead'].was, by['font weight:Lead'].is], ['500', '400']);
  assert.deepEqual([by['font size:Last'].was, by['font size:Last'].is], [16, 18]);
  assert.equal(by['h1 count:page'].was, 1);
  assert.equal(by['runs past the window:page'].is, 500);
  assert.equal(found.length, 5);
});

test('texts are matched by their words in reading order', () => {
  const pairs = alignBy([{ text: 'a' }, { text: 'b' }, { text: 'c' }], [{ text: 'b' }, { text: 'c' }, { text: 'd' }]);
  assert.deepEqual(pairs, [[1, 0], [2, 1]]);
});

test('a button\'s text-align is not a difference', () => {
  const old = page([text('Go', { tag: 'a', textAlign: 'center' })]);
  const now = page([text('Go', { tag: 'a', textAlign: 'start' })]);
  assert.deepEqual(differences(old, now, 390), []);
});
