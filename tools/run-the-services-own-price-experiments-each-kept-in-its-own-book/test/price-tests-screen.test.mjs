// The Price tests screen reads each experiment's results as one row per price, with each price's chance of being the
// best (a draw over who paid and what they paid), and charts only the running tests.
//
// Ported from the old repository's test/price-tests-screen.test.mjs (commit b6ae0ebf81, 84 lines, 4 tests), which the move left
// behind. Its four tests are here with every assertion unchanged, over the moved screen and results code
// (web/src/price-tests-screen.mjs, web/src/price-experiments.mjs). The fourth read the old screen-tool record
// (tool:screen-price-tests); its Workshop home is tools/read-a-list-view/part.json, which it now reads. That the record
// points at /work/api/price-tests does not mean anything answers there: nothing does yet (research row verify-every-port/run-the-services-own-price-experiments-each-kept-in-its-own-book).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chanceBest, experimentResults } from '../web/src/price-experiments.mjs';
import { priceTestsAnswer } from '../web/src/price-tests-screen.mjs';
import listViews from '../../read-a-list-view/part.json' with { type: 'json' };

const arm = (id, shown, paid, money) => ({ arm: id, shown, paid, money_cents: money, amount_cents: 10000 });

test('the chance of being the best price is unknown before anyone pays, sums to one, and favours the price that brings in more', () => {
  assert.equal(chanceBest([arm('a', 50, 0, 0), arm('b', 50, 0, 0)]), null);
  assert.equal(chanceBest([arm('a', 50, 5, 50000)]), null);
  const chance = chanceBest([arm('low', 200, 4, 40000), arm('high', 200, 20, 200000)]);
  assert.ok(Math.abs(chance.low + chance.high - 1) < 1e-9);
  assert.ok(chance.high > 0.95, `the clear winner leads: ${JSON.stringify(chance)}`);
  assert.deepEqual(chanceBest([arm('low', 200, 4, 40000), arm('high', 200, 20, 200000)]), chance, 'the same results give the same chances');
});

test('each price is a row with its share who paid and money in dollars; only running tests are charted', () => {
  const experiment = { id: 'experiment:plan', label: 'Plan price', state: 'running', arms: [
    { id: 'offer:a', label: '$100/month', amount_cents: 10000, currency: 'usd', interval: 'month', weight: 1 },
    { id: 'offer:b', label: '$150/month', amount_cents: 15000, currency: 'usd', interval: 'month', weight: 1 },
  ] };
  const events = [
    ...['p1', 'p2', 'p3', 'p4'].map(who => ({ event: 'price_shown', arm: 'offer:a', subject_id: who })),
    ...['q1', 'q2'].map(who => ({ event: 'price_shown', arm: 'offer:b', subject_id: who })),
    { event: 'price_paid', arm: 'offer:a', subject_id: 'p1', amount_cents: 10000 },
  ];
  const running = experimentResults(experiment, events);
  const settled = experimentResults({ ...experiment, id: 'experiment:old', label: 'Old test', state: 'settled', result: { winner: 'offer:b' } }, []);
  const answer = priceTestsAnswer([running, settled]);
  assert.equal(answer.view.preference_key, 'price-tests');
  assert.equal(answer.items.length, 4);
  const low = answer.items.find(item => item.id === 'experiment:plan:offer:a');
  assert.deepEqual([low.price, low.shown, low.paid, low.paid_percent, low.money, low.money_per_shown, low.leading], ['$100/month', 4, 1, 25, 100, 25, 'Leading']);
  const chances = answer.items.filter(item => item.experiment_id === 'experiment:plan').map(item => item.chance_best);
  assert.ok(Math.abs(chances[0] + chances[1] - 100) < 0.2, 'a running test\'s chances add up to all of it');
  assert.equal(answer.items.find(item => item.id === 'experiment:plan:offer:b').paid_percent, 0);
  assert.equal(answer.items.find(item => item.id === 'experiment:old:offer:b').standing, 'Everyone sees $150/month');
  assert.deepEqual(answer.running.map(item => item.chart_label), ['$100/month', '$150/month'], 'a running test charts its prices by their own labels');
  assert.ok(answer.view.charts.length && answer.view.charts.every(chart => chart.where.one_of[0] === 'experiment:plan'), 'only the running test is charted, each chart kept to its prices');
  assert.equal(answer.view.charts[0].title, 'Which price is winning', 'the first chart answers which price is winning');
  assert.match(answer.view.charts[0].description, /^\$1[05]0\/month is winning: \d+(\.\d)?% sure it brings in the most money per person shown\.$/);
  const same = priceTestsAnswer([experimentResults({ ...experiment, arms: experiment.arms.map(row => ({ ...row, label: 'Your own site' })) }, [])]);
  assert.deepEqual(same.items.map(item => item.chart_label), ['Your own site at $100.00/month', 'Your own site at $150.00/month'], 'two prices with one label are told apart by their amount');
  assert.equal(answer.chances.length, 2);
  for (const chart of answer.view.charts) assert.ok(Array.isArray(answer[chart.records_path[0]]), `${chart.id} reads rows the answer carries`);
  const [settle, stop] = answer.view.actions;
  assert.deepEqual([settle.input.operation, stop.input.operation], ['settle', 'stop'], 'a row shows everyone its price or stops its test');
  assert.deepEqual(settle.copy.map(copy => [copy.key, copy.from]), [['experiment_id', 'record.payload.experiment_id'], ['winner', 'record.payload.arm']]);
  assert.deepEqual(stop.copy.map(copy => [copy.key, copy.from]), [['experiment_id', 'record.payload.experiment_id']]);
  assert.ok(low.experiment_id && low.arm, 'every row carries what the action copies');
});

