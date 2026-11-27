import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('the declared history rows refuse with one refusal class through their real consumer', async t => {
  const repository = fileURLToPath(new URL('../../..', import.meta.url));
  const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url))).records.map(record => record.payload);
  const row = rows.find(row => row.invoke.run.at(-1) === 'historyFieldValues');
  assert.ok(row, 'the history consumer retains its actual descriptor');
  const sandbox = tempFolder(join(tmpdir(), 'list-refusal-package-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const placed = path => path.startsWith('/opt/') ? join(sandbox, path.slice(1)) : path;
  for (const spec of [row.invoke.files.package_files].flat()) {
    for (const path of spec.paths) {
      const target = join(placed(spec.at), path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(repository, 'tools', spec.package, path), target, { recursive: true });
    }
  }
  const folder = placed(row.invoke.workdir);
  const api = await import(pathToFileURL(join(folder, 'read-data/value-history/list-refusals.mjs')));
  const consumer = await import(pathToFileURL(join(folder, 'read-data/value-history/history-requests.mjs')));
  const input = { now_ms: 0, kept: {}, fields: [{ id: 'computed', history: { field: 'stage', op: 'time_spent_in' } }] };
  let admittedWork = false;
  try {
    admittedWork = true;
    consumer.historyFieldValues(input);
    assert.fail('the unfinished history field must refuse');
  } catch (error) {
    assert.ok(error instanceof api.ListsError);
    const refusal = api.listRefusal(error);
    assert.equal(refusal.status, 400);
    assert.equal(refusal.body.refused.code, error.detail.code);
    assert.equal(admittedWork, true, 'a refusal does not establish that prior work did not execute');
  }
  assert.equal(api.listRefusal(new Error('another failure')), null);
  const argv = row.invoke.run.map(placed);
  const child = spawnSync(process.execPath, argv.slice(1), { cwd: folder, input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 1);
  assert.match(JSON.parse(child.stdout.trim().split('\n').at(-1)).error, /works its value out from a field's history/);
});
