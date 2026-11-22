// Arc's answers to a call that did not reach it: -609 is retried once after a wait and the error names the code when the retry
// fails too; -1743 is never retried and says to allow automation for Arc. Nothing here talks to Arc: exec is a stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { arcSaid, arcTab } from '../arc-tab.mjs';
import { readPageInArc } from '../read-a-page-in-arc.mjs';
import { pullAPageInArc } from '../pull-a-page-in-arc.mjs';

const failing = stderr => Object.assign(new Error('Command failed: osascript'), { stderr });

test('a -609 is retried once and the second answer is used', async () => {
  const answers = [() => { throw failing('execution error: Connection is invalid. (-609)'); }, () => ({ stdout: '3|4\n' })];
  const calls = [];
  const tab = arcTab({ exec: async (file, args) => { calls.push(args[1]); return answers[calls.length - 1](); }, timeout_ms: 1000, retry_wait_ms: 0 });
  assert.deepEqual(await tab.open('https://example.com/'), { window: '3', tab: '4' });
  assert.equal(calls.length, 2);
});

test('a -609 that repeats fails once more and names the code', async () => {
  let calls = 0;
  const tab = arcTab({ exec: async () => { calls += 1; throw failing('execution error: Connection is invalid. (-609)'); }, timeout_ms: 1000, retry_wait_ms: 0 });
  await assert.rejects(tab.open('https://example.com/'), error => /-609/.test(error.stderr) && error.message === 'Command failed: osascript');
  assert.equal(calls, 2);
});

test('a -1743 is never retried and says to allow automation for Arc', async () => {
  let calls = 0;
  const tab = arcTab({ exec: async () => { calls += 1; throw failing('execution error: Not authorized to send Apple events to Arc. (-1743)'); }, timeout_ms: 1000, retry_wait_ms: 0 });
  await assert.rejects(tab.open('https://example.com/'), /allow automation for Arc/);
  assert.equal(calls, 1);
});

test('a read that meets -1743 answers the sentence to the person, with no page read', async () => {
  const answer = await readPageInArc({ url: 'https://example.com/' }, { exec: async () => { throw failing('execution error: Not authorized to send Apple events to Arc. (-1743)'); } });
  assert.match(answer.error, /allow automation for Arc/);
  assert.equal(answer.title, undefined);
});

// What osascript wrote under the engine's sandbox at 4:12:08 AM CST Nov 22 2026 (a read whose grant named Messages):
// eight framework lines, then osascript's own error line.
const SANDBOXED_STDERR = [
  '2026-11-22 04:12:08.717 osascript[9821:44455281] CFURLCopyResourcePropertyForKey failed because it was passed a URL which has no scheme',
  '2026-11-22 04:12:08.717 osascript[9821:44455096] CFURLCopyResourcePropertyForKey failed because it was passed a URL which has no scheme',
  '2026-11-22 04:12:08.738 osascript[9821:44455050] Error received in message reply handler: Connection invalid',
  '2026-11-22 04:12:08.738 osascript[9821:44455095] Connection Invalid error for service com.apple.hiservices-xpcservice.',
  '2026-11-22 04:12:08.739 osascript[9821:44455050] Error received in message reply handler: Connection invalid',
  '2026-11-22 04:12:08.740 osascript[9821:44455050] Error received in message reply handler: Connection invalid',
  '2026-11-22 04:12:08.740 osascript[9821:44455050] Error received in message reply handler: Connection invalid',
  '2026-11-22 04:12:08.740 osascript[9821:44455050] Error received in message reply handler: Connection invalid',
  '261:264: syntax error: Expected “,” but found property. (-2741)',
  '',
].join('\n');
const REAL_LINE = '261:264: syntax error: Expected “,” but found property. (-2741)';

test('a failure answers osascript\'s own last line with its code, not the framework lines before it', async () => {
  assert.equal(arcSaid(failing(SANDBOXED_STDERR)), REAL_LINE);
  const read = await readPageInArc({ url: 'https://example.com/' }, { exec: async () => { throw failing(SANDBOXED_STDERR); } });
  assert.equal(read.error, `Arc did not answer: ${REAL_LINE}`);
  assert.doesNotMatch(read.error, /hiservices|reply handler/);
  const pulled = await pullAPageInArc({ url: 'https://example.com/' }, { exec: async () => { throw failing(SANDBOXED_STDERR); }, sleep: async () => {} });
  assert.equal(pulled.error, `Arc did not answer: ${REAL_LINE}`);
});

test('a line without its own code carries the exit code, and an empty error still says something', () => {
  assert.equal(arcSaid(Object.assign(new Error('x'), { stderr: 'killed\n', code: 137 })), 'killed (exit 137)');
  assert.equal(arcSaid(Object.assign(new Error(''), { stderr: '\n \n' })), 'no words');
});
