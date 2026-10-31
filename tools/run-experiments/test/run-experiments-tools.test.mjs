// tools/run-experiments/test/run-experiments-tools.test.mjs
// Each tool runs the way its row runs it: its argv, in the folder its workdir stands for. The package's own tests
// cover the scoring, the sticky choice, the outcome counts and the join; these check the three commands and their rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const folder = resolve(import.meta.dirname, '..');
const rows = JSON.parse(readFileSync(resolve(folder, 'records.json'), 'utf8')).things.map(thing => thing.payload);
const bandit = JSON.parse(readFileSync(resolve(folder, 'data/decider-bandit.example.json'), 'utf8'));

/** Run a tool by its row: the whole input fills argv, in the folder its workdir stands for. */
function runByRow(toolId, input) {
  const row = rows.find(item => item.id === toolId);
  assert.ok(row, `${toolId} is a row in records.json`);
  assert.equal(row.invoke.workdir, row.invoke.files.package_files.at);
  const argv = row.invoke.argv.map(item => (typeof item === 'string' ? item : JSON.stringify(input)));
  const ran = spawnSync(process.execPath, argv.slice(1), { cwd: folder, encoding: 'utf8' });
  if (ran.status !== 0) return { refused: ran.stderr.trim() };
  return JSON.parse(ran.stdout.trim().split('\n').at(-1));
}

const surface = { entity_type: 'selection-surface', address: 'page:/offer', decider_program_ref: 'decider:bandit-outcome-shift', candidates: [{ candidate_id: 'a', material_ref: 'material:a' }, { candidate_id: 'b', material_ref: 'material:b' }] };

test('every row\'s sample run gives what its verify says', () => {
  for (const row of rows) {
    for (const check of row.verify.filter(item => item.kind === 'sample-run')) {
      const answer = runByRow(row.id, check.input);
      const picked = check.output_selector.slice(1).match(/[^.[\]]+/g).reduce((value, key) => value?.[key], answer);
      assert.ok(JSON.stringify(picked).includes(check.contains), `${row.id}: ${check.output_selector} contains ${check.contains}`);
    }
  }
});

test('a visitor is split the same way every time, and the winning version follows what the facts show', () => {
  const cold = runByRow('tool:choose-what-a-visitor-sees', { surface, decider: bandit, facts: [], visitor: 'visitor-1' });
  assert.deepEqual(runByRow('tool:choose-what-a-visitor-sees', { surface, decider: bandit, facts: [], visitor: 'visitor-1' }), cold);
  assert.ok(['a', 'b'].includes(cold.chosen.candidate_id));
  assert.equal(cold.ranked.filter(item => item.is_winner).length, 1);
  const trusted = { trust_ref: 'trust:derived' };
  const warm = runByRow('tool:choose-what-a-visitor-sees', {
    surface, decider: bandit, visitor: 'visitor-1',
    facts: [{ path: ['experiment', 'has_results'], value: true, ...trusted }, { path: ['candidate', 'outcome', 'conversion_rate', 'a'], value: 0.1, ...trusted }, { path: ['candidate', 'outcome', 'conversion_rate', 'b'], value: 0.4, ...trusted }],
  });
  assert.equal(warm.chosen.candidate_id, 'b');
});

test('a set that does not validate is refused with every problem listed', () => {
  const refused = runByRow('tool:choose-what-a-visitor-sees', { surface: { ...surface, candidates: [{ candidate_id: 'a', material_ref: 'material:a' }, { candidate_id: 'a', material_ref: 'material:b' }] }, decider: { entity_type: 'decider' } });
  assert.match(refused.refused, /surface: /);
  assert.match(refused.refused, /decider: /);
});

test('the results sum per candidate and name who leads on a rate', () => {
  const facts = [
    ['views', 'a', 100], ['converted', 'a', 10], ['views', 'b', 80], ['converted', 'b', 16],
  ].map(([metric, id, value]) => ({ path: ['candidate', 'outcome', metric, id], value }));
  const answer = runByRow('tool:read-experiment-results', { address: 'page:/offer', facts, rates: [{ id: 'rate', numerator: 'converted', denominator: 'views' }] });
  assert.equal(answer.candidates.a.views, 100);
  assert.equal(answer.candidates.b.rate, 0.2);
  assert.deepEqual(answer.leader, { rate: 'b' });
  assert.equal(answer.total_events, 4);
});

test('outcomes are credited to the version each visitor saw, once however often it runs', () => {
  const input = {
    join: {
      entity_type: 'attribution-join', join_id: 'join:offer',
      assignment: { observer_key_path: ['visitor'], candidate_key_path: ['candidate'] },
      outcome: { observer_key_path: ['visitor'], metric_path: ['what'], value_path: ['amount'] },
      emit: { observe_address: 'page:/offer', metric_map: { purchase: 'converted' }, value_metric: 'revenue' },
    },
    assignments: [{ visitor: 'v1', candidate: 'a' }, { visitor: 'v2', candidate: 'b' }],
    outcomes: [{ visitor: 'v1', what: 'purchase', amount: 30 }, { visitor: 'v2', what: 'purchase', amount: 50 }, { visitor: 'v2', what: 'purchase', amount: 20 }],
    at: '2026-01-01T00:00:00.000Z',
  };
  const first = runByRow('tool:credit-outcomes-to-candidates', input);
  assert.deepEqual(runByRow('tool:credit-outcomes-to-candidates', input), first);
  const byPath = new Map(first.observations.map(item => [item.path.join('/'), item.value]));
  assert.equal(byPath.get('candidate/outcome/converted/b'), 2);
  assert.equal(byPath.get('candidate/outcome/revenue/b'), 70);
  assert.match(runByRow('tool:credit-outcomes-to-candidates', { ...input, join: { entity_type: 'attribution-join' } }).refused, /./);
});
