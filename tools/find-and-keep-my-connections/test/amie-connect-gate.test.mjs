// Ported from old trillion test/amie-connect-gate.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The request list's edit is this tool's src/integration-requests.mjs (addRequest,
// changeRequest), moved here byte for byte; only the import changed. Left out, no running owner: the plan-gated
// Connections service cards and 'a service already connected keeps its accounts' (old src/account-screens.mjs
// connectionsFacts) and 'Connections reads the current account plan through its policy owner' (old src/screen-reads.mjs
// readConnections over ACCOUNT_CONTROL). Searched connectionsFacts, readConnections, 'Needs a paid plan',
// accountCurrentAccess and account-screens across trillion-workshop tools, trillion-rust src and trillion-apps web/src:
// only from-old-trillion copies, and trillion-apps tests that still import a web/src/account-screens.mjs that is not there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addRequest, changeRequest } from '../src/integration-requests.mjs';

test('a request keeps its service and takes a changed or removed note', () => {
  const made = addRequest([], { name: 'Linear', note: 'tasks' }, new Date('2026-10-21T10:00:00Z'));
  const changed = changeRequest(made.rows, made.request.id, { note: '  issues   to tasks ' });
  assert.deepEqual(changed.request, { ...made.request, note: 'issues to tasks' });
  assert.equal(changeRequest(changed.rows, made.request.id, { note: '   ' }).request.note, undefined, 'an empty note takes it off');
  assert.equal(changeRequest(made.rows, 'nope', { note: 'x' }).request, null);
  assert.equal(changeRequest(made.rows, made.request.id, { note: 'x'.repeat(900) }).request.note.length, 300);
});
