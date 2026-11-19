import assert from 'node:assert/strict';
import test from 'node:test';
import { clientHealthBookName, clientHealthWork, makeClientHealthIssue, reportClientHealthIssue } from '../read-data/client-health.mjs';

// Synthetic configuration; production settings come from the operator's records.
const settings = {
  surfaces: [{ id: 'app' }],
  kinds: [{ id: 'client_load', label: 'Slow load', fix_work: { group_by: ['shell', 'category'] },
    allowed_values: { shell: ['browser'], category: ['request'] } }],
  client_health: { fix_work_row: { id_prefix: 'client-health-', priority: 'high',
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

test('an issue is answered with its task and its record to keep, once; a kept handoff answers nothing new; a missing record list is refused', async () => {
  const prepareProducedTask = () => ({ id: 'synthetic-task', type: 'calendar-task', value: {} });
  const at = new Date('2026-01-10T12:00:00.000Z');
  const fresh = await reportClientHealthIssue({ stored: { records: [] }, settings, prepareProducedTask, now: () => at }, issue);
  assert.equal(fresh.handoff_id, 'synthetic-task');
  assert.equal(fresh.keep.length, 2);
  assert.equal(fresh.keep[0].id, 'synthetic-task');
  assert.equal(fresh.keep[1].expected, null);
  assert.deepEqual(fresh.keep[1].value, { id: clientHealthWork(issue, settings).id, handoff_id: 'synthetic-task', handed_at: at.toISOString() });
  const book = clientHealthBookName(clientHealthWork(issue, settings));
  const held = { id: book, type: 'client-health', value: { id: clientHealthWork(issue, settings).id, handoff_id: 'earlier-task' } };
  assert.deepEqual(await reportClientHealthIssue({ stored: { records: [held] }, settings, prepareProducedTask, now: () => at }, issue), { handoff_id: 'earlier-task', key: null, keep: [] });
  const unkept = { id: book, type: 'client-health', value: { id: clientHealthWork(issue, settings).id } };
  const again = await reportClientHealthIssue({ stored: { records: [unkept] }, settings, prepareProducedTask, now: () => at }, issue);
  assert.deepEqual(again.keep[1].expected, { type: 'client-health', value: unkept.value });
  for (const context of [{}, { stored: {} }, { stored: { records: [] }, settings }])
    await assert.rejects(reportClientHealthIssue(context, issue), /records handed in/);
});
