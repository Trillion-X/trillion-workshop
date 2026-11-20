import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { findGnuMove, linkGnuMove } from './target-tools.mjs';

test('discovers a genuine GNU move under either installed name and performs Linux symlink replacement', t => {
  const root = tempFolder(join(tmpdir(), 'target-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = findGnuMove(), originalPath = process.env.PATH;
  for (const name of ['mv', 'gmv']) {
    const candidates = join(root, name), fixture = join(candidates, 'fixture');
    mkdirSync(fixture, { recursive: true });
    symlinkSync(executable, join(candidates, name));
    assert.equal(findGnuMove({ path: candidates, extraDirectories: [] }), executable);
    assert.equal(linkGnuMove(fixture, { path: candidates, extraDirectories: [] }), executable);
    assert.equal(linkGnuMove(fixture, { path: candidates, extraDirectories: [] }), executable);
    assert.equal(readlinkSync(join(fixture, 'mv')), executable);
    const old = join(candidates, 'old'), next = join(candidates, 'next');
    mkdirSync(old); mkdirSync(next);
    writeFileSync(join(next, 'marker'), 'new release');
    symlinkSync(old, join(fixture, 'current'));
    symlinkSync(next, join(fixture, 'current.new'));
    const result = spawnSync('sh', ['-c', 'mv -T current.new current'], { cwd: fixture, env: { ...process.env, PATH: `${fixture}:${originalPath}` }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readlinkSync(join(fixture, 'current')), next);
    assert.equal(readFileSync(join(fixture, 'current', 'marker'), 'utf8'), 'new release');
  }
  assert.equal(process.env.PATH, originalPath);
});

test('fails clearly without a genuine target utility and preserves an existing fixture command', t => {
  const root = tempFolder(join(tmpdir(), 'target-tools-refusal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => findGnuMove({ path: root, extraDirectories: [] }), /require genuine GNU coreutils mv/);
  symlinkSync(process.execPath, join(root, 'mv'));
  assert.throws(() => findGnuMove({ path: root, extraDirectories: [] }), /require genuine GNU coreutils mv/);
  assert.throws(() => linkGnuMove(root), /already owns a different mv/);
  assert.equal(readlinkSync(join(root, 'mv')), process.execPath);
});
