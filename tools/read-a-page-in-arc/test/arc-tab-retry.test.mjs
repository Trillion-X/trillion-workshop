// Arc's answers to a call that did not reach it: -609 is retried once after a wait and the error names the code when the retry
// fails too; -1743, syntax failures and missing tabs are terminal, without guessing which permission needs changing.
// Nothing here talks to Arc: exec is a stand-in.
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

test('a -1743 is never retried and does not guess which app permission needs changing', async () => {
  let calls = 0;
  const tab = arcTab({ exec: async () => { calls += 1; throw failing('execution error: Not authorized to send Apple events to Arc. (-1743)'); }, timeout_ms: 1000, retry_wait_ms: 0 });
  await assert.rejects(tab.open('https://example.com/'), error => {
    assert.match(error.message, /Apple events from this tool run \(-1743\)/);
    assert.doesNotMatch(error.message, /allow automation|System Settings|ask again/);
    return true;
  });
  assert.equal(calls, 1);
});

test('a read that meets -1743 answers the sentence to the person, with no page read', async () => {
  const answer = await readPageInArc({ url: 'https://example.com/' }, { exec: async () => { throw failing('execution error: Not authorized to send Apple events to Arc. (-1743)'); } });
  assert.match(answer.error, /Apple events from this tool run \(-1743\)/);
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

test('framework connection noise does not retry a terminal osascript syntax error', async () => {
  let calls = 0;
  const tab = arcTab({ exec: async () => { calls += 1; throw failing(SANDBOXED_STDERR); }, timeout_ms: 1000, retry_wait_ms: 0 });
  await assert.rejects(tab.open('https://example.com/'));
  assert.equal(calls, 1, 'the final error is -2741, not the framework connection error');
});

for (const [kind, stderr, words] of [
  ['automation refusal', 'execution error: Not authorized to send Apple events to Arc. (-1743)', /-1743/],
  ['syntax failure', SANDBOXED_STDERR, /-2741/],
  ['missing tab', 'execution error: Can’t get tab id "closed-tab" of window id "owned-window". (-1728)', /no longer open/],
]) {
  test(`readiness stops at a terminal ${kind} and closes only its own tab`, async () => {
    const calls = [];
    let sleeps = 0;
    const exec = async (file, args) => {
      assert.equal(file, 'osascript');
      calls.push(args.slice(2));
      if (args[2] === 'open') return { stdout: 'owned-window|owned-tab\n' };
      if (args[2] === 'close') return { stdout: 'closed\n' };
      throw failing(stderr);
    };
    const answer = await pullAPageInArc({
      url: 'https://example.com/',
      computer: { 'automate-an-app': { app: 'company.thebrowser.Browser' } },
    }, {
      exec,
      sleep: async () => {
        sleeps += 1;
        if (sleeps > 1) throw new Error('The readiness check retried a terminal failure.');
      },
    });
    assert.match(answer.error, words);
    assert.equal(answer.text, undefined);
    assert.equal(sleeps, 1, 'no wait or script retry follows a terminal failure');
    assert.deepEqual(calls.map(([operation]) => operation), ['open', 'js', 'close']);
    assert.deepEqual(calls[1].slice(1, 3), ['owned-window', 'owned-tab']);
    assert.deepEqual(calls[2], ['close', 'owned-window', 'owned-tab']);
  });
}
