// Checks each row of generate-and-judge-sound-effects names a script that exists and runs on the person's computer, and
// runs the Python tests (test/test_judge_sound_effects.py): every command for real on made-up tones and made-up library
// pages, with the stand-in earshot in test/stubs. The parts that need numpy, soundfile and ffmpeg skip inside the Python
// tests and say why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const here = join(folder, 'test');
const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });

test('each row runs on the person\'s computer, names a script that exists, and every input it takes is in its command', () => {
  assert.equal(rows.length, 13);
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'on-your-computer', row.id);
    const script = row.invoke.run.match(/tools\/generate-and-judge-sound-effects\/(do-work\/\w+\.py)/)[1];
    assert.ok(existsSync(join(folder, script)), script);
    for (const name of Object.keys(row.input_schema.properties)) assert.ok(row.invoke.run.includes(`{${name}}`), `${row.id} ${name}`);
    for (const name of row.input_schema.required) assert.ok(name in row.input_schema.properties, `${row.id} ${name}`);
    assert.deepEqual(row.placements, ['placement:your-computer']);
    assert.equal(row.invoke.run.includes('earshot') || !row.invoke.needs.some(need => need.startsWith('earshot')), true, `${row.id} says which Python runs it`);
  }
});

test('the Python tests of generate-and-judge-sound-effects pass', { skip: python.status === 0 ? false : 'needs python3' }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
