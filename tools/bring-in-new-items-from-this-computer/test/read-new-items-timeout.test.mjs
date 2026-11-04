// A child-read deadline must not claim macOS refused access or open Privacy settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CHILD_READERS, readNewItems} from '../computer/read-new-items.mjs';

test('a timed-out child read keeps its cursor, retries and never asks for access', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-read-timeout-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const stateFile = path.join(dir, 'state.json');
  const since = '2026-10-12T10:00:00.000Z';
  fs.writeFileSync(stateFile, JSON.stringify({Files: {since, sent: {}}}));
  let opened = 0;
  let attempts = 0;
  const carrier = {route: 'Files', reader: 'folder', store: dir, read_seconds: 0.001};
  const reading = readNewItems({
    carriers: [carrier],
    stateFile,
    account: async () => assert.fail('a failed or empty read sends nothing'),
    keep: async () => assert.fail('a failed or empty read keeps nothing'),
    openAccessPane: () => { opened += 1; },
    readers: {folder: (row, from) => {
      attempts += 1;
      return attempts === 1 ? CHILD_READERS.folder(row, from) : [];
    }},
  });

  await reading.tick();
  assert.match(reading.status()[0].status, /Reading took too long/);
  assert.notEqual(reading.status()[0].status, 'needs access');
  assert.equal(opened, 0);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).Files.since, since);
  await reading.tick();
  assert.equal(attempts, 2, 'the next look tries this source again');
  assert.equal(reading.status()[0].status, 'working');
  assert.equal(opened, 0);
});

test('a real access denial still asks for access only once', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-read-denied-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  let opened = 0;
  const reading = readNewItems({
    carriers: [{route: 'Files', reader: 'folder', store: dir}],
    stateFile: path.join(dir, 'state.json'),
    account: async () => assert.fail('a denied read sends nothing'),
    keep: async () => assert.fail('a denied read keeps nothing'),
    openAccessPane: () => { opened += 1; },
    readers: {folder: () => { throw new Error('EACCES: permission denied'); }},
  });

  await reading.tick();
  await reading.tick();
  assert.equal(reading.status()[0].status, 'needs access');
  assert.equal(opened, 1);
});
