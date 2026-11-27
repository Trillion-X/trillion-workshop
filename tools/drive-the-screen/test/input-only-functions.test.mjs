// The five Workshop functions take the run's input and nothing else: tools/workflows/do-work/run-a-function.mjs calls each
// with the input, and no door or context reaches them. Every row runs that runner on one of these exports, and a call that
// leaves out what it needs is refused in words, never run on nothing.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickOnThisMacsScreen, driveTheScreen, findOnTheScreen, lookAtTheScreen, makeScreenTools, screenActions } from '../read-data/drive-the-screen.mjs';
import { makePlaces } from '../read-data/work-places.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(readFileSync(join(HERE, '..', 'what-this-tool-does-and-how-to-run-it.json'), 'utf8')).records.filter(record => record.payload?.invoke);
const exports = { lookAtTheScreen, findOnTheScreen, screenActions, driveTheScreen, clickOnThisMacsScreen };

// The person is away from this Mac, so a drive reaches its own refusals instead of waiting for them to leave it.
const awayFor = ns => argv => ({ code: 0, stdout: Buffer.from(argv[0] === 'ioreg' ? `"HIDIdleTime" = ${ns}` : ''), stderr: '' });
const placesAway = () => makePlaces({ home: tempFolder(join(tmpdir(), 'input-only-places-')), exec: async argv => awayFor(60e9)(argv) });
const drive = input => makeScreenTools({ places: placesAway }).drive(input);

test('every row runs the workflows runner on one of these functions, which takes only the input, and mounts no records door', () => {
  assert.equal(rows.length, 5);
  for (const row of rows) {
    const { argv, files } = row.payload.invoke;
    assert.deepEqual(argv.slice(0, 3), ['node', '/opt/workflows/do-work/run-a-function.mjs', '/opt/drive-the-screen/read-data/drive-the-screen.mjs']);
    assert.equal(typeof exports[argv[3]], 'function', `${argv[3]} is exported`);
    assert.equal(exports[argv[3]].length, 1, `${argv[3]} takes the input and no context`);
    assert.ok(files.package_files.some(mount => mount.package === 'workflows' && mount.paths.includes('do-work/run-a-function.mjs')));
    assert.ok(!files.package_files.some(mount => mount.package === 'records-door'), 'no records-door mount');
    assert.ok(!row.payload.uses_tools.includes('trillion-workshop/records-door'), 'no records-door tool');
  }
});

test('a drive with no input, or with an unknown action, is refused in words and runs nothing', async () => {
  for (const answer of [await drive(), await drive({ action: 'nonsense' })]) {
    assert.equal(answer.reaction, 'use_different_tool');
    assert.equal(typeof answer.error, 'string');
    assert.equal(answer.dispatched, undefined, 'nothing was dispatched');
  }
});

test('a press that leaves out the target it needs is refused before the screen is read', async () => {
  const answer = await drive({ action: 'press' });
  assert.equal(answer.reaction, 'retry');
  assert.equal(typeof answer.error, 'string');
  assert.equal(answer.dispatched, undefined, 'nothing was dispatched');
});
