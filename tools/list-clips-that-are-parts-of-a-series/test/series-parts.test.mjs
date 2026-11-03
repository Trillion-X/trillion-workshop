// Runs the Python tests of this tool (test/test_series_parts.py) on made-up clips, and checks the row
// names the script that exists. Needs python3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const here = join(folder, 'test');
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });

test('the row runs on the person\'s computer and names the script that exists', () => {
  assert.equal(row.id, 'tool:list-clips-that-are-parts-of-a-series');
  assert.equal(row.invoke.kind, 'on-your-computer');
  assert.match(row.invoke.run, /tools\/list-clips-that-are-parts-of-a-series\/do-work\/series_parts\.py \{moments\}/);
  assert.ok(existsSync(join(folder, 'do-work', 'series_parts.py')));
});

test('the Python tests of list-clips-that-are-parts-of-a-series pass', { skip: python.status === 0 ? false : 'needs python3' }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
