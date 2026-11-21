// tools/workflows/test/start-a-workflow-run.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWorkflowRun } from '../do-work/start-a-workflow-run.mjs';
import { fakeDoor, DOOR } from './door-fake.mjs';

const WORKFLOW = 'workflow:do-a-job-no-workflow-fits-yet';
const CALLER = 'ai:claude-code-test';
const DATABASE = 'person_for_test';

const start = (fake, input = {}) => startWorkflowRun({ caller: CALLER, database: DATABASE, workflow: WORKFLOW, ...input }, { door: fake.door, fetchImpl: fake.fetchImpl });

test('a start with a live waiter sends one fact through the door: the recipe, the database, the input with its fact id, the starter', async () => {
  const fake = fakeDoor();
  const started = await start(fake, { input: { request: 'proof' } });
  const [send] = fake.sent();
  assert.equal(send.auth, `Bearer ${DOOR.capability}`);
  assert.equal(send.url, DOOR.url);
  assert.equal(send.input.kind, 'workflow-chosen-from-rows');
  assert.equal(send.input.event_id, started.event_id);
  assert.match(started.event_id, /^workflow-run-start:[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(send.input.payload).sort(), ['database', 'input', 'recipe', 'started_by']);
  assert.equal(send.input.payload.recipe, WORKFLOW);
  assert.equal(send.input.payload.database, DATABASE);
  assert.equal(send.input.payload.started_by, CALLER);
  assert.deepEqual(JSON.parse(send.input.payload.input), { request: 'proof', fact_id: started.event_id });
});

test('a start without a caller or a database is refused before any call', async () => {
  const fake = fakeDoor();
  await assert.rejects(start(fake, { caller: undefined }), /give caller/);
  await assert.rejects(start(fake, { caller: 'me' }), /give caller/);
  await assert.rejects(start(fake, { database: 'x; drop' }), /give database/);
  assert.equal(fake.calls.length, 0);
});

test('a workflow no recipe holds is refused before any send', async () => {
  const fake = fakeDoor({ recipe: false });
  await assert.rejects(start(fake), /no workflow/);
  assert.equal(fake.sent().length, 0);
});

test('a refused wake:list is said in plain words, and nothing is sent', async () => {
  const fake = fakeDoor({ wakeListRefusal: 'the wake book is too big' });
  await assert.rejects(start(fake), /would not list its wakes \(wake:list\).*not started.*the wake book is too big/s);
  assert.equal(fake.sent().length, 0);
});

test('no live waiter is refused before any send', async () => {
  const fake = fakeDoor({ waiterOn: false });
  await assert.rejects(start(fake), /no live waiter a-workflow-was-chosen/);
  assert.equal(fake.sent().length, 0);
});

test('an input too big for one 1024-byte field is refused before any send', async () => {
  const fake = fakeDoor();
  await assert.rejects(start(fake, { input: { request: 'x'.repeat(2000) } }), /input field is over 1024 bytes/);
  assert.equal(fake.sent().length, 0);
});

test('two starts make two different event ids', async () => {
  const a = await start(fakeDoor());
  const b = await start(fakeDoor());
  assert.notEqual(a.event_id, b.event_id);
});
