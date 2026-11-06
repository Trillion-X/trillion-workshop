// Runs the Python tests of this folder (test_measures.py, test_word_rules.py) on the made-up show of fixture_world.py,
// and checks that every row names a script that exists. Tests that need numpy, scikit-learn, node or tools/settings say
// so and skip where those are missing; everything else runs with python3 alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);

for (const file of ['test_measures.py', 'test_word_rules.py']) {
  test(`${file} passes`, () => {
    const run = spawnSync('python3', ['-I', join(folder, 'test', file)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
}

test('every row runs a script of this folder and reads settings only through tools/settings', () => {
  for (const row of rows) {
    const script = row.invoke.kind === 'computer' ? row.invoke.argv.at(-1).replace('/opt/measure-a-characters-voice-lines-and-staging/', '')
      : row.invoke.run.match(/measure-a-characters-voice-lines-and-staging\/(\S+\.py)/)[1];
    assert.ok(existsSync(join(folder, script)), `${row.id} runs ${script}`);
    assert.equal(row.licence_class, 'licence:maker-own');
    assert.deepEqual(row.placements, ['placement:your-computer']);
    const packs = [row.invoke.files?.package_files ?? []].flat().map(pack => pack.package);
    if ('settings_record' in row.input_schema.properties && row.invoke.kind === 'computer') assert.ok(packs.includes('settings'), `${row.id} packs tools/settings`);
  }
  assert.ok(!existsSync(join(folder, 'read-data', 'settings.py')), 'no second settings reader');
});
