// tools/price-and-sell-by-contract/test/usage-meters-are-measures.test.mjs
//
// A meter's listed base rate is the list engine's measure (max or min, the aggregate row its `take` names) of the rates the records
// give, and a day's work is the engine's sum of the dollars read; usage-meters.mjs holds no arithmetic of its own for either.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { meterDayDollars, meterOf, meterPrice } from '../src/usage-meters.mjs';

// A meter whose rate is read from rows: the storage meter itself names its own rate, so this one names the rows' kind and path.
const stored = { ...meterOf('meter:stored-gigabytes'), cost: { records: 'rate-rows', path: ['price', 'per_unit'], take: 'max', margin: 1.3 } };
const origins = rates => new Map([[stored.cost.records, rates.map(rate => ({ price: { per_unit: rate } }))]]);

test('the base rate is the largest rate the records give, as the meter takes max', () => {
  assert.equal(stored.cost.take, 'max');
  assert.deepEqual(meterPrice(stored, origins([0.015, 0.0069, 0.02])), { cost_dollars: 0.02, cents_per_unit: 3 });
  assert.equal(meterPrice(stored, origins([0.015])).cost_dollars, 0.015);
});

test('a meter that takes min reads the smallest rate; one with no rows, or an aggregate that is not a number measure, is refused', () => {
  const cheapest = { ...stored, cost: { ...stored.cost, take: 'min' } };
  assert.equal(meterPrice(cheapest, origins([0.015, 0.0069, 0.02])).cost_dollars, 0.0069);
  assert.throws(() => meterPrice(stored, origins([])), /cannot read/);
  assert.throws(() => meterPrice({ ...stored, cost: { ...stored.cost, take: 'highest' } }, origins([0.02])), /cannot read/);
  assert.throws(() => meterPrice({ ...stored, cost: { ...stored.cost, take: 'distinct' } }, origins([0.02])), /cannot read/);
});

test('a day of work is the sum of its dollars; a reading that is not a number adds nothing and no rows read 0', async () => {
  const use = rows => async () => ({ days: rows });
  assert.equal(await meterDayDollars(use([{ day: 'd1', dollars: 1.25 }, { day: 'd1', dollars: 0.5 }, { day: 'd2', dollars: 9 }, { day: 'd1', dollars: null }, { day: 'd1', dollars: 'x' }]))('d1'), 1.75);
  assert.equal(await meterDayDollars(use([{ day: 'd2', dollars: 9 }]))('d1'), 0);
});

test('the file keeps no table or fold of its own for either', () => {
  const source = readFileSync(new URL('../src/usage-meters.mjs', import.meta.url), 'utf8');
  assert.match(source, /from 'trillion-workshop\/tools\/query-and-change-list-rows\/src\/list-aggregates\.mjs'/);
  assert.doesNotMatch(source, /Math\.max\(\.\.\.values\)|Math\.min\(\.\.\.values\)|sum \+ \(Number\.isFinite/);
});
