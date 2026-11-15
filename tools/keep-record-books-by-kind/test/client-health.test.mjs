import assert from 'node:assert/strict';
import test from 'node:test';
import { clientHealthWork, makeClientHealthIssue, reportClientHealthIssue } from '../read-data/client-health.mjs';

// Synthetic configuration; production settings come from the operator's records.
const settings = {
  surfaces: [{ id: 'app' }],
  kinds: [{ id: 'client_load', label: 'Slow load', fix_work: { group_by: ['shell', 'category'] },
    allowed_values: { shell: ['browser'], category: ['request'] } }],
  client_health: { fix_work_row: { id_prefix: 'client-health-', priority: 6,
    said: '{said} on {shell}', job: '{said} on {path} ({category})', outcome: '{said} stops.' } },
};
const issue = { key: 'load|browser|/lists|request', kind: 'client_load',
  facts: { surface: 'app', path: '/lists', shell: 'browser', category: 'request' } };

test('work excludes arbitrary issue facts and refuses every undeclared grouping value', () => {
  const work = clientHealthWork(issue, settings);
  assert.deepEqual(clientHealthWork({ ...issue, count: 99, facts: {
    ...issue.facts, person_id: 'private-person', exception: 'private-exception', stack: 'private-stack',
  } }, settings), work);
  assert.doesNotMatch(JSON.stringify(work), /private-person|private-exception|private-stack/);
  for (const facts of [{ ...issue.facts, surface: 'unknown' }, { ...issue.facts, shell: 'unknown' },
    { ...issue.facts, category: 'unknown' }, { ...issue.facts, path: '/lists?private=1' }])
    assert.throws(() => clientHealthWork({ ...issue, facts }, settings), /Invalid client health issue/);
  for (const key of ['', 'x'.repeat(501), null])
    assert.throws(() => clientHealthWork({ ...issue, key }, settings), /Invalid client health issue/);
});

test('the book awaits its durable put and retries an unsuccessful save', async () => {
  let value = null, fail = true, calls = 0;
  const book = makeClientHealthIssue({ settings, list: async () => value ? [value] : [],
    hand: async () => { calls += 1; return { handoff_id: 'synthetic-handoff' }; },
    put: async (kind, next) => {
      assert.equal(kind, 'issue');
      await Promise.resolve();
      if (fail) throw new Error('durable put busy');
      value = next;
    } });
  await assert.rejects(book.run('report', issue), /durable put busy/);
  assert.equal(value, null);
  fail = false;
  assert.deepEqual(await book.run('report', issue), { handoff_id: 'synthetic-handoff' });
  assert.equal(calls, 2);
  assert.equal(value.handoff_id, 'synthetic-handoff');
  assert.deepEqual(await book.run('report', issue), { handoff_id: 'synthetic-handoff' });
  assert.equal(calls, 2);
  await assert.rejects(book.run('erase', issue), /only be reported/);
});

test('unavailable reads and unresolved atomic conflicts never report a successful handoff', async () => {
  const prepareProducedJob = () => ({ id: 'synthetic-job', type: 'ai-job', expected: null, value: {} });
  let wrote = false;
  const unavailable = { read: async () => { throw new Error('records unavailable'); },
    write: async () => { wrote = true; } };
  await assert.rejects(reportClientHealthIssue({ door: unavailable, settings, prepareProducedJob }, issue), /records unavailable/);
  assert.equal(wrote, false);
  const conflict = Object.assign(new Error('conflict'), { code: 'original_command_conflict' });
  const refused = { read: async () => null, write: async () => { throw conflict; } };
  await assert.rejects(reportClientHealthIssue({ door: refused, settings, prepareProducedJob }, issue), error => error === conflict);
  for (const context of [{}, { door: refused }, { door: refused, settings }])
    await assert.rejects(reportClientHealthIssue(context, issue), /operator records door/);
});
