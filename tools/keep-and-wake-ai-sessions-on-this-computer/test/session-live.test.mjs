// harness/session-live.mjs: a session-listing check that could not be read is "not known", never "not running", and the
// work consumer does not start a session a second time on it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { sessionLive } from '../harness/session-live.mjs';

const host = { live_check: ['list-sessions', '--json'], live_path: 'id' };
const ran = answer => () => answer;

test('a listing that names the session is live, one that does not is not', () => {
  assert.deepEqual(sessionLive(host, 's1', ran({ status: 0, stdout: '[{"id":"s1"}]' })), { live: true });
  assert.deepEqual(sessionLive(host, 's1', ran({ status: 0, stdout: '[{"id":"s2"}]' })), { live: false });
});

test('a listing that failed, exited non-zero or printed no list is not known, never not running', () => {
  for (const answer of [{ error: new Error('spawn list-sessions ENOENT') }, { status: 1, stderr: 'not signed in' }, { status: null, error: new Error('ETIMEDOUT') }, { status: 0, stdout: 'Error: busy' }, { status: 0, stdout: '{"id":"s1"}' }]) {
    const said = sessionLive(host, 's1', ran(answer));
    assert.equal(said.live, null, JSON.stringify(answer));
    assert.ok(said.why);
  }
});

test('a host without a listing command has nothing running elsewhere', () => {
  assert.deepEqual(sessionLive({}, 's1', () => { throw new Error('not run'); }), { live: false });
});

test('the work consumer starts a session only when the check said it is not running', () => {
  const source = readFileSync(new URL('../harness/work-consumer.mjs', import.meta.url), 'utf8');
  assert.match(source, /sessionLive\(host, args\.session\)/);
  assert.match(source, /elsewhere\.live !== false && host\.when_live === 'skip'/);
  assert.doesNotMatch(source, /catch \{ return false; \}/, 'a failed check is not read as not running');
});
