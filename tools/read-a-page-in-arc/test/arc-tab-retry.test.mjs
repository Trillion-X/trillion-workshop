// Arc's answers to a call that did not reach it: -609 is retried once after a wait and the error names the code when the retry
// fails too; -1743 is never retried and says to allow automation for Arc. Nothing here talks to Arc: exec is a stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { arcTab } from '../arc-tab.mjs';
import { readPageInArc } from '../read-a-page-in-arc.mjs';

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
