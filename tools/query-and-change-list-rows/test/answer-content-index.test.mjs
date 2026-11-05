// Ported from old trillion test/answer-content-index.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted
// by Trillion-X/trillion #243. The content is tools/shared-code/src/answer-tools.mjs over the list routes
// (tools/keep-lists-of-rows/lists.mjs) and the list tools here; test/answer-person-for-tests.mjs is the old person without
// search. The checks on what search answered from the sent content (the "Sent in" hit with its url, change date and words,
// the answer naming report_answer, and a removed item no longer cited) are left out: old src/search.mjs has no JavaScript
// home, and the engine's search (trillion-rust src/record_value/search.rs) names no lane per kind, so no running code
// answers that lane.
// Content sent in for answers (src/answer-tools.mjs over src/lists.mjs, read by src/search.mjs): an app makes a root,
// sends items keyed by (root, id), and search answers from them citing the item with its url and when it last changed;
// sending the same item again replaces its one row; removing by (root, id) takes it out of answers; content for a root
// nobody made is refused by the lists owner; removing a root removes its items first. Runs against the real record store,
// the real list routes, the real rule evaluator and the real search.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentRowId } from '../../shared-code/src/answer-tools.mjs';
import { person } from './answer-person-for-tests.mjs';

test('content sent into a root is kept by (root, id); sending it again replaces it; removing it takes it out', async () => {
  const { lists, tools, calls } = person();
  await tools.save_content_root({ root: 'helpdesk', title: 'Help desk articles' });
  const sent = await tools.index_content({ root: 'helpdesk', items: [
    { id: 'kb/42', title: 'Resetting a password', text: 'Open Settings, choose Security and press Reset password.', url: 'https://help.example/kb/42', updated_at: '2026-10-01T09:00:00Z' },
    { id: 'kb/43', title: 'Exporting invoices', text: 'Invoices export as CSV from Billing.', url: 'https://help.example/kb/43' },
  ] });
  assert.deepEqual(sent.kept.map(item => item.row_id), [contentRowId('helpdesk', 'kb/42'), contentRowId('helpdesk', 'kb/43')]);
  assert.match(sent.kept[0].row_id, /^c-[0-9a-f]{40}$/, 'the row id is the BLAKE3 of (root, id), so an id with a slash is kept');

  // Sending the same (root, id) again changes the one row it has.
  await tools.index_content({ root: 'helpdesk', items: [{ id: 'kb/42', title: 'Resetting a password', text: 'Passwords are now reset from Account, then Sign-in.', url: 'https://help.example/kb/42', updated_at: '2026-10-15T12:00:00Z' }] });
  assert.equal((await lists.read('indexed-content')).rows.length, 2, 'still two items');

  const listed = await tools.read_indexed_content({ root: 'helpdesk' });
  assert.deepEqual(listed.rows.map(row => row.values.item_id).sort(), ['kb/42', 'kb/43']);
  assert.deepEqual((await tools.read_indexed_content({})).rows.map(row => row.id), ['helpdesk']);

  const removed = await tools.remove_indexed_content({ root: 'helpdesk', ids: ['kb/42'] });
  assert.equal(removed.removed.length, 1);
  assert.ok(calls.includes('/lists/indexed-content/ensure'), 'the list is made through the lists owner');
});

test('content for a root nobody made is refused; removing a root removes its items, a page at a time', async () => {
  const { lists, tools, calls } = person();
  const none = await tools.read_indexed_content({ root: 'wiki' });
  assert.deepEqual([none.made, none.rows], [false, []], 'a list never made reads as made: false, and the read made nothing');
  assert.ok(!calls.some(path => path.endsWith('/ensure')), 'reading never makes a list');
  await tools.save_content_root({ root: 'wiki', title: 'Team wiki' });
  await assert.rejects(tools.index_content({ root: 'nowhere', items: [{ id: '1', title: 'Lost' }] }), error => error.status === 400 && /nowhere|link|target/i.test(JSON.stringify(error.refused ?? error.message)));
  await assert.rejects(tools.index_content({ root: 'wiki', items: [{ id: '', title: 'No id' }] }), /needs an id and a title/);
  await tools.index_content({ root: 'wiki', items: [{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }] });
  const gone = await tools.remove_content_root({ root: 'wiki' });
  assert.deepEqual([gone.removed_items, gone.complete, gone.removed.length], [2, true, 1]);
  assert.equal((await lists.read('indexed-content')).rows.length, 0);
  assert.equal((await lists.read('content-roots')).rows.length, 0);
});
