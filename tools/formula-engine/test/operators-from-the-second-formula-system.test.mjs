// The operators the second formula system (shared-code crates formula-core and formula-ast) had and this engine did
// not, now registered in composition-ast over ops-core and called here through the shipped engine
// (built-stored-bytes/formula-engine): is_nan, is_finite, cbrt, fsum, fmedian, dt_format, dt_format_time, dt_start_of,
// dt_end_of, dt_workdays, hmac, graph_parents, graph_children, graph_neighbors, graph_traverse and reduce.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, evaluate } from '../built-stored-bytes/formula-engine/formula_engine.js';

initSync({ module: readFileSync(new URL('../built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) });
const run = (input, ...transform) => evaluate({ binding: { $kind: 'binding', select: { from: 'self' }, transform }, input }).value;
const step = (op, args) => (args ? { op: `op:core.${op}`, args } : { op: `op:core.${op}` });

test('number checks and float aggregates', () => {
  assert.equal(run(27, step('cbrt')), 3);
  assert.equal(run(12.5, step('is_finite')), true);
  assert.equal(run(12.5, step('is_nan')), false);
  assert.equal(run('text', step('is_finite')), false);
  assert.equal(run([0.1, 0.2, 0.3], step('fsum')), 0.6000000000000001);
  assert.equal(run([5, 1, 4, 2], step('fmedian')), 3);
  assert.equal(run([], step('fsum')), null);
});

test('dates are written, bounded and counted on the zone wall clock', () => {
  const evening = '2024-01-16T02:30:00Z'; // 9:30 PM on Monday Jan 15 in New York
  assert.equal(run(evening, step('dt_format', { format: '%Y-%m-%d %H:%M', timezone: 'America/New_York' })), '2024-01-15 21:30');
  assert.equal(run(evening, step('dt_format', { format: '%Y-%m-%d' })), '2024-01-16');
  assert.equal(run(evening, step('dt_format_time', { format: '%H:%M', timezone: 'Asia/Kolkata' })), '08:00');
  assert.equal(run(evening, step('dt_start_of', { unit: 'day', timezone: 'America/New_York' })), '2024-01-15T00:00:00-05:00');
  assert.equal(run(evening, step('dt_end_of', { unit: 'month', timezone: 'America/New_York' })), '2024-01-31T23:59:59-05:00');
  assert.equal(run(evening, step('dt_start_of', { unit: 'week' })), '2024-01-15T00:00:00Z');
  // Havana skipped from 00:00 to 01:00 on 2024-03-10, so that day starts at 01:00.
  assert.equal(run('2024-03-10T15:00:00Z', step('dt_start_of', { unit: 'day', timezone: 'America/Havana' })), '2024-03-10T01:00:00-04:00');
  assert.equal(run('2024-01-15', step('dt_workdays', { end: '2024-01-26', holidays: ['2024-01-19', '2024-01-20'] })), 9);
  assert.throws(() => run(evening, step('dt_start_of', { unit: 'fortnight' })), /unsupported time unit/);
});

test('hmac signs a body the way a service signs its webhook', () => {
  const body = 'what do ya want for nothing?';
  assert.equal(run(body, step('hmac', { key: 'Jefe' })), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  assert.equal(run(body, step('hmac', { key: 'Jefe', encoding: 'base64' })), 'W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM=');
  assert.equal(run(body, step('hmac', { key: 'Jefe', algorithm: 'sha512' })).slice(0, 16), '164b7a7bfcf819e2');
  assert.throws(() => run(body, step('hmac', { key: 'Jefe', algorithm: 'md5' })), /use sha256 or sha512/);
});

test('graph operators walk the edges the rule hands over', () => {
  const edges = [
    { from: 'project', to: 'task', type: 'holds' },
    { from: 'task', to: 'person', type: 'assigned' },
    ['project', 'note'],
  ];
  assert.deepEqual(run('task', step('graph_parents', { edges })), ['project']);
  assert.deepEqual(run('project', step('graph_children', { edges, relationship: 'holds' })), ['task']);
  assert.deepEqual(run('project', step('graph_children', { edges })).sort(), ['note', 'task']);
  assert.deepEqual(run('task', step('graph_neighbors', { edges })).sort(), ['person', 'project']);
  assert.deepEqual(run('project', step('graph_traverse', { edges, path: 'project->task->person' })), ['person']);
  assert.deepEqual(run('person', step('graph_traverse', { edges, path: 'person<-task<-project' })), ['project']);
  assert.throws(() => run('a', step('graph_children', { edges: [['a', 'b'], ['b', 'a']] })), /close a loop/);
});

test('reduce folds a list with a chain from $acc, with each item bound', () => {
  const item = path => ({ $kind: 'binding', select: { from: 'vars', key: '$item', ...(path ? { path } : {}) } });
  const total = run([{ amount: 3 }, { amount: 4 }, { amount: 5 }],
    step('reduce', { initial: 0, step: [step('add', { value: item('amount') })] }));
  assert.equal(Number(total), 12);
  const joined = run(['a', 'b', 'c'],
    step('reduce', { initial: '', step: [step('concat', { suffix: item() })] }));
  assert.equal(joined, 'abc');
  assert.equal(run([], step('reduce', { initial: 7, step: [step('add', { value: 1 })] })), 7);
  assert.throws(() => run([1], step('reduce', { initial: 0 })), /reduce needs `step`/);
});
