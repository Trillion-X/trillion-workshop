// Runs the pure readers' tests (test_who_is_in.py, made-up voices and faces) and checks that enrol-a-print.py refuses before it
// measures anything: no consent words, no known kind. The three tools' rows are checked for the way they keep prints:
// a print kind a row keeps is declared stays_on_this_device. Needs python3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const python = args => spawnSync('python3', ['-B', ...args], { encoding: 'utf8' });
const skip = python(['--version']).status === 0 ? false : 'needs python3';
const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);

test('the pure readers pass on made-up voices and faces', { skip }, () => {
  const run = python([join(folder, 'test', 'test_who_is_in.py')]);
  assert.equal(run.status, 0, run.stderr);
});

test('enrol-a-print refuses without consent words or a known kind, before it measures anything', { skip }, () => {
  const enrol = input => spawnSync('python3', ['-B', join(folder, 'do-work', 'enrol-a-print.py')], { input: JSON.stringify(input), encoding: 'utf8' });
  const noWords = enrol({ kind: 'voice', name: 'Ann', consent: '  ', file: '/does/not/exist.wav' });
  assert.notEqual(noWords.status, 0);
  assert.match(noWords.stderr, /agreed to be known/);
  const noKind = enrol({ kind: 'gait', name: 'Ann', consent: 'said yes', file: '/does/not/exist.wav' });
  assert.notEqual(noKind.status, 0);
  assert.match(noKind.stderr, /voice or a face/);
});

test('every row that reads or keeps a print kind says in its description that the kind stays on the device it was made on', () => {
  assert.deepEqual(rows.map(row => row.id).sort(), ['tool:enrol-a-voice-or-face', 'tool:find-faces', 'tool:who-is-in-this']);
  for (const row of rows) {
    const text = JSON.stringify(row);
    for (const kind of ['voice-print', 'face-print', 'listening-voices']) {
      if (text.includes(`"${kind}"`)) assert.match(row.description, new RegExp(`${kind}[^.]*stays_on_this_device: true`), `${row.id}: ${kind} is declared stays_on_this_device: true`);
    }
  }
});
