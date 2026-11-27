// Runs this tool's Python tests (made-up notes pages, the layout as DATA, the refusals) and checks that the row's command is a
// file in this folder. The Python tests need Pillow and a headless Chromium; without either they skip and say why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const row = JSON.parse(readFileSync(join(folder, 'what-this-tool-does-and-how-to-run-it.json'), 'utf8')).records[0].payload;

test('the row runs a script that is in this folder', () => {
  const script = row.invoke.run.match(/tools\/draw-pages-in-a-layout\/(\S+\.py)/)?.[1];
  assert.ok(script, 'the run command names a script');
  assert.ok(existsSync(join(folder, script)), `${script} exists`);
});

test('the Python tests pass', () => {
  const run = spawnSync('python3', [join(folder, 'test', 'test_draw_pages.py')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 0, output.split('\n').slice(-40).join('\n'));
  assert.doesNotMatch(output, /skipped/, 'the Python tests ran, none skipped (needs Pillow and a headless Chromium)');
});
