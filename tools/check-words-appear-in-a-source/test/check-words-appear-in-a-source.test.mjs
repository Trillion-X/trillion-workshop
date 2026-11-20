// Runs this tool's Python tests (made-up transcript and essay pages: exact words, a wrong speaker, smart punctuation, a
// page that cannot be read) and checks that the row's command is a file in this folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;

test('the row runs a script that is in this folder', () => {
  const script = row.invoke.run.match(/tools\/check-words-appear-in-a-source\/(\S+\.py)/)?.[1];
  assert.ok(script, 'the run command names a script');
  assert.ok(existsSync(join(folder, script)), `${script} exists`);
});

test('the Python tests pass', () => {
  const run = spawnSync('python3', [join(folder, 'test', 'test_check_words.py')], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`.split('\n').slice(-30).join('\n'));
});
