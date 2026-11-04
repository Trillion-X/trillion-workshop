// test/search-notice-searchable-writes.test.mjs
//
// src/search-feed.mjs searchesRecord: only a write of a record the words-in-records lanes read (src/search.json) wakes the
// search follower, so an account whose records are only settings, schedules and command bookkeeping has no follower.
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchesRecord } from '../../shared-code/src/search-feed.mjs';
import search from '../../shared-code/src/search.json' with { type: 'json' };

test('the record types the search index reads wake the follower; bookkeeping records do not', () => {
  const lanes = search.lanes.filter(lane => lane.match === 'words-in-records');
  for (const lane of lanes) assert.equal(searchesRecord(lane.rows_of?.record_type ?? lane.record_type), true, lane.id);
  const rows = lanes.find(lane => lane.rows_of)?.rows_of;
  assert.equal(searchesRecord(`${rows.row_type_prefix}anything`), true, 'a list row of any list');
  for (const type of ['setting', 'execution', 'resource-command-result', 'schedule-state', 'table-schema-change', 'agent-review-mark'])
    assert.equal(searchesRecord(type), false, type);
  assert.equal(searchesRecord(undefined), true, 'a record whose type is not said is taken as read');
});
