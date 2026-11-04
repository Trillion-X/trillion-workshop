// tools/media-composition/test/session-pairing.test.mjs
//
// One-primary multi-device sessions (read-data/session-pairing.mjs, moved from Trillion-X/trillion src/session-pairing.mjs). The
// first test is Trillion's test/local-document-and-catalogue.test.mjs session test (F-0570) with its assertions unchanged; the
// rest run tool:apply-a-pair-state-message the way the container runner runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, newSession } from '../read-data/session-pairing.mjs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

test('devices share one session id and one primary; wrong-session, unknown-device and rule-breaking messages are ignored with a reason', () => {
  let s = newSession('S1', ['idle', 'recording']);
  const send = message => { const r = apply(s, message); s = r.session; return r.ignored?.reason; };
  assert.equal(send({ session: 'S1', type: 'join', device: 'cam1', role: 'primary' }), undefined);
  assert.equal(send({ session: 'S1', type: 'join', device: 'cam2' }), undefined);
  assert.equal(send({ session: 'S1', type: 'join', device: 'cam3', role: 'primary' }), 'primary_taken');
  assert.equal(send({ session: 'OTHER', type: 'state', device: 'cam1', state: 'recording' }), 'other_session');
  assert.equal(send({ session: 'S1', type: 'state', device: 'ghost', state: 'recording' }), 'unknown_device');
  assert.equal(send({ session: 'S1', type: 'state', device: 'cam2', state: 'flying' }), 'unknown_state');
  assert.equal(send({ session: 'S1', type: 'state', device: 'cam2', state: 'recording' }), undefined);
  assert.equal(s.devices.cam2.state, 'recording');
  assert.equal(send({ session: 'S1', type: 'handover', device: 'cam2', from: 'cam2' }), 'not_primary');
  assert.equal(send({ session: 'S1', type: 'handover', device: 'cam2', from: 'cam1' }), undefined);
  assert.equal(s.primary, 'cam2');
  assert.equal(send({ session: 'S1', type: 'leave', device: 'cam2' }), undefined);
  assert.equal(s.primary, null);
  assert.equal(send({ session: 'S1', type: 'dance', device: 'cam1' }), 'unknown_type');
});

const row = rowOf(rows, 'tool:apply-a-pair-state-message');

test('the row starts a session from its id and states, applies one message, and hands the session back for the next', async () => {
  const joined = await answerOf(row, { session: { id: 'S1', states: ['idle', 'recording'] }, message: { session: 'S1', type: 'join', device: 'cam1', role: 'primary' } });
  assert.equal(joined.status, 0);
  assert.equal(joined.result.ignored, undefined);
  assert.deepEqual(joined.result.session, { id: 'S1', states: ['idle', 'recording'], primary: 'cam1', devices: { cam1: { state: 'idle', role: 'primary' } } });
  const second = await answerOf(row, { session: joined.result.session, message: { session: 'S1', type: 'join', device: 'cam2', role: 'primary' } });
  assert.equal(second.result.ignored.reason, 'primary_taken');
  assert.deepEqual(second.result.session, joined.result.session, 'an ignored message changes nothing');
  const recording = await answerOf(row, { session: joined.result.session, message: { session: 'S1', type: 'state', device: 'cam1', state: 'recording' } });
  assert.equal(recording.result.session.devices.cam1.state, 'recording');
});

test('the row refuses a session with no id or no states in words', async () => {
  const noStates = await answerOf(row, { session: { id: 'S1' }, message: { session: 'S1', type: 'join', device: 'cam1' } });
  assert.match(noStates.error, /session\.states/);
  const noId = await answerOf(row, { session: { states: ['idle'] }, message: { session: 'S1', type: 'join', device: 'cam1' } });
  assert.match(noId.error, /its id/);
});
