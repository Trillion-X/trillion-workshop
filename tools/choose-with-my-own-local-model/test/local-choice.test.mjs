import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseLocal, explicitChoiceInput, explicitChoiceReply } from '../read-data/local-choice.mjs';

const request = { state: 'Two documents can answer the question.', candidates: [
  { id: 'first', label: 'First document', description: 'Older evidence' },
  { id: 'second', label: 'Second document', description: 'Direct current evidence' },
] };

test('a connected chat choice uses only the device route and records an actual call', async () => {
  const observed = [];
  const asked = [];
  const result = await chooseLocal(request, {
    ask: async input => { asked.push(input); return { model: 'gemma3:4b', choices: [{ message: { content: '{"id":"second","reason":"Current direct evidence"}' } }] }; },
    observations: { run: async args => { observed.push([args.task, args.surface, args.deadline_ms]); return args.decide(); } },
  });
  assert.deepEqual(observed, [['explicit-selection', 'mcp-choice', 45000]]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].input.job, 'explicit-selection');
  assert.equal(asked[0].priority, 8);
  assert.equal(result.choice, 'second');
  assert.equal(result.model, 'gemma3:4b');
});

test('an unavailable device never tries a hosted route or invents an option', async () => {
  let calls = 0;
  const result = await chooseLocal(request, { ask: async () => { calls += 1; throw new Error('offline'); },
    observations: { run: args => args.decide() } });
  assert.equal(calls, 1);
  assert.equal(result, null);
  assert.equal(explicitChoiceReply({ choices: [{ message: { content: '{"id":"invented"}' } }] }, request.candidates), null);
  assert.throws(() => explicitChoiceInput({ ...request, candidates: [request.candidates[0], request.candidates[0]] }), /distinct/);
});
