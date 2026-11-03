// Runs the Python tests of this tool (test/test_edit_a_copy.py) on a made-up Premiere project that
// test/synthetic_prproj.py builds (gzipped XML, two invented recordings): cut, move, assemble, inserts of files and
// placeholders, the structural checks, the --written record that guards an existing output, the refusals and the
// EDIT-PLAN compiler. Needs python3 and BLAKE3 (the blake3 python module or the b3sum command); without them it skips
// and says why. The file-insert and proxy tests also need ffmpeg and skip inside Python without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const folder = fileURLToPath(new URL('..', import.meta.url));
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const blake3 = python.status === 0 && (spawnSync('python3', ['-I', '-c', 'import blake3']).status === 0
  || spawnSync('b3sum', ['--version']).status === 0);
const skip = python.status !== 0 ? 'needs python3' : blake3 ? false : 'needs BLAKE3: python3 -m pip install blake3, or the b3sum command';

test('the row runs on the person\'s computer and names the script that exists', () => {
  assert.equal(row.id, 'tool:edit-a-copy-of-a-premiere-project');
  assert.equal(row.invoke.kind, 'on-your-computer');
  assert.match(row.invoke.run, /^python3 tools\/edit-a-copy-of-a-premiere-project\/do-work\/premiere_insert\.py \{plan\} --written \{written\}/);
  assert.ok(existsSync(join(folder, 'do-work', 'premiere_insert.py')));
});

test('the Python tests of edit-a-copy-of-a-premiere-project pass', { skip }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
