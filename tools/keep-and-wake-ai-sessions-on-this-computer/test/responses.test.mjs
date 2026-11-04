// Answers on any thing (src/responses.mjs): what a reaction and a part may hold, and how kept reactions read back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE, VOTE, foldReactions, partFrom, partKey, reactionFrom } from '../src/responses.mjs';

test('a reaction is a palette symbol, the person\'s own emoji, or an https picture; anything else is refused in words', () => {
  assert.deepEqual(reactionFrom({ symbol: PALETTE[0].symbol }), { symbol: PALETTE[0].symbol, glyph: null });
  assert.deepEqual(reactionFrom({ glyph: '🦄' }), { symbol: '🦄', glyph: '🦄' });
  const gif = 'https://media.example.com/party.gif';
  assert.deepEqual(reactionFrom({ glyph: gif }), { symbol: gif, glyph: gif });
  assert.throws(() => reactionFrom({}), /Choose a reaction/);
  assert.throws(() => reactionFrom({ glyph: 'two words' }), /no spaces/);
  assert.throws(() => reactionFrom({ glyph: 'x'.repeat(40) }), /at most/);
});

test('a part is a plain object with a kind, bounded in size; null means the whole thing', () => {
  assert.equal(partFrom(null), null);
  const words = { kind: 'text-range', quote: 'price at $4', prefix: 'We should ', suffix: '', start: 10, end: 21 };
  assert.deepEqual(partFrom(words), words);
  assert.throws(() => partFrom({ quote: 'no kind' }), /names its kind/);
  assert.throws(() => partFrom('text'), /names its kind/);
  assert.throws(() => partFrom({ kind: 'text-range', quote: 'x'.repeat(5000) }), /at most/);
});

test('part addresses match when their JSON keys arrive in a different order', () => {
  assert.equal(partKey({ kind: 'text-range', quote: 'hello', start: 0, end: 5 }), partKey({ end: 5, start: 0, quote: 'hello', kind: 'text-range' }));
  assert.equal(partKey(null), null);
});

test('kept reactions fold into one entry per symbol with who gave it, and the vote is counted apart', () => {
  const rows = [
    { relay: 'ana', symbol: PALETTE[0].symbol, count: 1, glyph: null },
    { relay: 'bo', symbol: PALETTE[0].symbol, count: 1, glyph: null },
    { relay: 'bo', symbol: '🦄', count: 1, glyph: '🦄' },
    { relay: 'ana', symbol: VOTE, count: 2, glyph: null },
  ];
  const folded = foldReactions(rows, 'ana', relay => ({ bo: 'Bo' })[relay]);
  assert.deepEqual(folded.votes, { count: 2, yours: 2 });
  assert.deepEqual(folded.reactions.map(row => [row.glyph, row.count, row.yours, row.by]), [[PALETTE[0].glyph, 2, true, ['You', 'Bo']], ['🦄', 1, false, ['Bo']]]);
  assert.deepEqual(foldReactions([], 'ana'), {});
  const gif = 'https://media.example.com/party.gif';
  assert.equal(foldReactions([{ relay: 'bo', symbol: gif, count: 1, glyph: gif }], 'ana').reactions[0].label, 'Picture', 'a picture says Picture, never its address');
});
