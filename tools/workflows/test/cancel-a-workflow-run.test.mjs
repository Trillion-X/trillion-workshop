// tools/workflows/test/cancel-a-workflow-run.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelWorkflowRun } from '../do-work/cancel-a-workflow-run.mjs';
import { holderCheck, UNNAMED } from '../read-data/workflow-run-holder.mjs';
import { fakeDoor } from './door-fake.mjs';

const RUN = 'a'.repeat(64);
const DATABASE = 'person_for_test';
// The run envelope a waiting task carries: run.started_by is the starter the engine copies from the start fact.
const envelope = startedBy => [{ run: { run: RUN, actor: 'acct', started_by: startedBy } }];
const cancel = (fake, input) => cancelWorkflowRun({ run_key: RUN, caller: 'me', database: DATABASE, ...input }, { door: fake.door, fetchImpl: fake.fetchImpl });

test('holder check refuses when the run does not record its starter, and says why', () => {
  assert.equal(holderCheck({ started_by: null }, 'me').why, UNNAMED);
  assert.equal(holderCheck({ started_by: 'other' }, 'me').ok, false);
  assert.deepEqual(holderCheck({ started_by: 'me' }, 'me'), { ok: true });
  assert.equal(holderCheck({ started_by: 'me' }, '').ok, false);
});

test('cancel refuses before any change while the starter is not recorded', async () => {
  const fake = fakeDoor({ rows: envelope(null) });
  await assert.rejects(cancel(fake), /does not record/);
  assert.equal(fake.calls.filter(call => call.method === 'tools:cancel').length, 0);
  assert.equal(fake.calls.filter(call => call.input?.input?.sql?.includes("set status = 'Withdrawn'")).length, 0);
});

test('cancel withdraws only this run\'s waiting tasks when the starter matches, and asks the engine for no cancel', async () => {
  const fake = fakeDoor({ rows: envelope('me') });
  const done = await cancel(fake, { why: 'stop' });
  assert.deepEqual(done, { run_key: RUN, withdrawn: 0 });
  const update = fake.calls.find(call => call.input?.input?.sql?.includes("set status = 'Withdrawn'"));
  assert.match(update.input.input.sql, /payload'->'run'->>'run' = \$1/);
  assert.match(update.input.input.sql, /not in \('Done', 'Withdrawn', 'Not needed'\)/);
  assert.deepEqual(update.input.input.params, [RUN, 'me', 'stop']);
  assert.equal(fake.calls.some(call => call.method === 'tools:cancel'), false);
});

test('cancel refuses a run key that is not a 64-hex key, and a database name that is not plain', async () => {
  await assert.rejects(cancelWorkflowRun({ run_key: 'nope', caller: 'me', database: DATABASE }, { door: fakeDoor().door, fetchImpl: fakeDoor().fetchImpl }), /run key/);
  await assert.rejects(cancel(fakeDoor(), { database: 'x; drop' }), /give database/);
});
