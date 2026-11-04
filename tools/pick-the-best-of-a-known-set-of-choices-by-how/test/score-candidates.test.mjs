import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, handleScoreRequest, makeScorer, scoreCandidateSimilarities } from '../src/score-candidates.mjs';
import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/pool-settings.json' with { type: 'json' };

// A stand-in embedding: each text becomes counts of a few words, so which candidate is closest is known in advance.
const WORDS = ['serve', 'toss', 'bread', 'oven', 'feet', 'rally'];
const vectorOf = text => WORDS.map(word => (String(text).toLowerCase().match(new RegExp(word, 'g')) ?? []).length + 0.01);

function harness() {
  const kept = new Map();
  const calls = [];
  const scorer = makeScorer({
    embed: async (model, texts) => { calls.push({ model, texts }); return texts.map(vectorOf); },
    cache: {
      get: async fps => Object.fromEntries(fps.filter(fp => kept.has(fp)).map(fp => [fp, kept.get(fp)])),
      put: async entries => entries.forEach(entry => kept.set(entry.fingerprint, entry.vector)),
    },
  });
  return { scorer, kept, calls };
}

const row = { ...settings.candidate_scorer };
const criteria = { toss: 'A toss drill for the serve', bake: 'Bake bread in the oven', footwork: 'Footwork for long rally points' };

test('the closest candidate is chosen, and the probabilities are a distribution over the supplied ids', async () => {
  const { scorer } = harness();
  const result = await scorer.score({ state: 'My serve toss drifts left on every serve', criteria }, row);
  assert.equal(result.choice, 'toss');
  assert.deepEqual(result.ranked.map(item => item.id).sort(), Object.keys(criteria).sort());
  assert.ok(Math.abs(result.ranked.reduce((sum, item) => sum + item.probability, 0) - 1) < 0.001);
  assert.equal(result.model, row.model.id);
});


test('every candidate is scored in bounded batches, including a one-item remainder', async () => {
  const calls = [];
  const scorer = {
    score: async ({ criteria: batch }) => {
      const ids = Object.keys(batch);
      calls.push(ids);
      return { ranked: ids.map((id, index) => ({ id, similarity: 1 - index / 10 })) };
    },
  };
  const open = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`candidate-${index}`, `description ${index}`]));
  const similarities = await scoreCandidateSimilarities(scorer, { state: 'find the closest', criteria: open }, { ...row, max_candidates: 3 });
  assert.deepEqual(Object.keys(similarities).sort(), Object.keys(open).sort());
  assert.deepEqual(calls.map(batch => batch.length), [3, 3, 2]);
  assert.ok(calls.every(batch => batch.length >= 2 && batch.length <= 3));
  assert.equal(calls[2][1], calls[0][0], 'the last candidate is paired with one earlier candidate, never dropped');
});

test('a failed candidate batch refuses the whole score instead of returning a partial catalog', async () => {
  let call = 0;
  const scorer = { score: async ({ criteria: batch }) => {
    if (++call === 2) throw new Error('embedding unavailable');
    return { ranked: Object.keys(batch).map(id => ({ id, similarity: 1 })) };
  } };
  const open = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`candidate-${index}`, `description ${index}`]));
  await assert.rejects(scoreCandidateSimilarities(scorer, { state: 'find', criteria: open }, { ...row, max_candidates: 3 }), /embedding unavailable/);
});

test('a candidate is embedded once: the second call embeds only the state, and nothing kept is a state or a text', async () => {
  const { scorer, kept, calls } = harness();
  await scorer.score({ state: 'serve toss', criteria }, row);
  assert.equal(calls[0].texts.length, 4);
  const second = await scorer.score({ state: 'long rally, heavy feet', criteria }, row);
  assert.equal(calls[1].texts.length, 1);
  assert.equal(second.embedded, 1);
  assert.equal(second.choice, 'footwork');
  assert.deepEqual([...kept.keys()].sort(), Object.values(criteria).map(text => fingerprint(row.model.id, text)).sort());
});

test('the same description under another model is a different vector', () => {
  assert.notEqual(fingerprint('model-a', 'toss'), fingerprint('model-b', 'toss'));
  assert.match(fingerprint('model-a', 'toss'), /^1f:[0-9a-f]{64}$/);
});

test('the confidence line is the settings row: the same scores escalate or not by DATA alone', async () => {
  const { scorer } = harness();
  const even = { a: 'serve', b: 'serve toss' };
  const loose = await scorer.score({ state: 'serve', criteria: even }, { ...row, escalate_below: 0 });
  const strict = await scorer.score({ state: 'serve', criteria: even }, { ...row, escalate_below: 1 });
  assert.equal(loose.escalate, false);
  assert.equal(strict.escalate, true);
  assert.equal(loose.confidence, strict.confidence);
});

test('the question is read after the state, and an empty description is scored as its id', async () => {
  const { scorer, calls } = harness();
  const result = await scorer.score({ state: 'My session plan', instructions: 'Which part fixes the serve?', criteria: { serve: '', oven: '' } }, row);
  assert.equal(calls[0].texts[0], 'My session plan\n\nWhich part fixes the serve?');
  assert.equal(result.choice, 'serve');
});

test('bad requests are refused with a reason; a failing model is a 502, not a 400', async () => {
  const { scorer } = harness();
  const ask = body => handleScoreRequest(scorer, row, new Request('https://x/score', { method: 'POST', body: JSON.stringify(body) }));
  assert.equal((await ask({ state: 'x', criteria: { only: 'one' } })).status, 400);
  assert.equal((await ask({ criteria })).status, 400);
  assert.equal((await ask({ state: 'x', criteria: ['a', 'b'] })).status, 400);
  const tooMany = Object.fromEntries(Array.from({ length: row.max_candidates + 1 }, (_, i) => [`c${i}`, 'x']));
  assert.equal((await ask({ state: 'x', criteria: tooMany })).status, 400);
  const broken = makeScorer({ embed: async () => { throw new Error('model down'); }, cache: { get: async () => ({}), put: async () => {} } });
  const failed = await handleScoreRequest(broken, row, new Request('https://x/score', { method: 'POST', body: JSON.stringify({ state: 'x', criteria }) }));
  assert.equal(failed.status, 502);
});
