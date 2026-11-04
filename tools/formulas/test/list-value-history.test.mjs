// A field's values over time (src/list-value-history.mjs) and the road every write came by (src/write-via.mjs): a field
// that keeps its history keeps each value it held with when it began and who wrote it, a `history` field answers
// value_at, previous_value, value_set_at, time_spent_in and has_been_in from it on every read (so a saved view's rules, run
// by the formula engine, filter on it), and the lines a person reads say who changed what and by which road. Runs
// against the real record store, in strict model mode when RECORD_MODEL_STRICT=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { handleListsRequest, makeLists } from '../../keep-lists-of-rows/lists.mjs';
import { historyValues, keepValueHistory } from '../read-data/list-value-history.mjs';
import { viaOf, viaWords } from '../read-data/write-via.mjs';
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };

const evaluator = makeRowFilter({ operators, wasm: () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url)) });
const ruleKinds = new Map(settings.field_kinds.map(kind => [kind.id, kind.ruleKind]));
const views = { filterRows: input => evaluator.filterRowsByRules(input), ruleKindOf: kind => ruleKinds.get(kind) ?? kind,
  evaluateBinding: async (binding, input) => (await evaluator.evaluateBinding({ binding, input })).value };
const fresh = t => {
  const store = localStore(':memory:');
  t.after(() => store.close?.());
  const lists = makeLists({ eeaf: store.eeaf });
  const ask = async (path, body, app) => {
    const headers = app ? { 'x-trillion-app': app } : {};
    const response = await handleListsRequest(lists, new Request(`https://person${path}`, body ? { method: 'POST', body: JSON.stringify(body), headers } : { headers }), views);
    return { status: response.status, body: await response.json() };
  };
  return { store, lists, ask };
};
const DAY = 86_400_000;
const iso = ms => new Date(ms).toISOString();
const deals = {
  id: 'deals', label: 'Deals', stamps: true, fields: [
    { id: 'name', label: 'Name' },
    { id: 'stage', label: 'Stage', kind: 'choice', choices: ['Lead', 'Negotiation', 'Won', 'Lost'], keeps_history: true },
    { id: 'was_stage', label: 'Stage before', kind: 'history', history: { field: 'stage', op: 'previous_value' } },
    { id: 'stage_since', label: 'In this stage since', kind: 'history', history: { field: 'stage', op: 'value_set_at' } },
    { id: 'ever_lost', label: 'Ever lost', kind: 'history', history: { field: 'stage', op: 'has_been_in', value: 'Lost' } },
    { id: 'negotiating_days', label: 'Days negotiating', kind: 'history', history: { field: 'stage', op: 'time_spent_in', value: 'Negotiation' } },
  ],
};

test('a write keeps each value a history field held, and the history fields read it on every read', async t => {
  const { lists, ask } = fresh(t);
  assert.equal((await ask('/lists', deals)).status, 200);
  await ask('/lists/deals/rows', { rows: [{ id: 'acme', values: { name: 'Acme', stage: 'Lead' } }] }, 'Claude Code');
  await ask('/lists/deals/rows', { rows: [{ id: 'acme', values: { stage: 'Negotiation' } }] }, 'Claude Code');
  await ask('/lists/deals/rows', { rows: [{ id: 'acme', values: { name: 'Acme Inc' } }] }, 'Claude Code');
  const row = (await lists.row('deals', 'acme')).values;
  assert.deepEqual(row._history.stage.steps.map(step => step.v), ['Lead', 'Negotiation'], 'a write that did not change the stage leaves its history alone');
  assert.equal(row._history.stage.cut, false);
  assert.deepEqual(row._history.stage.steps[1].via, { app: 'Claude Code', basis: 'client_declared' });
  const read = (await ask('/lists/deals')).body.rows.find(item => item.id === 'acme').values;
  assert.equal(read.was_stage, 'Lead');
  assert.equal(read.stage_since, row._history.stage.steps[1].at);
  assert.equal(read.ever_lost, false, 'the whole history is kept, so never Lost is known');
  assert.ok(read.negotiating_days >= 0 && read.negotiating_days < 1);
  // A history field keeps no value: a write naming it is refused like any computed field.
  assert.equal((await ask('/lists/deals/rows', { rows: [{ id: 'acme', values: { was_stage: 'Won' } }] })).status, 400);
});

