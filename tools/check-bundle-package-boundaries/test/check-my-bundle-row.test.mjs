// tools/check-bundle-package-boundaries: the row is the shape the engine runs on the person's computer, and the command,
// run the way the engine runs it (the granted folder in argv, the input on standard input, the answer on the last line),
// judges a made-up bundle report and made-up packages inside a made-up folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const folder = resolve(import.meta.dirname, '..');
const row = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
const declaration = { file: 'public-files.json', entries_at: 'things', kind_at: 'payload.kind', kind: 'public-source', path_at: 'payload.source_path' };

function command(granted, input) {
  return new Promise(done => {
    const child = spawn(process.execPath, [resolve(folder, 'do-work', 'check-my-bundle.mjs'), granted]);
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('close', status => done({ status, answer: JSON.parse(out.trim().split('\n').at(-1)) }));
    child.stdin.end(JSON.stringify(input));
  });
}

function made(t, imports) {
  const root = mkdtempSync(join(tmpdir(), 'check-my-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages', 'ledger'), { recursive: true });
  writeFileSync(join(root, 'packages', 'ledger', declaration.file), JSON.stringify({ things: [{ payload: { kind: 'public-source', source_path: 'show' } }] }));
  writeFileSync(join(root, 'meta.json'), JSON.stringify({ inputs: { 'host/app.mjs': { imports } } }));
  return root;
}

test('the row runs on the person\'s computer with only the folder capability and reaches no internet', () => {
  assert.equal(row.invoke.kind, 'computer');
  assert.deepEqual(row.invoke.capabilities, ['read-a-folder']);
  assert.notEqual(row.invoke.internet, true);
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.equal(row.result_selector, '$.result');
  assert.deepEqual(row.invoke.argv.at(-1), { fill: { from: 'task', field: 'grants.read-a-folder.folder' } });
  assert.deepEqual(row.input_schema.required, ['metafile_file', 'packages_root', 'declaration']);
});

test('a bundle that only reaches declared files is ok; one that reaches a private file is named with a non-zero status', async t => {
  const clean = made(t, [{ path: 'packages/ledger/show/a.mjs' }]);
  const ok = await command(clean, { metafile_file: 'meta.json', packages_root: 'packages', declaration });
  assert.equal(ok.status, 0, JSON.stringify(ok.answer));
  assert.equal(ok.answer.result.ok, true);
  assert.equal(ok.answer.result.edges_checked, 1);
  const dirty = made(t, [{ path: 'packages/ledger/inner/b.mjs' }]);
  const bad = await command(dirty, { metafile_file: 'meta.json', packages_root: 'packages', declaration });
  assert.equal(bad.status, 1);
  assert.equal(bad.answer.result.ok, false);
  assert.match(bad.answer.result.findings[0].said, /host\/app\.mjs reaches ledger\/inner\/b\.mjs/);
});

test('it refuses, in words, a path outside the folder, a missing declaration and a folder that is not one', async t => {
  const root = made(t, []);
  assert.match((await command(root, { metafile_file: '../meta.json', packages_root: 'packages', declaration })).answer.error, /not a path inside the granted folder|does not exist/);
  assert.match((await command(root, { metafile_file: 'meta.json', packages_root: 'packages' })).answer.error, /declaration\.file is required/);
  assert.match((await command(root, { packages_root: 'packages', declaration })).answer.error, /give metafile_file/);
  assert.match((await command(join(root, 'absent'), { metafile_file: 'meta.json', packages_root: 'packages', declaration })).answer.error, /granted folder/);
});
