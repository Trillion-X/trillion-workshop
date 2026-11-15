import test from 'node:test';
import assert from 'node:assert/strict';
import { searchAssemblyItems } from '../do-work/search-assembly-items.mjs';

const evidence = (score, extra = {}) => ({ place: 'said', match: 'meaning', score, index_id: 'speech', address: '/clip', model_id: 'speech-model', ...extra });
const answer = (witnesses, extra = {}) => ({ results: [{ address: '/clip', identity: 'kept-file', score: 0.01639,
  moments: [{ start: 12, end: 18, timed: true, said: 'The source words.', evidence: witnesses }], ...extra }] });
const adapt = value => searchAssemblyItems(value, { minimumScore: 0.5 });

test('a semantic moment preserves its raw score, address and exact edit span despite the low fused score', () => {
  const source = answer([evidence(0.73)]);
  const before = structuredClone(source);
  assert.deepEqual(adapt(source), [{ address: '/clip', identity: 'kept-file', in_point: 12, out_point: 18,
    score: 0.73, evidence: evidence(0.73), index_id: 'speech', said: 'The source words.' }]);
  assert.deepEqual(source, before);
});

test('word evidence and a high fused score cannot pass the semantic similarity floor', () => {
  assert.deepEqual(adapt(answer([evidence(1, { match: 'words' }), evidence(0.49)], { score: 10 })), []);
  assert.deepEqual(adapt(answer([], { score: 10, places: [{ place: 'said', score: 1 }] })), []);
});

test('a merged display moment keeps each semantic witness exact edit span', () => {
  const value = adapt(answer([evidence(0.73, { start: 12.34567, end: 17.89123 })]));
  assert.equal(value[0].in_point, 12.34567);
  assert.equal(value[0].out_point, 17.89123);
  assert.deepEqual(adapt(answer([evidence(0.73, { start: 13, end: 13 })])), []);
});

test('different models stay in canonical order and several passing witnesses produce one clip', () => {
  const first = evidence(0.6, { model_id: 'first-model' });
  const second = evidence(0.99, { model_id: 'other-model' });
  assert.deepEqual(adapt(answer([first, second]))[0].evidence, first);
  assert.equal(adapt(answer([first, second])).length, 1);
  assert.deepEqual(adapt(answer([evidence(0.4), second]))[0].evidence, second);
});

test('the caller supplies the existing ruleset floor rather than a new fixed threshold', () => {
  assert.equal(searchAssemblyItems(answer([evidence(0.7)]), { minimumScore: 0.8 }).length, 0);
  assert.equal(searchAssemblyItems(answer([evidence(0.7)]), { minimumScore: 0.6 }).length, 1);
  assert.throws(() => searchAssemblyItems(answer([evidence(0.7)])), /ruleset must supply/);
});

test('untimed, missing, negative or empty spans and missing source addresses cannot author a clip', () => {
  for (const patch of [{ timed: false }, { start: -1 }, { start: NaN }, { end: 12 }, { end: undefined }]) {
    const source = answer([evidence(0.7)]);
    Object.assign(source.results[0].moments[0], patch);
    assert.deepEqual(adapt(source), []);
  }
  assert.deepEqual(adapt(answer([evidence(0.7, { address: undefined })], { address: undefined })), []);
  assert.deepEqual(adapt({ results: [] }), []);
});
