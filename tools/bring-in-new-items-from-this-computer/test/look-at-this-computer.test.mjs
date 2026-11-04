// tool:look-for-the-places-on-this-computer: one look, run the way the local door runs a row (test-helpers/run-a-row.mjs),
// over made-up files in the granted folder; and the look itself, which never looks outside that folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runRow} from '../../../test-helpers/run-a-row.mjs';
import {lookAtThisComputer} from '../do-work/look-at-this-computer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [row] = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'tool-rows.json'), 'utf8')).records.map(record => record.payload);

test('the row\'s sample run finds the made-up store and folder, leaves out what is not there, and does not look at a drive', async () => {
  const [sample] = row.verify;
  const ran = await runRow(row, sample.input, sample);
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(ran.last.said, '2 found, 0 need a switch, 1 not checked, of 4 places.');
  assert.deepEqual(ran.last.sources.map(source => [source.id, source.state, source.detail ?? null]), [
    ['messages', 'found', null],
    ['downloads', 'found', '2 files'],
    ['drives', 'could_not_check', 'It lives outside the folder this look was given.'],
  ]);
  assert.deepEqual(ran.last.browser_sites, []);
});

test('a row\'s places outside the folder are never looked at; a row with some inside is looked at there only', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'look-at-this-computer-'));
  try {
    fs.mkdirSync(path.join(home, '.made-up-app'));
    const rows = {sources: [
      // `/` is on every computer: were it looked at, both rows would be found from it.
      {id: 'outside', label: 'Outside', category: 'Files', look: {paths: ['/']}},
      {id: 'both', label: 'Both', category: 'AI', look: {paths: ['/', '~/.made-up-app']}},
      {id: 'missing', label: 'Missing', category: 'AI', look: {paths: ['/', '~/.not-here']}},
    ]};
    const answer = lookAtThisComputer({}, home, {rows});
    assert.deepEqual(answer.sources.map(source => [source.id, source.state]), [['outside', 'could_not_check'], ['both', 'found']]);
    assert.equal(answer.said, '1 found, 0 need a switch, 1 not checked, of 3 places.');
  } finally { fs.rmSync(home, {recursive: true, force: true}); }
});

test('a request it cannot answer says what to give instead', () => {
  assert.throws(() => lookAtThisComputer({}, 'relative/folder'), /Give the folder to look in/);
  assert.throws(() => lookAtThisComputer({places: ['no-such-place']}, '/'), /No place is called no-such-place; the places are .*messages/);
  assert.throws(() => lookAtThisComputer({services: [{vendor: 'x'}]}, '/'), /services lists \{ vendor, domains/);
});
