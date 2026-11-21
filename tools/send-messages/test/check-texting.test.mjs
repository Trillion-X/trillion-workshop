// The read-only Messages check against a stand-in osascript (nothing here talks to Messages): the counts and service
// types come back with nothing personal, the script reads and never sends, and each refusal is said in words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPT, answerFrom, checkMessages, refusalFrom } from '../do-work/check-texting.mjs';

test('chats and the service types of the accounts come back, and nothing else', async () => {
  const calls = [];
  const answer = await checkMessages({ run: async (file, args) => { calls.push([file, ...args]); return '12\tiMessage,SMS,iMessage\n'; } });
  assert.deepEqual(answer, { chats: 12, accounts: 3, service_types: ['SMS', 'iMessage'], said: answer.said });
  assert.equal(calls[0][0], '/usr/bin/osascript');
  assert.deepEqual(answerFrom('0\t\n'), { chats: 0, accounts: 0, service_types: [], said: answer.said });
  assert.equal(answerFrom('a list of names').error, 'unexpected_answer');
});

test('the script only reads: no send, set of Messages data, make or delete', () => {
  assert.doesNotMatch(SCRIPT, /\b(send|make|delete|close|login|logout)\b/i);
  assert.doesNotMatch(SCRIPT.replace(/set (kinds|end of kinds|chatCount|AppleScript's text item delimiters) to/g, ''), /\bset\b/);
  assert.match(SCRIPT, /tell application "Messages"/);
});

test('Automation not allowed, terms that did not compile and other failures are each said in words', async () => {
  const refuse = stderr => checkMessages({ run: async () => { throw Object.assign(new Error('Command failed'), { stderr }); } });
  assert.equal((await refuse('execution error: Not authorized to send Apple events to Messages. (-1743)')).needs_access, 'automation');
  assert.equal((await refuse('133:140: syntax error: Expected class name but found identifier. (-2741)')).error, 'cannot_read_messages_terms');
  const other = await refuse('the program went away\nmore');
  assert.deepEqual(other, { error: 'osascript_failed', said: 'the program went away' });
  assert.equal(refusalFrom(undefined).error, 'osascript_failed');
});
