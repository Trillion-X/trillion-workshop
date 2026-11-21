// tools/workspace-screens/test/no-owner-gate.test.mjs
//
// The no-owner gate (web/scripts/no-owner-gate.mjs): a screen the workspace build bundles reads only door addresses. The
// real tree must match the baseline exactly (a new address is refused, a gone one must be removed from the baseline), and
// the scanner must find what it is meant to find and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { noOwnerAddressesIn, assertNoOwnerGate, scanNoOwnerAddresses, folderOf } from '../web/scripts/no-owner-gate.mjs';

test('a door address is never a no-owner address; any other /work/api/ read is', () => {
  assert.deepEqual(noOwnerAddressesIn(`readJson('/work/api/door/tools:list?input=1')`), []);
  assert.deepEqual(noOwnerAddressesIn(`readJson('/work/api/records/find', {})`), [{ address: '/work/api/records/find', family: 'records' }]);
});

test('an address is cut at its query or a dynamic part, and a sentence\'s punctuation after it is not part of it', () => {
  assert.deepEqual(noOwnerAddressesIn('`/work/api/namespace/bytes/${encodeURIComponent(id)}`'), [{ address: '/work/api/namespace/bytes/', family: 'namespace' }]);
  assert.deepEqual(noOwnerAddressesIn("'/work/api/calendar?from=1&to=2'"), [{ address: '/work/api/calendar', family: 'calendar' }]);
  assert.deepEqual(noOwnerAddressesIn('// the list, `/work/api/notifications,`'), []);
  assert.deepEqual(noOwnerAddressesIn('"read /work/api/notifications."'), [{ address: '/work/api/notifications', family: 'notifications' }]);
});

test('a comment that names an address is documentation, not a read; the prefix alone is not an address', () => {
  assert.deepEqual(noOwnerAddressesIn('/* GET /work/api/mentions */ const x = 1;'), []);
  assert.deepEqual(noOwnerAddressesIn("const PREFIX = '/work/api/';"), []);
});

test('a dynamic address is named (dynamic), so a part only the page knows cannot hide a read', () => {
  assert.deepEqual(noOwnerAddressesIn('`/work/api/${name}`'), [{ address: '/work/api/(dynamic)', family: '(dynamic)' }]);
  assert.deepEqual(noOwnerAddressesIn('const PREFIX = \'/work/api/\''), []);
});

test('a file is grouped under its tool folder; shared parts under ui', () => {
  assert.equal(folderOf('/w/tools/calendar/web/x.tsx', '/w'), 'calendar');
  assert.equal(folderOf('/w/tools/ui/show/x.tsx', '/w'), 'ui');
  assert.equal(folderOf('/w/readme.md', '/w'), '(root)');
});

test('a new address fails the gate with the words to fix it; a gone one is only said', () => {
  const clean = { added: [], gone: [] };
  assert.doesNotThrow(() => assertNoOwnerGate(clean));
  assert.throws(() => assertNoOwnerGate({ added: ['tools/x/a.ts /work/api/records/find'], gone: [] }), /New \/work\/api\/ addresses[\s\S]*tools\/x\/a\.ts \/work\/api\/records\/find/);
  assert.doesNotThrow(() => assertNoOwnerGate({ added: [], gone: ['tools/x/b.ts /work/api/mentions'] }));
});

test('the real screens match the baseline: nothing new, nothing left in the baseline that is gone', () => {
  const scan = scanNoOwnerAddresses();
  assert.ok(scan.report.files_scanned > 0, 'the walk reached no files');
  assert.ok(scan.report.entries.includes('tools/workspace-screens/web/src/workspace/account-workspace.ts'));
  assert.deepEqual(scan.added, [], `new non-door addresses: ${scan.added.join(', ')}`);
});
