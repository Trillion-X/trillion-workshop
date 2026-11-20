// tools/start-a-computer/test/files-in-one-go.test.mjs
//
// A folder a unit owns whole is read and written in one command each way: the archive unpacks with a real tar to exactly the
// files given (a long path, a binary file, a nested folder), each 0644, and the one read tells a file that matches, one that
// differs and one that is absent, through a real shell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAll, tarOf, writeAll } from '../do-work/files-in-one-go.mjs';

const tars = ['tar', 'gtar'].filter(name => spawnSync(name, ['--version']).status === 0);

test('the archive unpacks to exactly the files given, each 0644, with every tar on this computer', () => {
  const long = `pages/workspace/named/${'a'.repeat(60)}/${'b'.repeat(70)}/shared-de7c3cf8a319-0e15abad6be3eb78.js`;
  const files = [
    { path: '/pages/index.html', text: '<p>hello</p>\n' },
    { path: `/${long}`, text: 'export const x = 1;\n' },
    { path: '/pages/icon.png', text: Buffer.from([0, 1, 2, 255, 254]).toString('base64'), binary: true },
  ];
  assert.ok(tars.length, 'a tar to unpack with');
  for (const tar of tars) {
    const root = mkdtempSync(join(tmpdir(), `one-go-${tar}-`));
    execFileSync(tar, ['-x', '-f', '-', '-C', root], { input: tarOf(files) });
    assert.equal(readFileSync(join(root, 'pages/index.html'), 'utf8'), '<p>hello</p>\n', tar);
    assert.equal(readFileSync(join(root, long), 'utf8'), 'export const x = 1;\n', `${tar}: a path over 100 bytes`);
    assert.deepEqual([...readFileSync(join(root, 'pages/icon.png'))], [0, 1, 2, 255, 254], `${tar}: binary bytes`);
    assert.equal(statSync(join(root, 'pages/index.html')).mode & 0o777, 0o644, tar);
  }
  assert.throws(() => tarOf([{ path: `/${'x'.repeat(300)}`, text: '' }]), /too long a path/);
});

test('one read tells each file: the same bytes, other bytes, or absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'one-go-read-'));
  mkdirSync(join(root, 'p'));
  writeFileSync(join(root, 'p/same.html'), 'same\n');
  writeFileSync(join(root, 'p/changed.html'), 'old\n');
  writeFileSync(join(root, 'p/icon.png'), Buffer.from([9, 8, 7]));
  const files = [
    { path: join(root, 'p/same.html'), text: 'same\n' },
    { path: join(root, 'p/changed.html'), text: 'new\n' },
    { path: join(root, 'p/missing.html'), text: 'x\n' },
    { path: join(root, 'p/icon.png'), text: Buffer.from([9, 8, 7]).toString('base64'), binary: true },
  ];
  const commands = [];
  const run = async (_machine, command, input) => { commands.push(command); return execFileSync('sh', ['-c', command], { input, encoding: 'utf8' }); };
  const live = await readAll({}, run, files);
  assert.equal(commands.length, 1, 'one command for every file');
  assert.equal(live[files[0].path], 'same\n');
  assert.ok(live[files[1].path] !== undefined && live[files[1].path] !== 'new\n', 'a file with other bytes differs');
  assert.equal(live[files[2].path], undefined, 'an absent file is absent');
  assert.equal(live[files[3].path], files[3].text, 'a binary file matches by its bytes');
  assert.deepEqual(await readAll({}, run, []), {});
});

test('one write sends the whole archive in one command, and nothing when there is nothing to write', async () => {
  const sent = [];
  const run = async (_machine, command, input) => { sent.push({ command, input }); return ''; };
  await writeAll({}, run, []);
  assert.equal(sent.length, 0);
  await writeAll({}, run, [{ path: '/var/lib/x/a.html', text: 'a' }, { path: '/var/lib/x/b.html', text: 'b' }]);
  assert.equal(sent.length, 1);
  assert.match(sent[0].command, /tar -x -f - -C \/ --no-same-owner --no-same-permissions/);
  assert.ok(Buffer.isBuffer(sent[0].input) && sent[0].input.length % 512 === 0);
});
