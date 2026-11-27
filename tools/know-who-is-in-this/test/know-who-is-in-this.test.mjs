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
const allRows = JSON.parse(readFileSync(join(folder, 'what-this-tool-does-and-how-to-run-it.json'), 'utf8')).records.map(record => record.payload);
const appearanceIds = ['tool:keep-who-appeared'];
const rows = allRows.filter(row => !appearanceIds.includes(row.id));

test('the pure readers pass on made-up voices and faces', { skip }, () => {
  const run = python([join(folder, 'test', 'test_who_is_in.py')]);
  assert.equal(run.status, 0, run.stderr);
});

test('a recording alone uses the shared speech owner and preserves real times, refusal and cleanup', () => {
  assert.ok(process.env.WORKSHOP_TEST_PYTHON, 'Supply the verified WORKSHOP_TEST_PYTHON binding; tests do not install dependencies.');
  const run = spawnSync(process.env.WORKSHOP_TEST_PYTHON, ['-B', join(folder, 'test', 'test_recording_composition.py'), '-v'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /Ran 10 tests/);
});

test('the recording tool can hear a file alone through its existing audio owner', () => {
  const row = rows.find(row => row.id === 'tool:who-is-in-this');
  assert.deepEqual(row.input_schema.required, ['file']);
  assert.equal(row.input_schema.properties.segments.minItems, 1);
  assert.deepEqual(row.input_schema.properties.segments.items.required, ['start', 'end']);
  assert.equal(row.screen.inputs.file.file.takes, 'seen-or-heard');
  assert.ok(row.invoke.files.package_files.some(part => part.package === 'audio-transcription'
    && part.paths.includes('do-work/whisper_here.py') && part.at === '/opt/audio-transcription'));
  assert.equal(row.needs.network_egress, true);
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
  assert.deepEqual(rows.map(row => row.id).sort(), ['tool:enrol-a-voice-or-face', 'tool:enroll-someone', 'tool:find-faces', 'tool:who-is-in-this']);
  assert.deepEqual(allRows.map(row => row.id).filter(id => appearanceIds.includes(id)).sort(), appearanceIds);
  for (const row of allRows) {
    const text = JSON.stringify(row);
    for (const kind of ['voice-print', 'face-print', 'listening-voices']) {
      if (text.includes(`"${kind}"`)) assert.match(row.description, new RegExp(`${kind}[^.]*stays_on_this_device: true`), `${row.id}: ${kind} is declared stays_on_this_device: true`);
    }
  }
});
