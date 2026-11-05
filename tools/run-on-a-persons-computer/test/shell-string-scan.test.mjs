// test/shell-string-scan.test.mjs
// The release check against a shell command built from supplied words (computer/shell-string-scan.mjs): it finds each
// way of building one, leaves argument-array calls and database `exec` alone, and the repository has none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText, scanTree, shellStringSettings } from '../shell-string-scan.mjs';

const settings = shellStringSettings();
const hit = (path, text) => scanText(path, text, settings).map(row => row.rule);

test('each way of building a shell command string is found', () => {
  assert.deepEqual(hit('a.mjs', "import { exec } from 'node:child_process';\nexec(`say ${name}`);"), ['exec-string']);
  assert.deepEqual(hit('a.mjs', "import { execSync as run, exec } from 'child_process';\nexec(cmd, done);"), ['exec-string']);
  assert.deepEqual(hit('a.mjs', "import cp from 'node:child_process'; child_process.execSync('ls');"), ['exec-string-qualified']);
  assert.deepEqual(hit('a.ts', "spawn('ffmpeg', args, { shell: true });"), ['shell-true']);
  assert.deepEqual(hit('a.mjs', "execFile('/bin/sh', ['-c', `open ${url}`]);"), ['shell-dash-c-built-string']);
  assert.deepEqual(hit('a.mjs', "execFile('zsh', ['-c', 'open ' + url]);"), ['shell-dash-c-built-string']);
  assert.deepEqual(hit('a.mjs', "execFile('bash', ['-c', script]);"), ['shell-dash-c-built-string']);
  assert.deepEqual(hit('A.swift', 'p.arguments = ["-c", "open \\(url)"]'), ['shell-dash-c-built-string']);
});

test('argument-array calls, database exec and a fixed shell script are not hits', () => {
  assert.deepEqual(hit('a.mjs', "import { execFile } from 'node:child_process';\nawait execFile('open', [url]);"), []);
  assert.deepEqual(hit('a.mjs', "db.exec(`CREATE TABLE x (y)`);\nsql.exec('SELECT 1');"), []);
  assert.deepEqual(hit('a.mjs', "import { exec } from './db.mjs';\nexec('SELECT 1');"), [], 'an exec that is not child_process is not one');
  assert.deepEqual(hit('A.swift', 'p.arguments = ["-c", "echo done"]'), []);
  assert.deepEqual(hit('notes.md', 'shell: true'), []);
});

test('an exception counts only with its reason', () => {
  const text = "spawn('x', [], { shell: true });";
  assert.deepEqual(scanText('a.mjs', text, { ...settings, allowed: [{ file: 'a.mjs', because: 'a fixed constant command' }] }), []);
  assert.deepEqual(scanText('a.mjs', text, { ...settings, allowed: [{ file: 'a.mjs' }] }).map(row => row.rule), ['shell-true']);
});

test('the repository builds no shell command string', () => {
  const hits = scanTree(new URL('..', import.meta.url).pathname);
  assert.deepEqual(hits, []);
});
