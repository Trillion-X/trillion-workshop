// Every row that runs an Arc read script declares that the run's input goes to the script on stdin. The scripts read their input
// from stdin and refuse an empty one, so a row without the fill answers every address as refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rows = JSON.parse(readFileSync(fileURLToPath(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url)), 'utf8'));
const READS_STDIN = ['tool:read-a-page-in-arc', 'tool:pull-a-page-in-arc'];

test('each Arc read row fills its stdin from the run input', () => {
  for (const id of READS_STDIN) {
    const record = rows.records.find(row => row.payload.id === id);
    assert.ok(record, `${id} is in what-this-tool-does-and-how-to-run-it.json`);
    assert.deepEqual(record.payload.invoke.stdin, { fill: { from: 'input' } }, `${id} passes its input on stdin`);
  }
});
