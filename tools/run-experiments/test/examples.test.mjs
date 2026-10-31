// tools/run-experiments/test/examples.test.mjs
// The examples in data/ go through tool:choose-what-a-visitor-sees: a price test with one price in it, the same test
// with a second price added as one more candidate, and one page whose headline follows what is known about the
// visitor. Single choices run the command the way its row runs it; splits over many visitors call the same function
// the command calls, in this process. Everything in the examples is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chooseWhatAVisitorSees } from '../do-work/choose-what-a-visitor-sees.mjs';

const folder = resolve(import.meta.dirname, '..');
const row = JSON.parse(readFileSync(resolve(folder, 'records.json'), 'utf8')).things.map(thing => thing.payload)
  .find(item => item.id === 'tool:choose-what-a-visitor-sees');
const example = name => JSON.parse(readFileSync(resolve(folder, 'data', name), 'utf8'));

/** Run the command by its row: the whole input fills argv; the row's workdir is this folder as the container lays it out. */
function runByRow(input) {
  const argv = row.invoke.argv.map(item => (typeof item === 'string' ? item : JSON.stringify(input)));
  const ran = spawnSync(process.execPath, argv.slice(1), { cwd: folder, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  return JSON.parse(ran.stdout.trim().split('\n').at(-1));
}

const chosen = input => chooseWhatAVisitorSees(input).chosen.candidate_id;
const visitors = Array.from({ length: 200 }, (_, index) => `visitor-${index}`);

test('a price test with one price shows that price to every visitor', () => {
  const { surface, decider } = example('one-price-test.example.json');
  assert.equal(runByRow({ surface, decider, visitor: 'visitor-1' }).chosen.candidate_id, 'seat-monthly-a');
  assert.deepEqual([...new Set(visitors.map(visitor => chosen({ surface, decider, visitor })))], ['seat-monthly-a']);
});

test('a second price is one more candidate and one more weight, and each visitor keeps the price they first saw', () => {
  const { surface, decider } = example('one-price-test.example.json');
  const twoPrices = {
    surface: { ...surface, candidates: [...surface.candidates, { candidate_id: 'seat-monthly-b', material_ref: 'offer:example-seat-monthly-b' }] },
    decider: { ...decider, score: { ...decider.score, split: { split: { 'seat-monthly-a': 1, 'seat-monthly-b': 1 } } } },
  };
  const seen = visitors.map(visitor => chosen({ ...twoPrices, visitor }));
  const b = seen.filter(id => id === 'seat-monthly-b').length;
  assert.ok(b > 60 && b < 140, `about half see the second price (${b} of ${visitors.length})`);
  assert.deepEqual(visitors.map(visitor => chosen({ ...twoPrices, visitor })), seen);
  assert.equal(runByRow({ ...twoPrices, visitor: visitors[0] }).chosen.candidate_id, seen[0]);
});

test('the bandit example splits new visitors by who they are, not one bucket for everyone', () => {
  const decider = example('decider-bandit.example.json');
  const surface = { entity_type: 'selection-surface', address: 'page:/offer', decider_program_ref: decider.decider_id, candidates: [{ candidate_id: 'a', material_ref: 'material:a' }, { candidate_id: 'b', material_ref: 'material:b' }] };
  assert.deepEqual([...new Set(visitors.map(visitor => chosen({ surface, decider, visitor })))].sort(), ['a', 'b']);
});

test('the headline follows who the visitor is, then where they came from, then the A/B split', () => {
  const { surface, decider } = example('personalize-by-where-they-came-from.example.json');
  const fact = (path, value, trust_ref = 'trust:observer-supplied') => ({ path, value, trust_ref });
  const fromSearch = fact(['visit', 'utm_source'], 'example-search-engine');
  const team = fact(['company', 'size_band'], 'example-band-team', 'trust:enrichment');
  assert.equal(runByRow({ surface, decider, visitor: 'visitor-1', facts: [fromSearch] }).chosen.candidate_id, 'from-search');
  assert.equal(chosen({ surface, decider, visitor: 'visitor-1', facts: [fromSearch, team] }), 'for-teams');
  // A fact with a trust the decider does not list is not read.
  assert.match(chosen({ surface, decider, visitor: 'visitor-1', facts: [{ ...team, trust_ref: 'trust:guessed' }] }), /^default-/);
  assert.deepEqual([...new Set(visitors.map(visitor => chosen({ surface, decider, visitor })))].sort(), ['default-a', 'default-b']);
});
