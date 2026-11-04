// The one telemetry gate (read-data/telemetry-gate.mjs, DATA read-data/telemetry-privacy.json, moved from Trillion-X/trillion
// test/telemetry-privacy-gate.test.mjs): the privacy class of what was served decides, and a class that is not known sends nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TELEMETRY_PRIVACY, classOf, pageSends, sends } from '../read-data/telemetry-gate.mjs';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

test('the class comes from the longest route, a declared class can only make it more private, and unknown is closed', () => {
  assert.equal(classOf({ surface: 'app', path: '/lists/x' }), 'own-account');
  assert.equal(classOf({ surface: 'app', path: '/spaces/abc/thread' }), 'shared-with-others');
  assert.equal(classOf({ surface: 'app', path: '/spacesuit' }), 'own-account', 'a prefix matches whole path parts only');
  assert.equal(classOf({ surface: 'app', path: '/lists', declared: 'customer-scope' }), 'customer-scope');
  assert.equal(classOf({ surface: 'app', path: '/spaces/a', declared: 'public' }), 'shared-with-others', 'a header never makes a page less private');
  assert.equal(classOf({ surface: 'app', path: '/', declared: 'made-up' }), TELEMETRY_PRIVACY.unknown_class, 'a class that is not a row is unknown');
  assert.equal(classOf({ surface: 'a-new-surface', path: '/' }), TELEMETRY_PRIVACY.unknown_class, 'a surface no route names is unknown');
  for (const sink of TELEMETRY_PRIVACY.sinks) assert.equal(sends(TELEMETRY_PRIVACY.unknown_class, sink.id), false, `unknown feeds no ${sink.id}`);
  assert.equal(pageSends({ surface: 'app', path: '/spaces/a', headers: new Headers() }, 'client_health'), true);
  assert.equal(pageSends({ surface: 'app', path: '/spaces/a', headers: new Headers() }, 'page_events'), false);
});

// The row: the same gate as a container row, no records door.

test('the row answers the class, the sinks it may feed and, for a named sink, may_send; unknown is closed', async () => {
  const row = rowOf(rows, 'tool:gate-telemetry-by-privacy');
  assert.equal(row.invoke.records, undefined, 'no records door');
  const space = await runRow(row, { surface: 'app', path: '/spaces/team-plans', sink: 'page_events' });
  assert.equal(space.status, 0);
  assert.deepEqual(space.result, { class: 'shared-with-others', sinks: ['page_script', 'client_health'], sink: 'page_events', may_send: false });
  const own = await runRow(row, { surface: 'app', path: '/lists', sink: 'page_events' });
  assert.equal(own.result.may_send, true);
  const declared = await runRow(row, { surface: 'app', path: '/lists', declared: 'customer-scope' });
  assert.deepEqual(declared.result, { class: 'customer-scope', sinks: [] });
  const unknown = await runRow(row, { surface: 'a-new-surface', path: '/', sink: 'client_health' });
  assert.deepEqual(unknown.result, { class: TELEMETRY_PRIVACY.unknown_class, sinks: [], sink: 'client_health', may_send: false });
  const made = await runRow(row, { surface: 'app', path: '/', sink: 'made-up' });
  assert.match(made.error, /made-up is not a telemetry sink/);
});
