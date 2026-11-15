// tools/evaluate-progress/test/tallies-are-measures.test.mjs
//
// The streaks, counts, means and quantiles of evaluate-progress are the list engine's measures (query-and-change-list-rows
// list-aggregates `measure`, the aggregate rows of lists.json run by the formula engine); the files hold none of their own
// arithmetic. Each case here is checked against the arithmetic the file used to hold (written out below as the oracle).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { currentStreak } from '../read-data/board-habit.ts';
import { adherenceRate, completionsInPeriod, periodStartOf, prevPeriodStart } from '../read-data/board-habit-cadence.ts';
import { OPS } from '../read-data/progression.mjs';
import { measureOps } from '../read-data/measure-ops.ts';

const DAY = 86_400_000;
const read = name => readFileSync(new URL(`../read-data/${name}`, import.meta.url), 'utf8');
const dayStart = ms => Math.floor(ms / DAY) * DAY;
// A fixed pseudo-random run, so a failure repeats.
const seeded = seed => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

const retiredCurrentStreak = (log, now) => {
  const days = new Set(log);
  const today = dayStart(now);
  const anchor = days.has(today) ? today : days.has(today - DAY) ? today - DAY : null;
  if (anchor === null) return 0;
  let streak = 0;
  for (let d = anchor; days.has(d); d -= DAY) streak += 1;
  return streak;
};
const retiredCompletions = (log, period, at) => log.filter(day => periodStartOf(day, period) === periodStartOf(at, period)).length;
const retiredAdherence = (log, cadence, now, periods) => {
  let met = 0;
  let p = periodStartOf(now, cadence.period);
  for (let i = 0; i < periods; i += 1) {
    if (retiredCompletions(log, cadence.period, p) >= cadence.times) met += 1;
    p = prevPeriodStart(p, cadence.period);
  }
  return met / periods;
};

const logsAndClocks = () => {
  const random = seeded(7);
  const base = Date.UTC(2026, 10, 15);
  return Array.from({ length: 60 }, () => {
    const log = [...new Set(Array.from({ length: Math.floor(random() * 40) }, () => dayStart(base - Math.floor(random() * 90) * DAY)))].sort((a, b) => a - b);
    return { log, now: base + Math.floor(random() * 3) * DAY + Math.floor(random() * DAY) };
  });
};

test('the current streak is the list engine streak, equal to the arithmetic it replaced', () => {
  for (const { log, now } of logsAndClocks()) assert.equal(currentStreak(log, now), retiredCurrentStreak(log, now));
  assert.equal(currentStreak([], Date.UTC(2026, 10, 15)), 0);
  assert.equal(currentStreak([Date.UTC(2026, 10, 15)], Number.NaN), 0);
});

test('completions in a period and adherence are counted and averaged by the engine, equal to the arithmetic they replaced', () => {
  for (const { log, now } of logsAndClocks()) for (const period of ['day', 'week', 'month']) {
    assert.equal(completionsInPeriod(log, period, now), retiredCompletions(log, period, now));
    for (const times of [1, 2, 3]) assert.ok(Math.abs(adherenceRate(log, { period, times }, now, 9) - retiredAdherence(log, { period, times }, now, 9)) < 1e-12);
  }
});

test('weighted_count is the list engine weighted measure: each fact counts as its input weight, 1 where none', () => {
  const facts = n => Array.from({ length: n }, (_, i) => ({ id: `f${i}` }));
  assert.equal(OPS.weighted_count([{ facts: facts(2) }, { facts: facts(3) }], { weights: [3, 1] }).value, 9);
  assert.equal(OPS.weighted_count([{ facts: facts(2) }, { facts: facts(3) }], { weights: [3] }).value, 9);
  assert.equal(OPS.weighted_count([{ facts: facts(2) }, { facts: facts(3) }], {}).value, 5);
  assert.equal(OPS.weighted_count([{ facts: [] }], { weights: [4] }).value, 0);
  assert.equal(OPS.weighted_count([{ facts: facts(2) }, { facts: facts(1) }], { weights: [0.5, 'x'] }).value, 2);
});

const input = (values, field = ['x']) => ({ facts: values.map((x, i) => ({ id: `f${i}`, x })), selector: { match: {}, field } });
const run = (op, values, params = {}, more = []) => measureOps[op]([input(values), ...more], params).value;

test('sum, distinct, ratio, quantile and the formula reducers are the engine measures', () => {
  assert.equal(run('sum', [1, 2.5, 'x', '4']), 7.5);
  assert.equal(run('sum', []), 0);
  assert.equal(run('distinct', ['a', 'b', 'a', 1, '1', null, null]), 5);
  assert.equal(run('ratio', [1, 2, 3], { mode: 'sum' }, [input([2, 2])]), 1.5);
  assert.equal(run('ratio', [1, 2, 3], {}, [input([2, 2])]), 1.5);
  assert.equal(run('ratio', [1], {}, [input([])]), 0);
  const data = [3, 1, 4, 1, 5, 9, 2, 6];
  assert.equal(run('quantile', data, { q: 0.5 }), 3.5);
  assert.equal(run('quantile', data, { reduce: 'max' }), 9);
  assert.equal(run('quantile', data, { reduce: 'min' }), 1);
  assert.equal(run('quantile', data, { q: 7 }), 9);
  assert.equal(run('quantile', [], {}), null);
  const formula = reduce => measureOps.formula([input(data)], { expr: { input: 0, reduce } }).value;
  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  const variance = data.reduce((a, b) => a + (b - mean) ** 2, 0) / data.length;
  for (const [reduce, expected] of [['count', 8], ['sum', 31], ['mean', mean], ['min', 1], ['max', 9], ['variance', variance], ['stdev', Math.sqrt(variance)]]) {
    assert.ok(Math.abs(formula(reduce) - expected) < 1e-9, `${reduce} ${formula(reduce)} is not ${expected}`);
  }
});

test('rollup sums, counts and averages each group through the engine', () => {
  const facts = [{ id: 'a', g: 'x', n: 2 }, { id: 'b', g: 'x', n: 4 }, { id: 'c', g: 'y', n: 'q' }, { id: 'd', g: 'y', n: 3 }];
  const rolled = reduce => measureOps.rollup([{ facts, selector: { match: {}, field: ['n'] } }], { groupBy: ['g'], reduce }).value.groups;
  assert.deepEqual(rolled('count'), { x: 2, y: 2 });
  assert.deepEqual(rolled('sum'), { x: 6, y: 3 });
  assert.deepEqual(rolled('avg'), { x: 3, y: 1.5 });
});

test('the files hold none of the arithmetic the engine does', () => {
  for (const name of ['board-habit.ts', 'board-habit-cadence.ts', 'progression.mjs', 'measure-ops.ts']) {
    assert.match(read(name), /from 'trillion-workshop\/tools\/query-and-change-list-rows\/src\/list-aggregates\.mjs'/, name);
  }
  assert.doesNotMatch(read('board-habit.ts'), /for \(let d = anchor/);
  assert.doesNotMatch(read('board-habit-cadence.ts'), /n \+= 1|met \+= 1/);
  assert.doesNotMatch(read('progression.mjs'), /input\.facts\.length \* /);
  assert.doesNotMatch(read('measure-ops.ts'), /nums\.reduce|numbersOf\([^)]*\)\.reduce|Math\.min\(\.\.\.nums\)|Math\.max\(\.\.\.nums\)|new Set<unknown>/);
});
