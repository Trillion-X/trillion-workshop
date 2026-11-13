// src/price-tests-screen.mjs
//
// PURPOSE
//   The Price tests screen's answer (a record set: { view, items, running, chances, stages }): one row per price in each
//   of an account's price experiments, from their results (src/price-experiments.mjs experimentResults); for each
//   running test, which price is winning and how sure that is, then the rows of its prices again and the steps from
//   seeing a price to paying for the charts above the list. The operator account's tests are Trillion's own plan prices.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every number is the experiment's own result; nothing is estimated here. A price nobody was shown has no share.
//   2. Money is drawn in dollars from the results' cents; shares and chances in percent.
//   3. Each running test has its own charts (the view's `charts_per_test`, each kept to that test's rows by `where`),
//      so two tests' prices never add up into one bar; a price is named by its label, with its amount added only when
//      another price of the same test has the same label.
//   4. Counts are of real people: the service's own test accounts are left out of every share and chance, and how many
//      there were is said beside the people shown.
//   5. The first chart of a test answers which price is winning and how sure; when none can be, it says why.
//   6. The screen's words, fields, charts and its actions are DATA (src/price-tests-screen.json).
//
import screen from './price-tests-screen.json' with { type: 'json' };
import { checkoutsCountedFrom, priceWords } from './price-experiments.mjs';

const say = (words, values) => words.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
const dollars = cents => (Number.isFinite(cents) ? cents / 100 : null);
const percent = share => (Number.isFinite(share) ? Math.round(share * 1000) / 10 : null);

/** What a test's charts say: which price is winning and how sure, how many shown were the service's own accounts,
 *  and where most people stop on the way to paying. */
function testWords(test, rows) {
  const words = screen.words;
  const shown = rows.reduce((sum, row) => sum + row.shown, 0);
  const own = rows.reduce((sum, row) => sum + row.own, 0);
  const people = rows.reduce((sum, row) => sum + row.people, 0);
  const lead = rows.filter(row => row.chance_best !== null).sort((a, b) => b.chance_best - a.chance_best)[0];
  const verdict = lead ? say(words.verdict_leading, { price: lead.chart_label, chance: String(lead.chance_best) })
    : people ? say(words.verdict_nobody_paid, { people: String(people) }) : words.verdict_nobody_shown;
  const stages = Object.entries(words.stages).map(([field, label]) => ({ experiment_id: test.id, stage: label, count: rows.reduce((sum, row) => sum + (row[field] ?? 0), 0) }));
  const drops = stages.slice(1).map((stage, at) => ({ from: stages[at], to: stage, lost: stages[at].count - stage.count }));
  const biggest = drops.sort((a, b) => b.lost - a.lost)[0];
  const drop = !people || !biggest ? words.no_drop
    : `${say(words.biggest_drop, { from: biggest.from.stage.toLowerCase(), to: biggest.to.stage.toLowerCase(), before: String(biggest.from.count), after: String(biggest.to.count) })} ${say(words.checkouts_since, { since: sinceWords(checkoutsCountedFrom) })}`;
  return { values: { test: test.label, verdict, own_left_out: say(words.own_left_out, { own: String(own), shown: String(shown) }), drop }, stages, biggest };
}
const sinceWords = hour => new Date(`${hour}:00:00Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', timeZone: 'UTC', timeZoneName: 'short' });

/** The screen's answer from each experiment's results (experimentResults' shape). */
export function priceTestsAnswer(results) {
  const tests = (results ?? []).filter(Boolean);
  const running = tests.filter(test => test.state === 'running');
  const items = tests.flatMap(test => test.arms.map(arm => {
    const winner = test.result?.winner;
    const shared = test.arms.filter(other => other.label === arm.label).length > 1;
    return {
      id: `${test.id}:${arm.arm}`,
      experiment_id: test.id,
      arm: arm.arm,
      experiment: test.label,
      state: test.state,
      standing: winner ? say(screen.words.settled_on, { winner: test.arms.find(row => row.arm === winner)?.label ?? winner }) : screen.words.standing[test.state] ?? test.state,
      price: arm.label,
      chart_label: shared ? say(screen.words.same_label, { label: arm.label, price: priceWords(arm) }) : arm.label,
      shown: arm.shown,
      own: arm.own ?? 0,
      people: arm.people ?? arm.shown,
      checkout_started: arm.checkout_started ?? 0,
      paid: arm.paid,
      paid_percent: percent(arm.paid_share),
      money: dollars(arm.money_cents),
      money_per_shown: dollars(arm.money_per_shown_cents),
      chance_best: percent(arm.chance_best),
      leading: winner ? (winner === arm.arm ? screen.words.winner : '') : test.leading === arm.arm ? screen.words.leading : '',
    };
  }));
  const live = items.filter(item => item.state === 'running');
  const said = running.map(test => ({ test, ...testWords(test, live.filter(item => item.experiment_id === test.id)) }));
  const fill = (words, values) => (words ? say(words, values) : words);
  const charts = said.flatMap(({ test, values }) => screen.charts_per_test.charts.map(chart => ({
    ...chart, id: `${test.id}:${chart.id}`, description: fill(chart.description, values),
    ...(chart.empty ? { empty: { ...chart.empty, ...(chart.empty.description ? { description: fill(chart.empty.description, values) } : {}) } } : {}),
    where: { path: ['experiment_id'], one_of: [test.id] },
  })));
  return {
    view: { ...screen.view, charts }, items, running: live, chances: live.filter(item => item.chance_best !== null),
    stages: said.flatMap(({ stages }) => stages),
    drops: said.map(({ test, biggest, values }) => ({ experiment_id: test.id, experiment: test.label, from: biggest?.from.stage ?? null, to: biggest?.to.stage ?? null, before: biggest?.from.count ?? 0, after: biggest?.to.count ?? 0, said: values.drop })),
  };
}
