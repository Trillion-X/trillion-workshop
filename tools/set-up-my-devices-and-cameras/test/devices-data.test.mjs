// Device rows are open DATA consumed by every device screen and by the public docs generator.
// One id must always mean one app: duplicate ids create duplicate UI/docs rows and make installed-state lookups lie.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync(new URL('../src/devices.json', import.meta.url), 'utf8'));

test('device and system ids are unique', () => {
  for (const [kind, records] of [['device', rows.devices], ['system', rows.systems]]) {
    const ids = records.map(row => row.id);
    assert.deepEqual(ids, [...new Set(ids)], `duplicate ${kind} id`);
  }
});
