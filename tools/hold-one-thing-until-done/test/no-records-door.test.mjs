// The folder's rows reach no records door: no records operation, no records-door package or tool, and each row runs
// through this folder's own do-work/run-given.mjs. A match that is only a data name (a record id or type such as
// record:waiting-on-you) is not a door operation and is not matched here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILE = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8'));
const rows = FILE.records.map(record => record.payload);

test('no row names a records operation, the records door, or its runner', () => {
  const text = readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /"records:(read|write|list)"/);
  assert.doesNotMatch(text, /records-door|run-an-export/);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.ok(!row.uses_tools.includes('trillion-workshop/records-door'), `${row.id} uses the records door`);
    assert.equal(row.invoke.records, undefined, `${row.id} declares a records door`);
    assert.equal(row.invoke.run[1], '/opt/hold-one-thing-until-done/do-work/run-given.mjs', `${row.id} runs through its own runner`);
    assert.ok(row.invoke.files.package_files.every(file => file.package !== 'records-door'), `${row.id} ships the records door`);
  }
});

test('every stored kind names what is handed in and no operation', () => {
  const route = rows.find(row => row.id === 'tool:answer-the-needs-you-hold-route');
  assert.ok(route.stored.length > 0);
  for (const kind of route.stored) assert.equal(kind.operations, undefined, JSON.stringify(kind));
});
