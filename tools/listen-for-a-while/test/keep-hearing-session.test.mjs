// The session record of tool:hear-sources, named as a keep row for the export runner: the record unchanged, its id its own, and
// expected null (a new record only). A missing record is refused in words.
import assert from 'node:assert/strict';
import test from 'node:test';
import { keepHearingSession } from '../read-data/keep-hearing-session.mjs';

const session = { id: 'bd435513d5990856', program: 'whisper-cli', flags: {}, sources: ['system-audio', 'microphone'], at: 1795164697204 };

test('the session record becomes one keep row with its own id, unchanged, expected null', () => {
  const { keep } = keepHearingSession({ session });
  assert.deepEqual(keep, [{ id: 'bd435513d5990856', type: 'hearing-session', value: session, expected: null }]);
});

test('a missing session record is refused in words, and nothing is kept', () => {
  assert.throws(() => keepHearingSession({}), /Give `session`/);
  assert.throws(() => keepHearingSession({ session: { program: 'whisper-cli' } }), /Give `session`/);
});
