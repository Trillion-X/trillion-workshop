// Checks the row names the script that exists and packs what it imports, runs the row's own sample the way the
// container runner does, and runs the Python tests (test/test_recipe_nutrients.py) on made-up FoodData-Central-shaped
// CSVs. Needs python3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRow } from '../../../test-helpers/run-a-row.mjs';

const folder = fileURLToPath(new URL('..', import.meta.url));
const here = join(folder, 'test');
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });

test('the row runs the script that exists and packs the folders it imports', () => {
  assert.equal(row.id, 'tool:work-out-a-recipes-nutrients-from-fooddata-central');
  assert.deepEqual(row.invoke.argv, ['python3', '-I', 'do-work/work_out_recipe_nutrients.py']);
  assert.deepEqual(row.invoke.files.package_files.map(spec => [spec.package, spec.paths]),
    [['work-out-a-recipes-nutrients-from-fooddata-central', ['do-work', 'read-data']], ['settings', ['read-data']]]);
  for (const file of ['do-work/work_out_recipe_nutrients.py', 'read-data/fooddata_central.py', 'read-data/recipe_profile.py', 'ports/recipe-nutrients-reading.json', 'ports/recipe-nutrients-profile.json']) {
    assert.ok(existsSync(join(folder, file)), file);
  }
});

test('the row\'s own sample works out a made-up smoothie', { skip: python.status === 0 ? false : 'needs python3' }, async () => {
  const sample = row.verify.find(check => check.kind === 'sample-run');
  const ran = await runRow(row, sample.input, sample);
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(ran.last.profile.mix_mass_g, 340);
  const energy = ran.last.profile.nutrients.find(n => n.key === 'energy');
  assert.equal(energy.per_batch, 234);   // 60 x 2.4 + 90 (energy from the 2047 fallback)
  const sodium = ran.last.profile.nutrients.find(n => n.key === 'sodium');
  assert.equal(sodium.flag, 'unknown_lower_bound_only');   // the base drink has no sodium value
});

test('the Python tests of work-out-a-recipes-nutrients-from-fooddata-central pass', { skip: python.status === 0 ? false : 'needs python3' }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
