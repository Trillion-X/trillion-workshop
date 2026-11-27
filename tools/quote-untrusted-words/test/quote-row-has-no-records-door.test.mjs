// The quote row is a pure container row (its port: "as a pure container row with no records door"): the plain function runner
// runs it, and it packs no records door, so a folder that quotes text reaches no store.
import test from 'node:test';
import assert from 'node:assert/strict';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };

const row = rows.records.map(record => record.payload).find(payload => payload.id === 'tool:quote-untrusted-words');

test('the quote row runs the plain function runner and packs no records door', () => {
  assert.equal(row.invoke.run[1], '/opt/workflows/do-work/run-a-function.mjs');
  assert.equal(row.invoke.records, undefined, 'the row is handed no door');
  assert.ok(row.invoke.files.package_files.every(files => files.package !== 'records-door'), 'no records-door package is packed');
  assert.ok(row.invoke.files.package_files.some(files => files.package === 'workflows'), 'the runner package is packed');
});
