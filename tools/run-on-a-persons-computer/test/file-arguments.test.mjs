// test/file-arguments.test.mjs
//
// A tool call may name a file instead of carrying its bytes (computer/file-arguments.mjs, DATA in
// computer/file-arguments.json): the Mac reads it at the tool boundary, within the folders the data allows, never a
// protected file, never through a link out, and never past the byte cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandFileArguments, fileArgumentSettings } from '../file-arguments.mjs';
import { runHere, settingsOf } from '../mac-tools.mjs';

const settings = fileArgumentSettings();
function mac() {
  const home = mkdtempSync(join(tmpdir(), 'file-args-home-'));
  const outside = mkdtempSync(join(tmpdir(), 'file-args-outside-'));
  mkdirSync(join(home, 'Documents'));
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, 'Documents', 'notes.txt'), 'hello from the file');
  writeFileSync(join(home, 'Documents', 'pic.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  writeFileSync(join(home, '.ssh', 'config'), 'secret');
  writeFileSync(join(home, 'Documents', 'server.pem'), 'secret');
  writeFileSync(join(outside, 'private.txt'), 'outside');
  symlinkSync(join(outside, 'private.txt'), join(home, 'Documents', 'link.txt'));
  return { home, outside };
}
const refused = async (promise, status, words) => assert.rejects(promise, error => { assert.equal(error.status, status); assert.match(error.message, words); return true; });

test('a named file is read at the boundary and put in the name\'s place, anywhere in the input; nothing else changes', async () => {
  const { home } = mac();
  const input = { title: 'keep', count: 3, body: `$file:${home}/Documents/notes.txt`, nested: [{ again: `$file:~/Documents/notes.txt` }, 'plain'], raw: `$file-base64:~/Documents/pic.bin` };
  const answer = await expandFileArguments(input, settings, home);
  assert.deepEqual(answer.input, { title: 'keep', count: 3, body: 'hello from the file', nested: [{ again: 'hello from the file' }, 'plain'], raw: '//4AAQ==' });
  assert.equal(input.body.startsWith('$file:'), true, 'the input given is not modified');
  assert.equal(answer.files.length, 2);
  assert.equal(answer.bytes, 19 + 4, 'the same file named twice is read once');
  console.log('readback expanded:', JSON.stringify({ body: answer.input.body, raw: answer.input.raw, files: answer.files.length, bytes: answer.bytes }));
});

test('a path outside the roots, through a link out, to a protected name or extension, or past the cap is refused and reads nothing', async () => {
  const { home, outside } = mac();
  await refused(expandFileArguments({ a: `$file:${outside}/private.txt` }, settings, home), 403, /outside the folders/);
  await refused(expandFileArguments({ a: '$file:~/Documents/link.txt' }, settings, home), 403, /outside the folders/);
  await refused(expandFileArguments({ a: '$file:~/.ssh/config' }, settings, home), 403, /protected/);
  await refused(expandFileArguments({ a: '$file:~/Documents/server.pem' }, settings, home), 403, /protected/);
  await refused(expandFileArguments({ a: '$file:Documents/notes.txt' }, settings, home), 422, /full path/);
  await refused(expandFileArguments({ a: '$file:~/Documents/none.txt' }, settings, home), 404, /not a file/);
  await refused(expandFileArguments({ a: '$file:~/Documents/pic.bin' }, settings, home), 422, /not text/);
  await refused(expandFileArguments({ a: '$file:~/Documents/notes.txt', b: '$file-base64:~/Documents/pic.bin' }, { ...settings, max_bytes: 20 }, home), 413, /past 20 bytes/);
});

test('a row is the whole change: another prefix and another root', async () => {
  const { home, outside } = mac();
  const wider = { ...settings, prefixes: [{ prefix: '@read:', as: 'text' }], roots: ['~', outside] };
  assert.equal((await expandFileArguments({ a: `@read:${outside}/private.txt` }, wider, home)).input.a, 'outside');
});

test('the Mac host expands a named file before the tool runs and answers a refusal in words', async () => {
  const host = settingsOf();
  const answer = await runHere(host, { tool_id: 'tool:voices', input: { stray: '$file:/etc/passwd' } });
  assert.match(answer.error, /outside the folders|protected|not a file/);
  console.log('readback host refusal:', JSON.stringify(answer));
});
