// tools/field-values: filling a made-up list's "website" column by asking made-up sources in order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import { planColumnFill, settleValues } from '../do-work/requests.mjs';

const records = [
  { id: 'p1', name: 'Rye Bakery', city: 'Eastham' },
  { id: 'p2', name: 'Loaf House', city: 'Westby', website: 'https://loaf.example' },
  { id: 'p3', name: 'Dough Corner' },
  { id: 'p4', name: 'Mill Street Ovens', city: 'Northon', country: 'elsewhere' },
];
const sources = [
  { id: 'guess', tool: 'tool:guess-a-website', input: { name: { from: ['name'] }, city: { from: ['city'] } }, answer_path: ['site'], cost: 0 },
  { id: 'directory', tool: 'tool:look-up-a-business', input: { name: { from: ['name'] }, city: { from: ['city'] }, plan: { value: 'basic' } }, answer_path: ['result', 'site'], cost: 2, kind: 'source' },
];
const accept = { kind: 'text', tree: { kind: 'rule', field: 'value', operator: 'starts_with', params: { text: 'https://' } } };
const fields = [{ id: 'country', kind: 'choice', path: ['country'] }];
const run_if = { kind: 'rule', field: 'country', operator: 'is_none_of', params: { values: ['elsewhere'] } };
const base = { records, id_path: ['id'], field: { id: 'website', path: ['website'] }, sources, accept, fields, run_if };

test('the first run asks the first source for every row that needs a value and skips the rest, saying why', () => {
  const plan = planColumnFill(base);
  assert.deepEqual(plan.calls.map(call => [call.row, call.source, call.tool]), [['p1', 'guess', 'tool:guess-a-website']]);
  assert.deepEqual(plan.calls[0].input, { name: 'Rye Bakery', city: 'Eastham' });
  assert.equal(plan.calls[0].request_key, makeHashCodeHexFromJson({ row: 'p1', source: 'guess', tool: 'tool:guess-a-website', input: { name: 'Rye Bakery', city: 'Eastham' } }));
  assert.deepEqual(plan.skipped, [{ row: 'p2', why: 'already has a value' }, { row: 'p4', why: 'run_if does not hold' }]);
  assert.deepEqual(plan.exhausted.map(row => [row.row, row.tried.map(tried => tried.outcome)]), [['p3', ['cannot ask: the row has no city', 'cannot ask: the row has no city']]]);
  assert.equal(plan.done, false);
});

test('an answer that fails the check moves the row to the next source; the first answer that passes fills it as an offer', () => {
  const second = planColumnFill({ ...base, attempts: [{ row: 'p1', source: 'guess', answer: { site: 'rye bakery eastham' }, cost: 0 }] });
  assert.deepEqual(second.calls.map(call => [call.row, call.source, call.input.plan]), [['p1', 'directory', 'basic']]);
  assert.deepEqual(second.cost, { spent: 0, next: 2 });
  const third = planColumnFill({ ...base, attempts: [
    { row: 'p1', source: 'guess', answer: { site: 'rye bakery eastham' } },
    { row: 'p1', source: 'directory', answer: { result: { site: 'https://rye.example' } }, cost: 2 },
  ] });
  assert.deepEqual(third.filled, [{ row: 'p1', field: 'website', value: 'https://rye.example', answered_by: 'directory', offer: { row: 'p1', field: 'website', value: 'https://rye.example', source: { kind: 'source', by: 'directory' } } }]);
  assert.deepEqual([third.calls.length, third.done, third.cost.spent], [0, true, 2]);
  const settled = settleValues({ offers: [...third.filled.map(item => item.offer), { row: 'p1', field: 'website', value: 'https://rye-bakery.example', source: { kind: 'person', by: 'owner' } }] });
  assert.equal(settled.cells[0].value, 'https://rye-bakery.example', 'a filled value is an offer, and a person\'s value still wins');
});

test('a source that failed or answered nothing is passed over; when every source is used up the row says what each did', () => {
  const plan = planColumnFill({ ...base, attempts: [
    { row: 'p1', source: 'guess', error: 'the service was busy' },
    { row: 'p1', source: 'directory', answer: { result: {} } },
  ] });
  assert.deepEqual(plan.exhausted.find(row => row.row === 'p1').tried.map(tried => tried.outcome), ['failed: the service was busy', 'no answer']);
  assert.equal(plan.done, true);
});

test('the same rejected answer coming back stops the row; keep_existing false asks again for rows that have a value; most_calls bounds a run', () => {
  const twice = planColumnFill({ ...base, stop_after_same_failure: 2,
    sources: [...sources, { id: 'third', tool: 'tool:another', input: { name: { from: ['name'] } } }],
    attempts: [{ row: 'p1', source: 'guess', answer: { site: 'unknown' } }, { row: 'p1', source: 'directory', answer: { result: { site: 'unknown' } } }] });
  assert.equal(twice.exhausted.find(row => row.row === 'p1').why, 'the same answer failed the check 2 times');
  assert.deepEqual(twice.calls.map(call => [call.row, call.source]), [['p3', 'third']], 'p1 stops; p3, which lacks a city, reaches the source that needs only a name');
  const refill = planColumnFill({ ...base, keep_existing: false, most_calls: 1 });
  assert.deepEqual([refill.calls.map(call => call.row), refill.waiting, refill.done], [['p1'], 1, false]);
});

test('requests that cannot be planned are refused with a sentence saying what to send', () => {
  assert.throws(() => planColumnFill({ ...base, id_path: undefined }), /id_path must be/);
  assert.throws(() => planColumnFill({ ...base, records: [{ id: 'x' }, { id: 'x' }] }), /its own id/);
  assert.throws(() => planColumnFill({ ...base, sources: [] }), /sources must be a list/);
  assert.throws(() => planColumnFill({ ...base, sources: [{ id: 'a', tool: 't', input: { n: { from: 'name' } } }] }), /input maps each input name/);
  assert.throws(() => planColumnFill({ ...base, accept: { kind: 'text', tree: { kind: 'rule', field: 'value', operator: 'greater_than', params: { value: 1 } } } }), /accept is not finished/);
  assert.throws(() => planColumnFill({ ...base, attempts: [{ row: 'p1', source: 'nobody' }] }), /attempts must be a list/);
});
