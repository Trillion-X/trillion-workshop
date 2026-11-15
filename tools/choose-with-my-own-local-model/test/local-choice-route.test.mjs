import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLocalChoiceRequest, observedScorer } from '../read-data/local-choice-route.mjs';

test('private choice and coverage refuse before building owners', async () => {
  for (const path of ['/local-choices/choose', '/local-choices/coverage']) {
    const answer = await handleLocalChoiceRequest({ privateReach: false,
      observations() { throw new Error('must not read private observations'); },
    }, new Request(`https://choice.test${path}`, { method: 'POST' }));
    assert.equal(answer.status, 403);
  }
});

test('observed scoring reuses the current scorer and cache under its task deadline', async () => {
  const runs = [], vectors = new Map();
  const scorer = observedScorer({
    cache: { async get(keys) { return Object.fromEntries(keys.filter(key => vectors.has(key)).map(key => [key, vectors.get(key)])); },
      async put(rows) { for (const row of rows) vectors.set(row.fingerprint, row.vector); } },
    embed: async (_, texts) => texts.map(text => text === 'music' ? [0, 1] : [1, 0]),
    observations: { async run(input) { runs.push(input); return input.decide(); } },
  });
  const row = { model: { id: 'test-local' }, scale: 100, max_characters: 1000, max_candidates: 16, escalate_below: 0.5 };
  const answer = await scorer.score({ state: 'calendar', criteria: { calendar: 'calendar', music: 'music' } }, row);
  assert.equal(answer.choice, 'calendar');
  assert.equal(runs[0].task, 'candidate-scoring');
  assert.equal(runs[0].deadline_ms, 20000);
  assert.equal(runs[0].model, 'test-local');
  assert.equal(vectors.size, 2);
  const unavailable = observedScorer({ cache: {}, observations: { run: async () => null } });
  await assert.rejects(unavailable.score({}, row), /deadline/);
});

test('choose reports unavailable and coverage returns only owner observations plus task rows', async () => {
  const owners = { privateReach: true, ask: async () => null, observations: () => ({ run: input => input.decide(), summary: () => ({ window: 0, coverage: [] }) }) };
  const choose = await handleLocalChoiceRequest(owners, new Request('https://choice.test/local-choices/choose', { method: 'POST', body: JSON.stringify({ state: 'Choose', candidates: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }) }));
  assert.equal((await choose.json()).unavailable, true);
  const coverage = await handleLocalChoiceRequest(owners, new Request('https://choice.test/local-choices/coverage'));
  const body = await coverage.json();
  assert.equal(body.window, 0);
  assert.ok(body.tasks.some(task => task.id === 'candidate-scoring'));
});
