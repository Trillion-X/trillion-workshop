// The check row is a pure container row: the plain function runner runs check-given-pages' export, and the row packs no
// records door, so the check reaches no store. (The records door stands between a tool and its data.)
import test from 'node:test';
import assert from 'node:assert/strict';
import rows from '../tool-rows.json' with { type: 'json' };

const row = rows.records.map(record => record.payload).find(payload => payload.id === 'tool:check-given-pages-at-every-width');

test('the check row names a run limit above the longest real check', () => {
  assert.equal(row.invoke.max_run_ms, 900000);
});

test('the check row runs the plain function runner on check-given-pages and packs no records door', () => {
  assert.equal(row.invoke.argv[1], '/opt/workflows/do-work/run-a-function.mjs');
  assert.equal(row.invoke.argv[2], '/opt/check-every-screen-at-every-width/check-given-pages.mjs');
  assert.equal(row.invoke.argv[3], 'checkGivenPages');
  assert.ok(row.invoke.files.package_files.every(files => files.package !== 'records-door'), 'no records-door package is packed');
  assert.ok(row.invoke.files.package_files.some(files => files.package === 'workflows'), 'the runner package is packed');
});
