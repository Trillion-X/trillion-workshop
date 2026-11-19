import test from 'node:test';
import assert from 'node:assert/strict';
import { openRecordsDoor } from '../tools/records-door/read-data/records-door.mjs';
import { startFakeDoor } from '../tools/records-door/test/fake-door.mjs';
// The real produced-task owner (tools/plan-tasks-and-todo-lists task-moves.mjs prepareProducedTask) is a required host dependency, currently not published on Workshop main.
// This synthetic binding lets these tests check the port's atomic door boundary without claiming host adoption.
const prepareProducedTask = (input, now) => ({
  id: `record:calendar-task:${input.key}`, type: 'calendar-task', expected: null,
  value: { title: input.title, description: input.description, status: 'To do', assignees: [], sent_by: null, producer: input.source, sent_at: now.toISOString() },
});
import { clientHealthWork, clientHealthBookName, reportClientHealthIssue, makeClientHealthIssue } from '../tools/keep-record-books-by-kind/read-data/client-health.mjs';

// Deliberately synthetic row data. Production configuration is read from the operator's lists.
const settings = {
  surfaces: [{ id: 'app' }],
  kinds: [{ id: 'client_load', label: 'Slow client load', fix_work: { group_by: ['shell', 'category'] },
    allowed_values: { shell: ['browser'], category: ['request'] } }],
  client_health: { fix_work_row: { id_prefix: 'client-health-', priority: 'high',
    said: '{said} on {shell} · {path}', job: '{said} on {shell} · {path} ({category}).', outcome: '{said} no longer happens.' } },
};
const issue = { key: 'client_load|browser|/lists|request', kind: 'client_load',
  facts: { surface: 'app', path: '/lists', shell: 'browser', category: 'request' } };
const rights = ['client-health', 'calendar-task'].map(kind => ({ kind, operations: ['records:read', 'records:write'] }));

test('the original issue key and allowlists preserve stable, private work', () => {
  const first = clientHealthWork({ ...issue, count: 1 }, settings);
  assert.deepEqual(clientHealthWork({ ...issue, count: 9 }, settings), first);
  assert.match(first.id, /^client-health-[a-f0-9]{32}$/);
  assert.throws(() => clientHealthWork({ ...issue, facts: { ...issue.facts, path: '/lists?secret=1' } }, settings), /Invalid client health issue/);
  assert.throws(() => clientHealthWork({ ...issue, facts: { ...issue.facts, shell: 'private-computer' } }, settings), /Invalid client health issue/);
  assert.throws(() => clientHealthWork({ ...issue, kind: 'undeclared' }, settings), /Invalid client health issue/);
});

test('concurrent reports keep one produced task and one issue in an atomic door write', async () => {
  const fake = await startFakeDoor({ rights });
  try {
    const door = openRecordsDoor({ descriptor: fake.descriptor });
    const context = { door, settings, prepareProducedTask };
    const reports = await Promise.all(Array.from({ length: 8 }, (_, count) => reportClientHealthIssue(
      { ...context, requestKey: `independent-report-${count}` }, { ...issue, count })));
    assert.equal(new Set(reports.map(result => result.handoff_id)).size, 1);
    assert.equal(fake.kept.size, 2);
    const work = clientHealthWork(issue, settings);
    const kept = fake.kept.get(clientHealthBookName(work)).value;
    assert.equal(kept.handoff_id, reports[0].handoff_id);
    const job = fake.kept.get(kept.handoff_id).value;
    assert.equal(job.title, work.said);
    assert.equal(job.description, work.job);
    assert.equal(job.sent_by, null);
    assert.deepEqual(job.producer, { kind: 'client-health', ref: clientHealthBookName(work) });
  } finally { await fake.close(); }
});

test('refused work does not mark an issue as handed; retry completes both records', async () => {
  const fake = await startFakeDoor({ rights: rights.slice(0, 1) });
  try {
    const door = openRecordsDoor({ descriptor: fake.descriptor });
    await assert.rejects(reportClientHealthIssue({ door, settings, prepareProducedTask }, issue), { code: 'current_workspace_rights_refused' });
    assert.equal(fake.kept.size, 0);
  } finally { await fake.close(); }
  const kept = new Map();
  let busy = true, hands = 0;
  const owner = makeClientHealthIssue({ settings, list: () => [...kept.values()], put: (key, value) => kept.set(key, value),
    hand: async () => { if (busy) throw new Error('busy'); hands += 1; return { handoff_id: 'fixture-handoff' }; } });
  await assert.rejects(owner.run('report', issue), /busy/);
  assert.equal(kept.size, 0);
  busy = false;
  assert.deepEqual(await owner.run('report', issue), { handoff_id: 'fixture-handoff' });
  await owner.run('report', issue);
  assert.equal(hands, 1);
  await assert.rejects(owner.run('report', { ...issue, key: 'another' }), /keeps another client health issue/);
});
