// Files opened with the app on a Mac that are too big for the message box are kept under the folder the panel's DATA
// names, each by its own name; one the service refuses is reported and the rest are still sent.
import assert from 'node:assert/strict';
import test from 'node:test';
import { openedInput, sendOpenedFiles } from '../send-opened-files.mjs';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import path from 'node:path';

const runFile = promisify(execFile);

test('each opened file is sent under the folder by its own name, and a refusal leaves the others sent', async () => {
  const sent = [], closed = [];
  const answer = await sendOpenedFiles({
    client: {}, chunking: {}, folder: '/Opened on this Mac/', files: ['/work/sample/Movies/talk.mov', '/work/sample/big.zip', '/work/sample/plan.pdf'],
    mediaType: async () => null,
    open: async file => ({ file, close: async () => closed.push(file) }),
    send: async ({ name, mediaType }) => {
      if (name.endsWith('big.zip')) throw new Error('The storage will not keep this file.');
      sent.push({ name, mediaType });
      return { identity: `1f:${name.length}`, state: 'finished' };
    },
  });
  assert.deepEqual(sent.map(row => row.name), ['/Opened on this Mac/talk.mov', '/Opened on this Mac/plan.pdf']);
  assert.equal(sent[0].mediaType, 'video/quicktime');
  assert.deepEqual(answer.kept.map(row => row.state), ['finished', 'finished']);
  assert.deepEqual(answer.refused, [{ file: 'big.zip', why: 'The storage will not keep this file.' }]);
  assert.equal(closed.length, 3, 'every file opened is closed, sent or refused');
});

test('a file that disappears before opening is refused without stopping later files', async () => {
  const opened = [], sent = [];
  const answer = await sendOpenedFiles({
    client: {}, chunking: {}, folder: '/Opened',
    files: ['/work/vanished.mov', '/work/available.pdf'],
    open: async file => {
      opened.push(file);
      if (file === '/work/vanished.mov') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { file, close() {} };
    },
    mediaType: async () => 'application/octet-stream',
    send: async ({ source, name }) => { sent.push([source.file, name]); return { state: 'finished' }; },
  });
  assert.deepEqual(opened, ['/work/vanished.mov', '/work/available.pdf']);
  assert.deepEqual(sent, [['/work/available.pdf', '/Opened/available.pdf']]);
  assert.deepEqual(answer.kept.map(row => row.name), ['/Opened/available.pdf']);
  assert.deepEqual(answer.refused.map(row => row.file), ['vanished.mov']);
});

test('a source close failure cannot mask a completed send or stop later files', async () => {
  const sent = [];
  const answer = await sendOpenedFiles({ client: {}, chunking: {}, folder: '/Opened',
    files: ['/work/first.pdf', '/work/second.pdf'],
    open: async file => ({ file, close: async () => { if (file.endsWith('first.pdf')) throw new Error('close failed'); } }),
    mediaType: async () => 'application/pdf',
    send: async ({ source, name }) => { sent.push([source.file, name]); return { state: 'finished' }; },
  });
  assert.deepEqual(sent, [['/work/first.pdf', '/Opened/first.pdf'], ['/work/second.pdf', '/Opened/second.pdf']]);
  assert.deepEqual(answer.kept.map(row => row.name), ['/Opened/first.pdf', '/Opened/second.pdf']);
  assert.deepEqual(answer.refused, []);
});

test('duplicate basenames within one opening receive numbered names', async () => {
  const sent = [];
  const answer = await sendOpenedFiles({ client: {}, chunking: {}, folder: '/Opened',
    files: ['/work/a/clip.mp4', '/work/b/clip.mp4', { file: '/work/c/clip.mp4' }],
    open: async file => ({ file, close() {} }),
    mediaType: async () => 'video/mp4',
    send: async ({ name }) => { sent.push(name); return { state: 'finished' }; },
  });
  assert.deepEqual(sent, ['/Opened/clip.mp4', '/Opened/clip (2).mp4', '/Opened/clip (3).mp4']);
  assert.deepEqual(answer.refused, []);
});

test('stdin file rows retain exact path order and never become arguments or a key', () => {
  const files = [{ file: '/work/clip.mp4' }, { file: '/ordinary/notes.txt' }], paths = files.map(row => row.file);
  assert.deepEqual(openedInput(`account-key\n${JSON.stringify({ files })}\n`, paths), { key: 'account-key', files });
  assert.deepEqual(openedInput('account-key\n', paths), { key: 'account-key', files: paths });
  assert.throws(() => openedInput(`account-key\n${JSON.stringify({ files: [...files].reverse() })}`, paths), /could not be checked/);
  assert.throws(() => openedInput('\n{}', paths), /Sign in/);
});

test('explicit stdin mode preserves the rows and rejects missing or malformed paths', () => {
  const files = [{ file: '/work/clip.mp4' }, { file: '/ordinary/note.md' }];
  assert.deepEqual(openedInput(`account-key\n${JSON.stringify({ files })}`, null), { key: 'account-key', files });
  for (const value of [null, [], [{}], [{ file: 'relative' }], [{ file: '/bad\0path' }], [{ file: 4 }], ['/ordinary/note.md']]) {
    assert.throws(() => openedInput(`account-key\n${JSON.stringify({ files: value })}`, null), /could not be checked/);
  }
  assert.throws(() => openedInput('account-key\n', null), /could not be checked/);
});

test('actual helper accepts an ordered stdin packet larger than macOS ARG_MAX and refuses files it cannot open without a request',
  { skip: process.platform !== 'darwin', timeout: 15000 }, async () => {
    const count = 5001;
    const files = Array.from({ length: count }, (_, index) => ({
      file: `/synthetic/${'a'.repeat(220)}/${'b'.repeat(220)}/asset-${index}.mp4`,
    }));
    const packet = `synthetic-test-key\n${JSON.stringify({ files })}\n`;
    const { stdout: maximum } = await runFile('getconf', ['ARG_MAX']);
    assert.ok(Buffer.byteLength(packet) > Number(maximum.trim()), 'exercise the real process argument ceiling');
    let requests = 0;
    const server = createServer((request, response) => { requests += 1; response.writeHead(503); response.end(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let child, deadline;
    try {
      const result = await new Promise((resolve, reject) => {
        let stdout = '', stderr = '';
        child = spawn(process.execPath, [new URL(import.meta.resolve('../send-opened-files.mjs')).pathname,
          '--folder', '/Opened', '--files-from-stdin'], {
          env: { ...process.env, TRILLION_ORIGIN: `http://127.0.0.1:${server.address().port}` },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        deadline = setTimeout(() => reject(new Error('The stdin helper did not finish.')), 10000);
        child.once('error', reject);
        child.stdin.on('error', reject);
        child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 8 * 1024 * 1024) reject(new Error('Unexpected helper output.')); });
        child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 16384) reject(new Error('Unexpected helper error.')); });
        child.once('close', code => resolve({ code, stdout, stderr }));
        child.stdin.end(packet);
      });
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.stderr, '');
      const answer = JSON.parse(result.stdout);
      assert.deepEqual(answer.kept, []);
      assert.deepEqual(answer.refused.map(row => row.file), files.map(row => path.basename(row.file)));
      assert.equal(requests, 0, 'a file that cannot be opened never reaches the service');
    } finally {
      clearTimeout(deadline);
      if (child && child.exitCode === null) child.kill();
      await new Promise(resolve => server.close(resolve));
    }
  });
