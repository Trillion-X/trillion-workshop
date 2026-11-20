// The rules of work sent to customers' AIs (do-work/work-for-ais-rules.mjs), ported from the old owner's
// test/work-for-ais.test.mjs.held cases: rows are checked in plain words, a kept row replaces or ends a shipped one, a
// window holds a row back, a trigger sets it off once per account, the highest priority comes first, and the two
// shipped rows hold for the accounts they were written for. The settings are read from their owner's data file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WorkForAisError, checkedRow, handoffFor, inWindow, rowsFor, rowsInForce, triggersFor } from '../do-work/work-for-ais-rules.mjs';

const rules = JSON.parse(readFileSync(fileURLToPath(new URL('../../decide-when-things-show/read-data/work-for-ais.json', import.meta.url)), 'utf8'));
const shipped = rules.rows;
// The one shipped row that sets off when setup is unfinished (its id is data, so the test finds it by its trigger).
const SETUP_ROW = shipped.find(row => row.trigger === 'setup-unfinished').id;
const HOUR = 3600000;
const now = Date.parse('2026-11-19T12:00:00Z');
const facts = { created_at: now - 2 * HOUR, setup_done: false, setup_included: true, plan: 'free', bucket: 42, cohorts: [], experiments: [] };
// The audience matcher is the formula engine's job; these tests pass a plain one that reads `field == value` groups.
const matches = (tree, _fields, account) => tree.rules.every(rule => account[rule.field] === rule.params.value);

test('a row is checked in plain words: it needs an id and a job, a known trigger, a priority 0 to 9 and a window that ends after it starts', () => {
  const good = checkedRow({ id: 'tour-one', job: '  Show the tour.  ', said: 'A tour.' }, rules);
  assert.deepEqual(good, { id: 'tour-one', said: 'A tour.', job: 'Show the tour.', trigger: 'connect', priority: 5 });
  assert.throws(() => checkedRow({ id: 'Bad Id', job: 'x' }, rules), err => err instanceof WorkForAisError && err.message === rules.words.bad_row);
  assert.throws(() => checkedRow({ id: 'a', job: '   ' }, rules), /plain words|needs an id/);
  assert.throws(() => checkedRow({ id: 'a', job: 'x', trigger: 'monthly' }, rules), /trigger is one of: connect, account-created, setup-unfinished/);
  assert.throws(() => checkedRow({ id: 'a', job: 'x', priority: 10 }, rules), err => err.message === rules.words.bad_priority);
  assert.throws(() => checkedRow({ id: 'a', job: 'x', window: { from: '2026-11-20T00:00:00Z', until: '2026-11-19T00:00:00Z' } }, rules), err => err.message === rules.words.bad_window);
  assert.throws(() => checkedRow({ id: 'a', job: 'x', audience: { kind: 'rule' } }, rules), err => err.message === rules.words.bad_audience);
  assert.throws(() => checkedRow({ id: 'a', job: 'x'.repeat(rules.limits.job_chars + 1) }, rules), /job is 4001 characters; the most is 4000/);
  assert.throws(() => checkedRow({ id: 'a'.repeat(rules.limits.id_chars + 1), job: 'x' }, rules), /id is 81 characters/);
});

test('a kept row replaces the shipped row with its id, and an ended row is no longer in force', () => {
  const replaced = rowsInForce(shipped, [{ id: SETUP_ROW, job: 'Replaced.', trigger: 'connect', priority: 1 }]);
  assert.equal(replaced.length, shipped.length);
  assert.equal(replaced.find(row => row.id === SETUP_ROW).job, 'Replaced.');
  const ended = rowsInForce(shipped, [{ id: 'first-matches', ...shipped.find(row => row.id === 'first-matches'), ended_at: '2026-11-19T00:00:00Z' }]);
  assert.deepEqual(ended.map(row => row.id), [SETUP_ROW]);
});

test('a window holds a row back before it opens, delivers inside it and withdraws it after', () => {
  const row = { id: 'w', window: { from: '2026-11-19T13:00:00Z', until: '2026-11-19T15:00:00Z' } };
  assert.equal(inWindow(row, now), false, 'before it opens');
  assert.equal(inWindow(row, Date.parse('2026-11-19T14:00:00Z')), true, 'inside it');
  assert.equal(inWindow(row, Date.parse('2026-11-19T15:00:00Z')), false, 'at its end, withdrawn');
  assert.equal(inWindow({ id: 'open' }, now), true, 'a missing window is open');
});

test('triggers: connect always, account-created while the account is new, setup-unfinished until setup is done', () => {
  assert.deepEqual(triggersFor(facts, now, rules), ['connect', 'account-created', 'setup-unfinished']);
  assert.deepEqual(triggersFor({ ...facts, created_at: now - 100 * HOUR, setup_done: true }, now, rules), ['connect']);
  assert.deepEqual(triggersFor({ ...facts, created_at: null }, now, rules), ['connect', 'setup-unfinished']);
});

test('the set-up row reaches an account whose setup is unfinished and not one whose setup is done', async () => {
  const row = shipped.find(item => item.id === SETUP_ROW);
  const setupRow = { ...row, audience: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'setup_included', operator: 'is_true', params: {} }] } };
  const held = async account => (await rowsFor({ rows: [setupRow], facts: { ...facts, ...account }, nowMs: now, matches: (tree, fields, f) => f.setup_included === true, rules })).map(item => item.id);
  assert.deepEqual(await held({}), [SETUP_ROW]);
  assert.deepEqual(await held({ setup_done: true }), [], 'a finished setup is not handed the row');
});

test('rowsFor: a row with no audience reaches everyone, an audience reaches only its members, the highest priority comes first', async () => {
  const everyone = { id: 'everyone', priority: 3 };
  const members = { id: 'members', priority: 9, audience: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'bucket', operator: 'equals', params: { value: 42 } }] } };
  const others = { id: 'others', priority: 9, audience: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'bucket', operator: 'equals', params: { value: 7 } }] } };
  const held = await rowsFor({ rows: [everyone, members, others], facts: { ...facts, bucket: 42 }, nowMs: now, matches, rules });
  assert.deepEqual(held.map(row => row.id), ['members', 'everyone']);
});

test('a handoff is one job for the row, once per row, with the trigger it came from', () => {
  const row = checkedRow({ id: 'tour-one', job: 'Show the tour.', trigger: 'account-created' }, rules);
  assert.deepEqual(handoffFor(row, rules), { job: 'Show the tour.', priority: 5, once_per: 'work-for-ais:tour-one', input: { work_for_ais: { row: 'tour-one', trigger: 'account-created' } } });
});

test('the two shipped rows are checked and hold for the triggers they were written for', () => {
  const byId = Object.fromEntries(shipped.map(row => [row.id, checkedRow(row, rules)]));
  assert.equal(byId[SETUP_ROW].trigger, 'setup-unfinished');
  assert.equal(byId[SETUP_ROW].priority, 9);
  assert.equal(byId['first-matches'].trigger, 'account-created');
  assert.equal(byId['first-matches'].priority, 8);
});
