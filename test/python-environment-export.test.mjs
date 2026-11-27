// The shared test-environment export must carry its actual DATA/probe and runtime import closure.
import { tempFolder } from '../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { pythonProfile } from 'trillion-workshop/test-helpers/python-environment.mjs';
import { root } from '../test-helpers/tool-rows.mjs';

if (process.argv[2] === 'profile-readback') {
  const profile = pythonProfile('audio');
  process.stdout.write(JSON.stringify({ name: profile.name, python: profile.configuration.python,
    packages: profile.configuration.packages.map(row => row.name) }));
} else {
  test('the exported audio profile is pinned and includes the actual pitch-analysis dependencies', () => {
    const profile = pythonProfile('audio');
    assert.deepEqual(profile.configuration.python, [3, 14]);
    const packages = new Map(profile.configuration.packages.map(row => [row.name, row]));
    for (const name of ['numpy', 'scipy', 'soundfile', 'librosa', 'numba', 'llvmlite']) {
      assert.ok(packages.has(name), `${name} is explicitly declared`);
    }
    assert.equal(packages.size, profile.configuration.packages.length, 'dependency names are unique');
    for (const row of packages.values()) {
      assert.ok(row.hashes.length && row.hashes.every(hash => /^[a-f0-9]{64}$/.test(hash)), `${row.name} has publisher wheel pins`);
      assert.ok(row.source.startsWith('https://pypi.org/pypi/'), `${row.name} names its publisher metadata`);
    }
  });

  test('the real package export loads from an isolated pack with its declared helper files', () => {
    const folder = tempFolder(join(tmpdir(), 'python-environment-export-'));
    try {
      const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      assert.equal(metadata.exports['./test-helpers/python-environment.mjs'], './test-helpers/python-environment.mjs');
      assert.ok(metadata.files.includes('test-helpers/python-*'));
      assert.ok(metadata.files.includes('tools'));
      const copy = (relative, source = join(root, relative)) => {
        const target = join(folder, relative);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target, { recursive: true });
      };
      copy('package.json');
      const helpers = readdirSync(join(root, 'test-helpers')).filter(name => /^python-.*\.(json|mjs|py)$/.test(name));
      for (const name of helpers) copy(join('test-helpers', name));
      for (const file of ['tools/content-identity/read-data/identity.mjs', 'tools/content-identity/read-data/blake3.mjs',
        'tools/process-session/do-work/place-cache-folder.mjs', 'test-helpers/tool-rows.mjs']) copy(file);
      const rows = JSON.parse(readFileSync(join(root, 'tools/check-a-port-against-its-source/what-this-tool-does-and-how-to-run-it.json'), 'utf8'));
      const tool = rows.records.find(row => row.payload.id === 'tool:check-a-reference-adaptation-contract').payload;
      const dependency = tool.invoke.files.package_files.find(row => row.module === '@noble/hashes');
      for (const file of dependency.paths) copy(join('node_modules', dependency.module, file));
      const profiles = JSON.parse(readFileSync(join(folder, 'test-helpers/python-environment-profiles.json'), 'utf8'));
      for (const row of Object.values(profiles)) assert.ok(existsSync(join(folder, 'test-helpers', row.file)), `${row.file} is packed`);
      // This test module is its own read-only child probe, so no interpreter source is supplied in argv.
      const entry = 'test/python-environment-export.test.mjs';
      copy(entry, fileURLToPath(import.meta.url));
      const result = spawnSync(process.execPath, [join(folder, entry), 'profile-readback'], {
        cwd: folder, encoding: 'utf8', timeout: 20_000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const readback = JSON.parse(result.stdout);
      assert.equal(readback.name, 'audio');
      assert.deepEqual(readback.python, [3, 14]);
      assert.ok(readback.packages.includes('librosa'));
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
}
