import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const library = new URL(import.meta.resolve('../do-work/derive-tool-rows-from-sources.mjs'));
const cli = fileURLToPath(new URL(import.meta.resolve('../do-work/derive-tool-rows-from-sources-cli.mjs')));

test('the reusable catalog stays inert in another bundled Node entry with socket/path arguments', async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'catalog-import-boundary-')));
  try {
    const entry = join(folder, 'issuer.mjs');
    const output = join(folder, 'issuer-bundle.mjs');
    writeFileSync(entry, `import { toolRowsFromSources, payloadsIn } from ${JSON.stringify(fileURLToPath(library))};\nprocess.stdout.write(JSON.stringify({functions:[typeof toolRowsFromSources,typeof payloadsIn],arguments:process.argv.slice(2)})+'\\n');\n`);
    await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const args = ['--socket', join(folder, 'not-a-records-file.sock'), '--path', join(folder, 'not-a-records-folder')];
    const ran = spawnSync(process.execPath, [output, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(ran.error, undefined);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stderr, '');
    assert.deepEqual(JSON.parse(ran.stdout), { functions: ['function', 'function'], arguments: args });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the explicit catalog CLI still reports derived rows from a records file', () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'catalog-cli-')));
  try {
    const input = join(folder, 'records.json');
    const entries = [{ id: 'read-one', label: 'Read one', job: 'Read a synthetic value' }];
    const url = 'data:application/json,' + encodeURIComponent(JSON.stringify(entries));
    writeFileSync(input, JSON.stringify({ records: [{ payload: {
      kind: 'tool-row-source', id: 'synthetic-source', id_prefix: 'tool:synthetic-',
      list: { url }, entry: { id: 'id', label: 'label', job: 'job' }, row: { invoke: { kind: 'synthetic-read' } },
    } }] }));
    const ran = spawnSync(process.execPath, [cli, input], { encoding: 'utf8', timeout: 10000 });
    assert.equal(ran.error, undefined);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stderr, '');
    assert.deepEqual(JSON.parse(ran.stdout), { rows: 1, ids: ['tool:synthetic-read-one'], unread: [], refused: [] });
    const missing = spawnSync(process.execPath, [cli], { encoding: 'utf8', timeout: 10000 });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /usage: derive-tool-rows-from-sources-cli\.mjs/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
