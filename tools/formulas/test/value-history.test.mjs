// A field's values over time (read-data/list-value-history.mjs) and the road every write came by
// (read-data/write-via.mjs), both moved unchanged from old trillion src/. The interval-arithmetic test and the road
// assertions are moved from old trillion test/list-value-history.test.mjs with their assertions unchanged. The tests there
// that ran through the old lists engine's HTTP routes (src/lists.mjs over src/local-store.mjs: a write keeping steps, a
// saved view filtering on a history field, the removed-row line) stay with that engine; the steps a write keeps and the
// lines a person reads run here through the moved functions and the rows' requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { historyValues, keepValueHistory, fieldHistoryOf } from '../read-data/list-value-history.mjs';
import { viaOf, viaWords } from '../read-data/write-via.mjs';
import { fieldHistory, historyFieldValues } from '../do-work/requests.mjs';

const DAY = 86_400_000;
const iso = ms => new Date(ms).toISOString();

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

test('the road of an admitted command comes from its sign-in, never from what the request says about itself', () => {
  const overMcp = viaOf({ claims: { sign_in: 'key:abc123' }, recorder: { reader: 'key:abc123', app: 'Claude Code', app_basis: 'authenticated' } });
  assert.deepEqual(overMcp, { app: 'Claude Code', road: 'key', basis: 'authenticated' });
  assert.equal(viaWords({ by: 'key:abc123', via: overMcp }), 'You via Claude Code over MCP');
  assert.equal(viaWords({ by: 'app:Trillion', via: viaOf({ claims: { sign_in: 'session:s1' }, recorder: { app_basis: 'authenticated' } }) }), 'You on the Trillion page');
  assert.equal(viaOf({}), null);
});

test('a write keeps each value a history field held, a write that did not change it leaves it alone, and the lines say who and by which road', () => {
  const list = { id: 'deals', fields: [{ id: 'name' }, { id: 'stage', keeps_history: true }] };
  const t0 = Date.parse('2026-10-01T00:00:00Z');
  const via = { app: 'Claude Code', basis: 'client_declared' };
  let row = keepValueHistory(list, { name: 'Sample Co', stage: 'Lead' }, { before: null, at: iso(t0), actor: { by: 'app:x', via } });
  row = keepValueHistory(list, { ...row, stage: 'Negotiation' }, { before: row, at: iso(t0 + DAY), actor: { by: 'app:x', via } });
  row = keepValueHistory(list, { ...row, name: 'Sample Co Ltd' }, { before: row, at: iso(t0 + 2 * DAY), actor: { by: 'app:x', via } });
  assert.deepEqual(row._history.stage.steps.map(step => step.v), ['Lead', 'Negotiation'], 'a write that did not change the stage leaves its history alone');
  assert.equal(row._history.stage.cut, false);
  assert.deepEqual(row._history.stage.steps[1].via, { app: 'Claude Code', basis: 'client_declared' });
  const lines = fieldHistoryOf(list, 'deals', 'sample', row, 'stage');
  assert.equal(lines.complete, true);
  assert.deepEqual(lines.steps.map(step => [step.value, step.said]), [['Lead', 'You via Claude Code (as the app says)'], ['Negotiation', 'You via Claude Code (as the app says)']]);
  assert.equal(lines.steps[0].until, lines.steps[1].from);
  assert.deepEqual(fieldHistory({ list, row_id: 'sample', field_id: 'stage', kept: row }), lines);
});

test('the row answers history values as of now_ms and refuses a history field that is not finished', () => {
  const now = Date.parse('2026-10-19T00:00:00Z');
  const kept = { _history: { stage: { cut: false, steps: [{ v: 'Lead', at: iso(now - 10 * DAY) }, { v: 'Won', at: iso(now - 2 * DAY) }] } } };
  const answer = historyFieldValues({ now_ms: now, kept, fields: [{ id: 'was', history: { field: 'stage', op: 'previous_value' } }, { id: 'lead_days', history: { field: 'stage', op: 'time_spent_in', value: 'Lead' } }] });
  assert.deepEqual(answer, { values: { was: 'Lead', lead_days: 8 } });
  assert.throws(() => historyFieldValues({ now_ms: now, kept, fields: [{ id: 'x', history: { field: 'stage', op: 'time_spent_in' } }] }), /works its value out from a field's history/);
  assert.throws(() => historyFieldValues({ kept, fields: [] }), /now_ms/);
});
