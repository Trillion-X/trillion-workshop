// The Get started screen's own actions (do-work/setup-actions.mjs). Assertions ported from the retired repository test/setup-recovery.test.mjs
// (b6ae0ebf81): 'setup/complete saves the name and a pursuit ... and refuses a missing field' (341), 'setup/complete writes each step
// from its DATA' (358), 'setup stop validates id ...' (585), 'retry refreshes without a call and restart asks the account's own
// setup owner' (642), and the stop and restart answer checks of src/account-routes.mjs 511-531. What those tests drove through
// handleAccountApi and the old Origin guard, the screen host's route owns now; here only the decisions are asserted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { completeSetupStep, restartSetupAnswer, retrySetup, stopSetupAnswer, stopSetupRequest } from '../do-work/setup-actions.mjs';
import policy from '../read-data/setup-policy.json' with { type: 'json' };

test('a finished step names the write its DATA says, trimmed, and a missing required field writes nothing', () => {
  const refused = completeSetupStep({ body: { step: 'identity', values: { given_name: 'Sam', family_name: ' ' } } });
  assert.deepEqual([refused.error, refused.status, refused.write], ['Enter your first name and last name.', 400, undefined]);
  const name = completeSetupStep({ body: { step: 'identity', values: { given_name: ' Sam ', family_name: 'Rivera' } } });
  assert.deepEqual(name, { write: { method: 'PUT', path: '/network/profile', body: { name: 'Sam Rivera', given_name: 'Sam', family_name: 'Rivera' } }, said: 'Your name is saved.', refresh: true });
  const pursuit = completeSetupStep({ body: { step: 'pursuits', values: { title: 'Ship setup', now: 'a draft', after: 'shipped' } } });
  assert.deepEqual(pursuit, { write: { method: 'PUT', path: '/pursuits', body: { pursuits: [{ title: 'Ship setup', now: 'a draft', after: 'shipped' }] } }, said: 'Your pursuit is saved.', refresh: true });
  assert.equal(completeSetupStep({ body: { step: 'pursuits', values: { title: 'Ship setup' } } }).status, 400);
  assert.deepEqual(completeSetupStep({ body: { step: 'connections', values: {} } }), { error: policy.words.finished_elsewhere, status: 400 });
});

test('every step finished on the screen says what it writes, and what the person offers and who they want to meet are written only when given', () => {
  for (const row of policy.requirements.filter(item => item.complete_here)) assert.ok(row.complete_here.writes?.path && row.complete_here.missing && row.complete_here.said, `${row.id} says what it writes`);
  const given = completeSetupStep({ body: { step: 'identity', values: { given_name: 'Sam', family_name: 'Rivera', offering: ' I hire engineers ', seeking: 'investors for a seed round' } } });
  assert.deepEqual(given.write, { method: 'PUT', path: '/network/profile', body: { name: 'Sam Rivera', given_name: 'Sam', family_name: 'Rivera', offering: 'I hire engineers', seeking: 'investors for a seed round' } });
  const identity = policy.requirements.find(item => item.id === 'identity').complete_here;
  assert.deepEqual(identity.fields.filter(field => !field.required).map(field => field.name), ['offering', 'seeking']);
});

test('a stop needs a run id and a look or a viewer never stops setup', () => {
  for (const run_id of [undefined, null, 0, '', '   ', []]) assert.deepEqual(stopSetupRequest({ body: { run_id } }), { error: 'Choose the setup run to stop.', status: 400 });
  assert.deepEqual(stopSetupRequest({ session: { look_only: true }, body: { run_id: 'run:mine' }, refusedLook: 'Read only.' }), { error: 'Read only.', code: 'look_read_only', status: 403 });
  assert.equal(stopSetupRequest({ session: { viewer: true }, body: { run_id: 'run:mine' } }).status, 403);
  assert.deepEqual(stopSetupRequest({ body: { run_id: 'run:mine' } }), { request: { run_id: 'run:mine', reason: 'Stopped by the person from the setup screen.' } });
});

test('a stop or a restart is said only when the owner\'s answer shows it', () => {
  const run = { run_id: 'run:mine', withdrawal: { at: '2026-10-08T12:00:00Z' } };
  assert.equal(stopSetupAnswer({ stopped: true, run }).stopped, true);
  assert.equal(stopSetupAnswer({ stopped: true, run }).refresh, true);
  for (const answer of [{ stopped: false, run }, { stopped: true, run: { run_id: 'run:mine' } }, {}]) assert.equal(stopSetupAnswer(answer).status, 502);
  assert.deepEqual(stopSetupAnswer({ error: 'Not allowed.' }, 403), { error: 'Not allowed.', status: 403 });
  assert.deepEqual(restartSetupAnswer({ workflow: { exists: true, state: 'working', withdrawn: false } }), { said: 'Setup is ready to continue in your AI. Its earlier results are kept.', refresh: true });
  for (const answer of [{}, { workflow: { exists: false } }, { workflow: { exists: true, withdrawn: true } }, { workflow: { exists: true, state: 'failed' } },
    { workflow: { exists: true, state: 'working' }, provisioned: { workflow: { state: 'failed' } } }]) assert.equal(restartSetupAnswer(answer).status, 409);
  assert.deepEqual(retrySetup(), { refresh: true });
});