test('the history ops are interval arithmetic, and an answer that needs history not kept is null', () => {
  const now = Date.parse('2026-10-19T00:00:00Z');
  const kept = { _history: { stage: { cut: false, steps: [{ v: 'Lead', at: iso(now - 30 * DAY) }, { v: 'Negotiation', at: iso(now - 20 * DAY) }, { v: 'Lead', at: iso(now - 15 * DAY) }, { v: 'Negotiation', at: iso(now - 3 * DAY) }] } } };
  const field = (id, history) => ({ id, kind: 'history', history: { field: 'stage', ...history } });
  const answer = historyValues(kept, [
    field('a', { op: 'time_spent_in', value: 'Negotiation' }), field('h', { op: 'time_spent_in', value: 'Negotiation', unit: 'hours' }),
    field('b', { op: 'value_at', at: iso(now - 17 * DAY) }), field('c', { op: 'value_at', days_ago: 25 }), field('d', { op: 'value_at', days_ago: 40 }),
    field('e', { op: 'has_been_in', value: 'Won' }), field('f', { op: 'previous_value' }), field('g', { op: 'value_set_at' }),
  ], now);
  assert.deepEqual(answer, { a: 8, h: 192, b: 'Negotiation', c: 'Lead', d: null, e: false, f: 'Lead', g: iso(now - 3 * DAY) });
  // A row whose field kept history only after it already held a value: its start is not known.
  const late = keepValueHistory({ fields: [{ id: 'stage', keeps_history: true }] }, { stage: 'Won' }, { before: { stage: 'Negotiation' }, at: iso(now), actor: { by: 'app:x' } });
  assert.deepEqual(late._history.stage.steps.map(step => [step.v, step.at]), [['Negotiation', null], ['Won', iso(now)]]);
  assert.deepEqual(historyValues(late, [field('a', { op: 'time_spent_in', value: 'Negotiation' }), field('e', { op: 'has_been_in', value: 'Lost' }), field('f', { op: 'previous_value' })], now),
    { a: null, e: null, f: 'Negotiation' });
});

test('a saved view filters on a history field through the formula engine', async t => {
  const { ask } = fresh(t);
  await ask('/lists', { ...deals, views: [{ id: 'came-back', label: 'Came back from Lost', rules: { kind: 'group', combinator: 'and', rules: [{ kind: 'rule', field: 'ever_lost', operator: 'is_true', params: {} }] } }] });
  await ask('/lists/deals/rows', { rows: [{ id: 'a', values: { name: 'A', stage: 'Lost' } }, { id: 'b', values: { name: 'B', stage: 'Lead' } }] });
  await ask('/lists/deals/rows', { rows: [{ id: 'a', values: { stage: 'Negotiation' } }] });
  const view = (await ask('/lists/deals/views/came-back')).body;
  assert.deepEqual(view.rows.map(row => row.id), ['a']);
});

test('every change says who made it and by which road, in plain words', async t => {
  const { ask } = fresh(t);
  await ask('/lists', deals);
  await ask('/lists/deals/rows', { rows: [{ id: 'acme', values: { name: 'Acme', stage: 'Lead' } }] }, 'Claude Code');
  await ask('/lists/deals/rows', { rows: [{ id: 'acme', values: { stage: 'Won' } }] }, 'Cursor');
  const history = (await ask('/lists/deals/field-history?row_id=acme&field_id=stage')).body;
  assert.equal(history.complete, true);
  assert.deepEqual(history.steps.map(step => [step.value, step.said]), [['Lead', 'You via Claude Code (as the app says)'], ['Won', 'You via Cursor (as the app says)']]);
  assert.equal(history.steps[0].until, history.steps[1].from);
  await ask('/lists/deals/rows', { remove: ['acme'] }, 'Claude Code');
  const removed = (await ask('/lists/deals/removed')).body.rows[0];
  assert.equal(removed.said, 'You via Claude Code (as the app says)');
  // The road of an admitted command comes from its sign-in, never from what the request says about itself.
  const overMcp = viaOf({ claims: { sign_in: 'key:abc123' }, recorder: { reader: 'key:abc123', app: 'Claude Code', app_basis: 'authenticated' } });
  assert.deepEqual(overMcp, { app: 'Claude Code', road: 'key', basis: 'authenticated' });
  assert.equal(viaWords({ by: 'key:abc123', via: overMcp }), 'You via Claude Code over MCP');
  assert.equal(viaWords({ by: 'app:Trillion', via: viaOf({ claims: { sign_in: 'session:s1' }, recorder: { app_basis: 'authenticated' } }) }), 'You on the Trillion page');
  assert.equal(viaOf({}), null);
});
