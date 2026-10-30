// tool:my-notices run as the container runs it, against the fake records door with exactly the row's rights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const row = rowOf(rows, 'tool:my-notices');
const notice = (seq, kind, extra = {}) => ({ seq, kind, title: `Notice ${seq}`, at: `2026-01-01T00:0${seq}:00Z`, open: null, results: { page: { sent: true } }, ...extra });
const told = items => [
  { id: 'told-the-person', type: 'told-the-person', value: { seqs: items.map(item => item.seq) } },
  ...items.map(item => ({ id: `told-the-person:${item.seq}`, type: 'told-the-person', value: { item } })),
];

test('the newest notices come first, the kind is applied before the newest are taken, and seen ones are counted', async () => {
  const items = [
    notice(1, 'take-me-there', { read: true, read_on: { channel: 'page', at: '2026-01-01T00:05:00Z' } }),
    notice(2, 'report'), notice(3, 'report'),
    notice(4, 'report', { results: { page: { sent: true }, phone: { sent: false, stage: 'unavailable', said: 'No phone is connected.' } } }),
  ];
  const all = await runRow(row, { limit: 2 }, { records: told(items) });
  assert.equal(all.status, 0, all.error);
  assert.deepEqual(all.result.notices.map(item => item.id), ['told:4', 'told:3']);
  assert.deepEqual(all.result.notices[0].told, { page: 'sent', phone: 'unavailable' });
  assert.deepEqual(all.result.notices[0].why, { phone: 'No phone is connected.' });
  assert.equal(all.result.said, '2 notices, newest first; 0 seen.');
  const one = await runRow(row, { kind: 'take-me-there' }, { records: told(items) });
  assert.deepEqual(one.result.notices.map(item => [item.id, item.read, item.read_on?.channel]), [['told:1', true, 'page']]);
  assert.equal(one.result.said, '1 notice, newest first; 1 seen.');
});

test('a head kept whole by an earlier version is read as it is, and an empty account has no notices', async () => {
  const whole = [{ id: 'told-the-person', type: 'told-the-person', value: { items: [notice(1, 'report'), notice(2, 'report')] } }];
  assert.deepEqual((await runRow(row, {}, { records: whole })).result.notices.map(item => item.id), ['told:2', 'told:1']);
  assert.deepEqual((await runRow(row, {})).result, { notices: [], said: '0 notices, newest first; 0 seen.' });
});

test('the row only lists told-the-person records', () => {
  assert.deepEqual(row.invoke.records.rights, [{ kind: 'told-the-person', operations: ['records:list'] }]);
});
