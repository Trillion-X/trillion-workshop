// Runs the FilmCraft preview tools' Python tests on a made-up film with the stand-in filmcraft-cli, ffmpeg and ffprobe
// (test/stand_in_*.py), and checks that every preview row's command is a file in this folder. The review-pack check also needs
// ffmpeg and Pillow and skips itself, saying so, without them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const rows = JSON.parse(readFileSync(join(folder, 'what-this-tool-does-and-how-to-run-it.json'), 'utf8')).records.map((r) => r.payload);
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const skip = python.status === 0 ? false : 'needs python3';

test('every row runs a script that is in this folder', () => {
  for (const row of rows) {
    const script = row.invoke.run.match(/tools\/put-picked-options-into-a-filmcraft-project\/(\S+\.py)/)?.[1];
    assert.ok(script, `${row.id} names a script`);
    assert.ok(existsSync(join(folder, script)), `${script} exists`);
  }
});

test('no row takes the records door: the pick gate reads the rows its AI hands it (--stored), and the four preview rows take the film\'s settings as input', () => {
  for (const row of rows) {
    assert.equal(row.invoke.records, undefined, row.id);
    assert.equal(row.stored, undefined, row.id);
    assert.doesNotMatch(JSON.stringify(row), /records:(read|write|list)/, row.id);
    if (row.id === 'tool:put-a-picked-option-into-a-filmcraft-project') assert.match(JSON.stringify(row.input_schema), /stored_file/);
    else assert.match(JSON.stringify(row.input_schema), /settings_record/, row.id);
  }
});

for (const file of ['test_prepend.py', 'test_cold_opens.py', 'test_publish.py', 'test_rounds.py', 'test_filmcraft_preview.py']) {
  test(`${file} passes`, { skip }, () => {
    const run = spawnSync('python3', [join(folder, 'test', file)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 600000 });
    assert.equal(run.status, 0, `${run.stdout.split('\n').slice(-20).join('\n')}\n${run.stderr.split('\n').slice(-40).join('\n')}`);
  });
}
