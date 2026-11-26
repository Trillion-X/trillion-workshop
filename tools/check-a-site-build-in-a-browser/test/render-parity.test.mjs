// The element-level comparison of two renders (do-work/render-parity.mjs) on made-up collected pages: equal pages are 0
// differences; a missing text, a moved highlight, a size, a weight, a missing h1 and a page running past the window are each
// one difference with both values; texts are matched by reading order so one missing text does not shift the rest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { alignBy, differences } from '../do-work/render-parity.mjs';

const text = (words, extra = {}) => ({ text: words, tag: 'p', heading: null, fontSize: 16, fontWeight: '400', color: 'rgb(0, 0, 0)', accents: '', lineHeight: 24, textAlign: 'start', fontFamily: 'Inter', left: 10, width: 300, right: 310, top: 0, gap: 8, ...extra });
const page = (texts, extra = {}) => ({ texts, pictures: [], headings: [], h1: 1, scrollWidth: 390, clientWidth: 390, scrollHeight: 2000, over: [], ...extra });

test('equal pages have no differences', () => {
  const a = page([text('one'), text('two')]);
  assert.deepEqual(differences(a, structuredClone(a), 390), []);
});

test('each kind of difference is one entry with both values, and a missing text does not shift the rest', () => {
  const old = page([text('Heading', { tag: 'h1', fontSize: 64, accents: 'x' }), text('Lead', { fontWeight: '500' }), text('Last')]);
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

test('the box under a text is compared once per box: its colour, corner, border, shadow, gradient and height', () => {
  const box = (extra = {}) => ({ id: 0, colour: [245, 245, 245], gradient: false, corner: 12, border: 1, shadow: false, height: 54, width: 200, ...extra });
  const old = page([text('Pay', { surface: box() }), text('now', { surface: box() })]);
  const same = page([text('Pay', { surface: box({ colour: [244, 246, 245] }) }), text('now', { surface: box() })]);
  assert.deepEqual(differences(old, same, 1280), []);
  const other = page([text('Pay', { surface: box({ colour: [255, 253, 248], corner: 8, border: 0, shadow: true, gradient: true, height: 40 }) }), text('now', { surface: box({ colour: [255, 253, 248], corner: 8 }) })]);
  const kinds = differences(old, other, 1280).map(item => item.kind).sort();
  assert.deepEqual(kinds, ['border', 'box height', 'corner', 'shadow', 'surface colour', 'surface gradient']);
});

test('an arrow after a label is the same words whether a page draws it as a glyph or as a picture', () => {
  const old = page([text('See pricing →')]);
  const now = page([text('See pricing')]);
  assert.deepEqual(differences(old, now, 1280), []);
});
