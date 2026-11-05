// Runs the Python tests of this tool (test/test_claim_check.py) on a made-up world, sources and shots
// (test/fixture_world.py): the old fact gate's seven regression tests one for one, every other rule, the world's own
// check, both commands, the refusals and the settings wrapper. Needs python3; without it the Python part skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const folder = fileURLToPath(new URL('..', import.meta.url));
const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(r => r.payload);
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });

test('the rows run on the person\'s computer and name scripts that exist', () => {
  assert.deepEqual(rows.map(r => r.id), ['tool:check-every-claim-against-its-facts-and-sources', 'tool:make-plain-text-extracts-of-claim-sources']);
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'on-your-computer');
    const script = row.invoke.run.match(/tools\/check-every-claim-against-its-facts-and-sources\/(do-work\/\S+\.py)/)[1];
    assert.ok(existsSync(join(folder, script)), script);
  }
  assert.match(rows[0].invoke.run, /run-with-settings\.mjs --folder check-every-claim-against-its-facts-and-sources -- python3 -I /);
});

test('the Python tests of check-every-claim-against-its-facts-and-sources pass', { skip: python.status !== 0 && 'needs python3' }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
