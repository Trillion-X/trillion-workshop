// Parity check for the yt-dlp link reader. The old record in from-an-older-version/records/hear-fetcher-records.json
// was ported to two homes: the fetchers entry "yt-dlp" in read-data/hear-a-link.json (every key but list), and the
// fetchers entry "yt-dlp" in run-on-a-persons-computer/list-a-channel.json (its list command). This test reads the
// old payload and asserts every one of its keys equals the new home. It must pass before the old copy is removed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(join(here, rel), 'utf8'));

const oldRecordSet = readJson('../from-an-older-version/records/hear-fetcher-records.json');
const hearHome = readJson('../read-data/hear-a-link.json');
const listHome = readJson('../../run-on-a-persons-computer/list-a-channel.json');

const oldRecord = oldRecordSet.records.find((r) => r.id === 'hear-fetcher:yt-dlp');
const hearEntry = hearHome.fetchers.find((f) => f.id === 'yt-dlp');
const listEntry = listHome.fetchers.find((f) => f.id === 'yt-dlp');

test('the old record is the yt-dlp hear-fetcher row', () => {
  assert.ok(oldRecord, 'hear-fetcher:yt-dlp is in the held file');
  assert.equal(oldRecord.kind, 'hear-fetcher');
  assert.equal(oldRecord.payload.id, 'yt-dlp');
});

test('the new homes both exist', () => {
  assert.ok(hearEntry, 'hear-a-link.json has the yt-dlp fetcher');
  assert.ok(listEntry, 'list-a-channel.json has the yt-dlp fetcher');
});

test('every old payload key equals its new home', () => {
  const payload = oldRecord.payload;
  const keys = Object.keys(payload);
  assert.deepEqual(
    keys.sort(),
    ['captions', 'check', 'id', 'info', 'label', 'list', 'search_path', 'sound', 'update_hint'],
    'the old payload has exactly the keys this test checks',
  );
  for (const key of keys) {
    if (key === 'list') {
      assert.deepEqual(listEntry.list, payload.list, 'list equals the list entry in list-a-channel.json');
      assert.ok(!('list' in hearEntry), 'hear-a-link.json does not carry list');
      continue;
    }
    assert.deepEqual(hearEntry[key], payload[key], `${key} equals the hear-a-link.json yt-dlp fetcher`);
  }
});

test('the list home carries the same identity and reader as the old payload', () => {
  assert.equal(listEntry.id, oldRecord.payload.id);
  assert.equal(listEntry.label, oldRecord.payload.label);
  assert.deepEqual(listEntry.check, oldRecord.payload.check);
  assert.deepEqual(listEntry.search_path, oldRecord.payload.search_path);
  assert.equal(listEntry.update_hint, oldRecord.payload.update_hint);
});
