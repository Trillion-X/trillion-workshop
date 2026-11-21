// rules/variants.json: the formulas a workflow step with variants runs on (the split rule among them), each kept as text
// and as the binding this engine compiles it into. Run through the shipped engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, evaluate, compileText } from '../built-stored-bytes/formula-engine/formula_engine.js';

initSync({ module: readFileSync(new URL('../built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) });
const rules = JSON.parse(readFileSync(new URL('../rules/variants.json', import.meta.url), 'utf8'));
const run = (name, row) => evaluate({ binding: rules.formulas[name].binding, input: row }).value;
const arm = (variant, runs, successes, mean_measure) => ({ variant, runs, successes, mean_measure });

test('each binding is what its text compiles into, and reads only the names it declares', () => {
  for (const [name, formula] of Object.entries(rules.formulas)) {
    assert.deepEqual(formula.binding, compileText({ text: formula.text }).binding, `${name}: run node tools/write-a-job-done-in-several-steps-have/read-data/compile-variant-formulas.mjs`);
    const read = new Set();
    const walk = node => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if (node.select?.from === 'context') read.add(node.select.path[0]);
      Object.values(node).forEach(walk);
    };
    walk(formula.binding);
    assert.deepEqual([...read].sort(), [...formula.names].sort(), `${name} reads ${[...read]}`);
  }
  assert.ok(rules.split.explore_share >= 0 && rules.split.explore_share <= 1);
  assert.ok(Number.isInteger(rules.split.min_runs) && rules.split.min_runs >= 0);
});

test('the leader has the highest share of passed runs, then the best mean measure, then comes first', () => {
  const tally = [arm('a', 4, 4, 5), arm('b', 4, 1, 50), arm('c', 4, 4, 9)];
  assert.equal(run('leader', { tally, sign: 1 }), 'c');
  assert.equal(run('leader', { tally, sign: -1 }), 'a', 'the lowest mean wins when the lowest measure is best');
  assert.equal(run('leader', { tally: [arm('a', 3, 1, 5), arm('b', 2, 1, 1)], sign: 1 }), 'b', 'one in two beats one in three');
  assert.equal(run('leader', { tally: [arm('a', 2, 2, null), arm('b', 2, 2, 1)], sign: -1 }), 'b', 'a missing measure is worst either way');
  assert.equal(run('leader', { tally: [arm('a', 2, 2, 3), arm('b', 2, 2, 3)], sign: 1 }), 'a');
});

test('the split runs every variant short of min_runs, leans on the leader, and explores at the set share beside it', () => {
  const choose = (tally, total, explore_share = 0.2, min_runs = 2, leader = 'c') => run('choose', { tally, total, explore_share, min_runs, leader });
  assert.deepEqual(choose([arm('a', 1, 1, 3), arm('b', 2, 2, 3), arm('c', 0, 0, null)], 3), ['a', 'c']);
  const warm = [arm('a', 2, 2, 5), arm('b', 3, 0, null), arm('c', 9, 9, 9)];
  // Out of runs 1 to 20 at a share of 0.2, runs 5, 10, 15 and 20 explore: the run being chosen is total + 1.
  const exploring = Array.from({ length: 20 }, (_, total) => choose(warm, total)).map((chosen, total) => (chosen.length > 1 ? total + 1 : null)).filter(Boolean);
  assert.deepEqual(exploring, [5, 10, 15, 20]);
  assert.deepEqual(choose(warm, 4), ['c', 'a'], 'an exploring run runs the leader and the other variant with the fewest runs');
  assert.deepEqual(choose(warm, 5), ['c']);
  assert.deepEqual(choose(warm, 4, 0), ['c'], 'a share of 0 never explores');
  assert.deepEqual(choose(warm, 4, 1), ['c', 'a'], 'a share of 1 always does');
  assert.deepEqual(choose([arm('c', 5, 5, 1), arm('d', 5, 0, null)], 9, 1, 0), ['c', 'd']);
  assert.deepEqual(choose([arm('c', 5, 5, 1)], 9, 1, 0), ['c'], 'with one variant there is nothing else to try');
});

test('the compare records are small, a tolerated failure is named, and the winner passed with the best measure', () => {
  const record = (variant, checks_passed, measure) => ({ variant, status: checks_passed ? 'completed' : 'failed', checks_passed, failed_check: checks_passed ? null : 'At least two words ("w0")', measure, duration_ms: 3, cost: null, tokens: null, summary: null });
  const outs = [{ record: record('a', true, 3), output: { words: ['x'] } }, { tolerated_error: { iteration_index: 1, item: 'b', error: 'Loop item failed' } }, { record: record('c', true, 7), output: { words: ['y'] } }];
  const records = run('records', { outs });
  assert.deepEqual(records.map(each => [each.variant, each.status, each.failed_check]), [['a', 'completed', null], ['b', 'error', 'Loop item failed'], ['c', 'completed', null]]);
  assert.ok(records.every(each => !('output' in each)));
  assert.equal(run('winner', { records, sign: 1 }), 'c');
  assert.equal(run('winner', { records, sign: -1 }), 'a');
  assert.equal(run('winner', { records: [record('a', false, 9)], sign: 1 }), null);
  assert.deepEqual(run('winner_output', { outs, winner: 'c' }), { words: ['y'] });
  assert.equal(run('winner_output', { outs, winner: null }), null);
  assert.equal(run('none_passed', { records: [record('a', false, null), records[1]] }), 'No variant passed its checks: a (At least two words ("w0")); b (Loop item failed)');
});
