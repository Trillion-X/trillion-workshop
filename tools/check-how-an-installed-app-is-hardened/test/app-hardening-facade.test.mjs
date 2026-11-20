import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as facade from '../read-data/app-hardening.mjs';
import * as core from '../read-data/app-hardening-core.mjs';

test('the public app-hardening path preserves every core export by identity', () => {
  assert.deepEqual(Object.keys(facade).sort(), Object.keys(core).sort());
  for (const name of Object.keys(core)) assert.strictEqual(facade[name], core[name], `${name} keeps its core identity`);
});

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Install only the row's declared files; a sibling checkout must not hide a missing dependency.
test('the packaged descriptor executes the historical public entry with its relative DATA', t => {
  const repository = fileURLToPath(new URL('../../..', import.meta.url));
  const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url))).records[0].payload;
  const sandbox = tempFolder(join(tmpdir(), 'public-facade-package-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const placed = path => path.startsWith('/opt/') ? join(sandbox, path.slice(1)) : path;
  for (const spec of [row.invoke.files.package_files].flat()) {
    const owner = spec.package ? join(repository, 'tools', spec.package) : join(repository, 'node_modules', spec.module);
    for (const path of spec.paths) {
      const target = join(placed(spec.at), path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(owner, path), target, { recursive: true });
    }
  }
  assert.equal(existsSync(join(placed(row.invoke.workdir), 'source-baselines')), false);
  const argv = row.invoke.argv.map(placed);
  const child = spawnSync(process.execPath, argv.slice(1), {
    cwd: placed(row.invoke.workdir), input: JSON.stringify({ app: join(sandbox, 'absent-synthetic.app') }), encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const { result } = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map(item => item.kind), ['no_app']);
});
