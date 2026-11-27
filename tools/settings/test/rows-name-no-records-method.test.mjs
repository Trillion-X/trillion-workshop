// tools/settings: the row that read a setting through the records door was deleted; its job is the keep-tool-settings recipe
// (tools/workflows/recipes/keep-tool-settings.json), which the person's AI runs against its own store. No row here names a
// records method any more.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('no row of tools/settings names a records method, and the values reader row stays', () => {
  const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  assert.doesNotMatch(JSON.stringify(rows), /records:(read|write|list|search)\b/);
  assert.deepEqual(rows.map(row => row.id), ['tool:read-a-tool-setting']);
});
