// scripts/credential-file.mjs: a credential is read from its own mode-600 file, never a file others can read.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, symlinkSync, lstatSync, statSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a credential file is read only when it is the owner\'s alone, and is named by its file name only', async t => {
  const home = tempFolder(join(tmpdir(), 'credential-file-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = previous; });
  const { readCredentialFile } = await import(new URL(`../scripts/credential-file.mjs?${Date.now()}`, import.meta.url).href);
  mkdirSync(join(home, '.bitfield', 'credentials'), { recursive: true });
  const file = join(home, '.bitfield', 'credentials', 'fixture-key');
  writeFileSync(file, 'fixture-value\n');
  chmodSync(file, 0o600);
  assert.equal(readCredentialFile('fixture-key'), 'fixture-value');
  chmodSync(file, 0o644);
  assert.throws(() => readCredentialFile('fixture-key'), /readable by others \(mode 644\)/);
  chmodSync(file, 0o600);
  writeFileSync(file, '\n');
  assert.throws(() => readCredentialFile('fixture-key'), /is empty/);
  assert.throws(() => readCredentialFile('../fixture-key'), /file name only/);
  assert.throws(() => readCredentialFile('missing-key'), /ENOENT/);
});

test('replacing a credential replaces a symlink without writing through it', async t => {
  const dir = tempFolder(join(tmpdir(), 'credential-replace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { writeCredentialFile, readCredentialFile } = await import('../scripts/credential-file.mjs');
  const target = join(dir, 'unrelated-file');
  const file = join(dir, 'fixture-key');
  writeFileSync(target, 'original unrelated bytes');
  symlinkSync(target, file);
  writeCredentialFile('fixture-key', 'replacement-fixture', { dir });
  assert.equal(readFileSync(target, 'utf8'), 'original unrelated bytes');
  assert.equal(lstatSync(file).isSymbolicLink(), false);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readCredentialFile('fixture-key', { dir }), 'replacement-fixture');
});

test('an existing reader of a permissive file never receives its replacement credential', async t => {
  const dir = tempFolder(join(tmpdir(), 'credential-open-reader-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'fixture-key');
  writeFileSync(file, 'old non-secret contents', { mode: 0o644 });
  const reader = openSync(file, 'r');
  try {
    const { writeCredentialFile } = await import('../scripts/credential-file.mjs');
    writeCredentialFile('fixture-key', 'replacement-fixture', { dir });
    assert.equal(readFileSync(reader, 'utf8'), 'old non-secret contents');
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { closeSync(reader); }
});