test('our own test accounts are left out of the people counted, and the screen says how many there were and where people stop', () => {
  const experiment = { id: 'experiment:plan', label: 'Plan price', state: 'running', arms: [
    { id: 'offer:a', offer_id: 'offer:a', label: '$100 a spot', amount_cents: 10000, currency: 'usd', interval: 'month', weight: 1 },
    { id: 'offer:b', offer_id: 'offer:b', label: '$150 a spot', amount_cents: 15000, currency: 'usd', interval: 'month', weight: 1 },
  ] };
  // 3 and 4 visitors counted on the prices (own accounts are never counted there); 7 and 6 own proof accounts kept on
  // them; on b a real person kept since before the count started; 2 real people started checkout on a.
  const kept = { shown: { 'offer:a': ['real-1'], 'offer:b': ['real-2'] }, own: { 'offer:a': ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], 'offer:b': ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'] } };
  const results = experimentResults(experiment, [], kept, { 'offer:a': 3, 'offer:b': 4 }, { 'offer:a': 2 });
  assert.deepEqual(results.arms.map(arm => [arm.shown, arm.own, arm.people, arm.checkout_started]), [[10, 7, 3, 2], [10, 6, 4, 0]]);
  const answer = priceTestsAnswer([results]);
  const [winning, people, way] = answer.view.charts;
  assert.equal(winning.description, 'No price is winning yet: none of the 7 real people shown a price has paid.');
  assert.equal(winning.empty.description, winning.description, 'with nobody paid the empty chart still says why');
  assert.equal(people.description, '13 of the 20 shown were our own test accounts, left out here.');
  assert.deepEqual(answer.stages.map(stage => [stage.stage, stage.count]), [['Shown a price', 7], ['Started checkout', 2], ['Paid', 0]]);
  assert.match(way.description, /^Most stop between shown a price and started checkout: 7 to 2\./);
  assert.equal(answer.drops[0].from, 'Shown a price');
  const nobody = priceTestsAnswer([experimentResults(experiment, [], { own: { 'offer:a': ['p1'] } })]);
  assert.equal(nobody.view.charts[0].description, 'No price is winning yet: no real people have been shown a price.');
});


const find = (value, id) => (Array.isArray(value) ? value.map(item => find(item, id)).find(Boolean)
  : value && typeof value === 'object' ? (value.id === id ? value : Object.values(value).map(item => find(item, id)).find(Boolean)) : undefined);

test('the Price tests screen opens from the sidebar and reads its own address', () => {
  const row = find(listViews, 'tool:screen-price-tests');
  assert.equal(row.screen.entry, 'record-set');
  assert.equal(row.screen.surface.surface_input.records_url, '/work/api/price-tests');
  assert.deepEqual(row.screen.surface.route_paths, ['/price-tests']);
  assert.ok(row.screen.surface.sidebar_collection);
});
